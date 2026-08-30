import { z } from 'zod/v4';
import { componentLogger } from '../../lib/logger.js';
import { NotFoundError } from '../../lib/errors.js';
import { CHECK_FAILURE_TYPES } from '../../domain/enums.js';
import { getIncident } from '../../repositories/incidents.repo.js';
import { listAlerts } from '../../repositories/alerts.repo.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import { getRecentHealthChecks } from '../../repositories/dashboard.repo.js';
import { listIncidents } from '../../repositories/incidents.repo.js';
import {
  saveInsight,
  latestInsightsFor,
  type AiInsight,
} from '../../repositories/ai-insights.repo.js';
import { getAiClient } from './client.js';

const log = componentLogger('ai-analysis');

/* --- output schemas ---------------------------------------------------- */

const classificationSchema = z.object({
  classification: z.enum(CHECK_FAILURE_TYPES),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(600),
});

const rootCauseSchema = z.object({
  hypotheses: z
    .array(
      z.object({
        cause: z.string().max(200),
        confidence: z.number().min(0).max(1),
        evidence: z.string().max(400),
      }),
    )
    .min(1)
    .max(4),
  recommendedNextStep: z.string().max(300),
  overallConfidence: z.number().min(0).max(1),
});

const summarySchema = z.object({
  summary: z.string().max(1200),
  impact: z.string().max(300),
});

const SYSTEM = `You are an assistive SRE analyst for a fintech monitoring platform. Your output is ADVISORY ONLY — it is never used to set a service's health status, close an incident, or change configuration; a human always decides. Be precise, cite the data you were given, never invent details, and always express calibrated confidence. For money-moving payment endpoints, be conservative and flag uncertainty rather than guessing.`;

/* --- context building ------------------------------------------------- */

async function incidentContext(incidentId: string): Promise<string> {
  const incident = await getIncident(incidentId);
  if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
  const target = await findTargetById(incident.apiId);
  const checks = await getRecentHealthChecks(incident.apiId, 40);
  const alerts = await listAlerts({ incidentId, limit: 20 });
  const priorIncidents = (await listIncidents({ apiId: incident.apiId, limit: 10 })).filter(
    (i) => i.id !== incidentId,
  );

  return JSON.stringify(
    {
      incident: {
        number: incident.incidentNumber,
        type: incident.incidentType,
        severity: incident.severity,
        isMoneyMoving: incident.isMoneyMovingSnapshot,
        status: incident.status,
        startedAt: incident.startedAt,
        durationSeconds: incident.durationSeconds,
        failureType: incident.failureType,
        failureCount: incident.failureCount,
        escalationLevelReached: incident.escalationLevelReached,
      },
      target: target
        ? {
            name: target.name,
            endpointClass: target.endpointClass,
            environment: target.environment,
            method: target.method,
            expectedResponse: target.expectedResponse,
            frequencyCron: target.frequencyCron,
          }
        : null,
      recentChecks: checks.map((c) => ({
        at: c.checkedAt,
        status: c.status,
        http: c.httpStatus,
        ms: c.responseTimeMs,
        errorType: c.errorType,
        error: c.errorMessage,
      })),
      alerts: alerts.map((a) => ({ type: a.alertType, tier: a.escalationTier, status: a.status })),
      priorIncidents: priorIncidents.map((i) => ({
        number: i.incidentNumber,
        type: i.incidentType,
        failureType: i.failureType,
        startedAt: i.startedAt,
        durationSeconds: i.durationSeconds,
      })),
    },
    null,
    2,
  );
}

/* --- public API ------------------------------------------------------- */

export interface IncidentAnalysis {
  classification: z.infer<typeof classificationSchema> & { assistive: true };
  rootCause: z.infer<typeof rootCauseSchema> & { assistive: true };
  summary: z.infer<typeof summarySchema> & { assistive: true };
  model: string;
}

/**
 * Runs failure classification, root-cause hypothesis generation and an incident
 * summary via the model, stores each as an advisory `ai_insight`, and returns
 * them labelled ASSISTIVE. Nothing here mutates the incident, its health
 * checks, or any alert.
 */
export async function analyzeIncident(incidentId: string): Promise<IncidentAnalysis> {
  const ai = getAiClient();
  const context = await incidentContext(incidentId);

  const [classification, rootCause, summary] = await Promise.all([
    ai.analyze(
      classificationSchema,
      SYSTEM,
      `Classify the underlying failure type for this incident from the enum. ` +
        `The deterministic monitor recorded a type already — say whether you agree and why.\n\n${context}`,
    ),
    ai.analyze(
      rootCauseSchema,
      SYSTEM,
      `Give 1-4 ranked root-cause hypotheses with evidence drawn only from this data, ` +
        `and one concrete next step for the on-call engineer.\n\n${context}`,
    ),
    ai.analyze(
      summarySchema,
      SYSTEM,
      `Write a short natural-language incident timeline suitable for a status page or ` +
        `an executive update, and a one-line impact statement.\n\n${context}`,
    ),
  ]);

  await Promise.all([
    saveInsight({
      entityType: 'incident',
      entityId: incidentId,
      kind: 'failure_classification',
      confidence: classification.confidence,
      model: ai.model,
      content: classification,
    }),
    saveInsight({
      entityType: 'incident',
      entityId: incidentId,
      kind: 'root_cause',
      confidence: rootCause.overallConfidence,
      model: ai.model,
      content: rootCause,
    }),
    saveInsight({
      entityType: 'incident',
      entityId: incidentId,
      kind: 'incident_summary',
      confidence: null,
      model: ai.model,
      content: summary,
    }),
  ]);

  log.info({ incidentId, model: ai.model }, 'incident AI analysis complete (advisory)');

  return {
    classification: { ...classification, assistive: true },
    rootCause: { ...rootCause, assistive: true },
    summary: { ...summary, assistive: true },
    model: ai.model,
  };
}

export function getIncidentInsights(incidentId: string): Promise<AiInsight[]> {
  return latestInsightsFor('incident', incidentId);
}
