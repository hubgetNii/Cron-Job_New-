import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkDbHealth, closePool, query } from '../../lib/db.js';
import { openIncident } from '../../repositories/incidents.repo.js';
import { createAlert } from '../../repositories/alerts.repo.js';
import { insertHealthCheckResult } from '../../repositories/scheduler.repo.js';
import type { AiClient } from './client.js';
import { setAiClient } from './client.js';
import { analyzeIncident } from './analysis.service.js';

const dbUp = (await checkDbHealth()).ok;

/**
 * A fake model that always returns a schema-valid payload — the point of these
 * tests is that even a fully "successful" AI run touches nothing but `ai_insights`.
 */
const fakeAi: AiClient = {
  model: 'fake-model',
  analyze: (schema) =>
    Promise.resolve(
      schema.parse({
        classification: 'HTTP_5XX',
        confidence: 0.9,
        reasoning: 'the recent checks all returned 5xx',
        hypotheses: [{ cause: 'upstream outage', confidence: 0.7, evidence: 'consistent 503s' }],
        recommendedNextStep: 'page the payments on-call',
        overallConfidence: 0.6,
        summary: 'endpoint started failing at 10:00 and has been down since',
        impact: 'settlement status checks unavailable',
      }),
    ),
};

let apiId: string;

describe.skipIf(!dbUp)('AI guardrails (Phase 10)', () => {
  beforeAll(() => {
    setAiClient(fakeAi);
  });
  afterAll(async () => {
    setAiClient(undefined);
    await query(`DELETE FROM ai_insights`);
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
    await query(`DELETE FROM health_check_results`);
    await query(`DELETE FROM monitored_apis`);
    await closePool();
  });
  beforeEach(async () => {
    await query(`DELETE FROM ai_insights`);
    await query(`DELETE FROM alerts`);
    await query(`DELETE FROM incidents`);
    await query(`DELETE FROM health_check_results`);
    await query(`DELETE FROM monitored_apis`);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO monitored_apis (name, endpoint_class, severity_default, url, frequency_cron, is_money_moving, allow_private_network)
       VALUES ('ai-guard', 'payment_status', 'CRITICAL', 'https://203.0.113.70/x', '*/1 * * * *', true, true)
       RETURNING id`,
    );
    apiId = rows[0]!.id;
  });

  async function seedIncident(): Promise<string> {
    const checkId = await insertHealthCheckResult({
      apiId,
      jobRunId: `${apiId}:1`,
      outcome: {
        status: 'DOWN',
        httpStatus: 503,
        responseTimeMs: 40,
        failureType: 'HTTP_5XX',
        errorMessage: 'Service Unavailable',
        validation: null,
        attempts: 1,
        responseSample: null,
        trace: null,
        checkedAt: new Date(),
      },
    });
    const incident = await openIncident({
      apiId,
      incidentType: 'OUTAGE',
      severity: 'CRITICAL',
      endpointClassSnapshot: 'payment_status',
      isMoneyMovingSnapshot: true,
      detectedByCheckId: checkId,
      failureType: 'HTTP_5XX',
    });
    await createAlert({
      alertType: 'API_DOWN',
      channel: 'WEBHOOK',
      recipient: 'ops',
      incidentId: incident.id,
      apiId,
      status: 'SENT',
    });
    return incident.id;
  }

  it('analyzeIncident stores advisory insights and mutates nothing else', async () => {
    const incidentId = await seedIncident();

    const before = await snapshot(incidentId);
    const result = await analyzeIncident(incidentId);
    const after = await snapshot(incidentId);

    // Nothing outside ai_insights changed.
    expect(after.incident).toEqual(before.incident);
    expect(after.checks).toEqual(before.checks);
    expect(after.alerts).toEqual(before.alerts);

    // Insights are all flagged assistive, with the fake model recorded.
    const insights = await query<{
      assistive: boolean;
      model: string;
      kind: string;
      confidence: string | null;
    }>(`SELECT assistive, model, kind, confidence FROM ai_insights WHERE entity_id = $1`, [
      incidentId,
    ]);
    expect(insights.rows).toHaveLength(3);
    expect(insights.rows.every((r) => r.assistive === true)).toBe(true);
    expect(insights.rows.every((r) => r.model === 'fake-model')).toBe(true);
    const kinds = insights.rows.map((r) => r.kind).sort();
    expect(kinds).toEqual(['failure_classification', 'incident_summary', 'root_cause']);

    // The returned payload is labelled ASSISTIVE.
    expect(result.classification.assistive).toBe(true);
    expect(result.rootCause.assistive).toBe(true);
    expect(result.summary.assistive).toBe(true);
    expect(result.classification.confidence).toBeGreaterThan(0);
  });

  it('a money-moving incident stays OPEN after AI analysis (Rule 18 / AI guardrails)', async () => {
    const incidentId = await seedIncident();
    await analyzeIncident(incidentId);
    const { rows } = await query<{ status: string }>(`SELECT status FROM incidents WHERE id = $1`, [
      incidentId,
    ]);
    expect(rows[0]!.status).toBe('OPEN');
  });

  it('the ai_insights table rejects a non-assistive row', async () => {
    const incidentId = await seedIncident();
    await expect(
      query(
        `INSERT INTO ai_insights (entity_type, entity_id, kind, assistive, model, content)
         VALUES ('incident', $1, 'root_cause', false, 'x', '{}'::jsonb)`,
        [incidentId],
      ),
    ).rejects.toThrow();
  });
});

async function snapshot(incidentId: string): Promise<{
  incident: unknown;
  checks: unknown;
  alerts: unknown;
}> {
  const incident = await query(
    `SELECT status, severity, incident_type, failure_type, failure_count, root_cause, resolution,
            acknowledged_at, resolved_at, duration_seconds
     FROM incidents WHERE id = $1`,
    [incidentId],
  );
  const checks = await query(
    `SELECT id, status, http_status, error_type FROM health_check_results WHERE api_id = $1 ORDER BY id`,
    [apiId],
  );
  const alerts = await query(
    `SELECT id, alert_type, status FROM alerts WHERE api_id = $1 ORDER BY id`,
    [apiId],
  );
  return { incident: incident.rows, checks: checks.rows, alerts: alerts.rows };
}
