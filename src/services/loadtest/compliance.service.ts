import { randomUUID } from 'node:crypto';
import { AppError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { appInfo } from '../../lib/version.js';
import { findTargetById } from '../../repositories/monitored-apis.repo.js';
import * as runs from '../../repositories/load-test-runs.repo.js';
import * as suites from '../../repositories/load-test-correctness.repo.js';
import * as repo from '../../repositories/compliance.repo.js';
import { CONTROL_BY_ID, CONTROLS, LIBRARY_VERSION } from '../../loadtest/compliance/controls.js';
import {
  assessControls,
  type Assessment,
  type LoadRunEvidence,
  type ReviewDecision,
  type ReviewRecord,
  type SuiteRunEvidence,
} from '../../loadtest/compliance/assess.js';
import {
  DISCLAIMER,
  matrixTables,
  renderMatrixCsv,
  renderMatrixHtml,
  renderMatrixXlsx,
  reviewRows,
  type MatrixMeta,
} from '../../loadtest/compliance/exporters.js';
import {
  assemblePack,
  sha256,
  verifyPack,
  type PackFile,
  type SourceRun,
  type VerifyResult,
} from '../../loadtest/compliance/pack.js';
import { recordAudit, type AuditActor } from '../audit/audit.service.js';
import { renderHtml } from './report/exporters.js';
import {
  evaluate,
  buildLoadRunReport,
  buildReadinessReport,
  buildSuiteReport,
} from './report/report.service.js';
import { environmentLabel } from './report/humanize.js';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const toSuiteEvidence = (r: suites.CorrectnessRun): SuiteRunEvidence => ({
  runId: r.id,
  suite: r.suite,
  finishedAt: r.finishedAt ?? r.queuedAt,
  environmentClass: r.effectiveClass,
  checks: (r.results ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    assertions: c.assertions.length,
    failed: c.assertions.filter((a) => !a.pass && !a.advisory).length,
  })),
});

export interface TargetAssessment {
  assessment: Assessment;
  reviews: (ReviewRecord & { id: string })[];
  meta: MatrixMeta & { targetId: string };
  suiteRuns: suites.CorrectnessRun[];
  loadRuns: runs.LoadRun[];
}

export async function assessTarget(
  apiId: string,
  now: Date = new Date(),
  maxAgeDays?: number,
): Promise<TargetAssessment> {
  const target = await findTargetById(apiId);
  if (!target) throw new NotFoundError('Target not found');
  const [corr, sec, loadRuns, reviews] = await Promise.all([
    suites.listCorrectnessRuns({ apiId, suite: 'correctness', limit: 10 }),
    suites.listCorrectnessRuns({ apiId, suite: 'security', limit: 10 }),
    runs.listRuns({ apiId, limit: 60 }),
    repo.listReviews(),
  ]);
  const suiteRuns = [...corr, ...sec].filter((r) => r.status === 'COMPLETED' && r.results);
  const finished = loadRuns.filter((r) => ['COMPLETED', 'ABORTED', 'FAILED'].includes(r.status));
  const load: LoadRunEvidence[] = finished.map((r) => {
    const { cfg, evaluation } = evaluate(r);
    return {
      runId: r.id,
      profile: cfg.profile,
      verdict: evaluation.verdict,
      finishedAt: r.finishedAt ?? r.queuedAt,
      environmentClass: r.effectiveClass,
    };
  });
  const assessment = assessControls({
    now,
    suites: suiteRuns.map(toSuiteEvidence),
    load,
    reviews,
    ...(maxAgeDays ? { maxAgeDays } : {}),
  });
  return {
    assessment,
    reviews,
    meta: {
      targetId: apiId,
      target: { name: target.name, host: hostOf(target.url) },
      generatedAt: now.toISOString(),
    },
    suiteRuns,
    loadRuns: finished,
  };
}

/** Records a reviewer's decision. Append-only; only the COMPLIANCE role reaches this (see routes). */
export async function reviewControl(
  controlId: string,
  decision: ReviewDecision,
  note: string,
  actor: AuditActor,
): Promise<ReviewRecord & { id: string }> {
  if (!CONTROL_BY_ID.has(controlId)) throw new NotFoundError('Unknown control');
  if (!actor.userId) throw new ForbiddenError('Reviews require an authenticated user.');
  if (note.trim().length < 10)
    throw new ValidationError('A review note of at least 10 characters is required.');
  const saved = await repo.insertReview({
    controlId,
    libraryVersion: LIBRARY_VERSION,
    decision,
    note: note.trim(),
    reviewerId: actor.userId,
    reviewerLabel: actor.label ?? `user:${actor.userId}`,
  });
  await recordAudit({
    actor,
    action: `compliance.review.${decision.toLowerCase()}`,
    entityType: 'compliance_control',
    summary: `${controlId} (${LIBRARY_VERSION}): ${decision}`,
  });
  return saved;
}

const csvEscape = (v: unknown): string => {
  const raw =
    v == null
      ? ''
      : typeof v === 'string'
        ? v
        : typeof v === 'object'
          ? JSON.stringify(v)
          : JSON.stringify(v);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Builds, stores and returns an evidence pack for one target: the matrix in four
 * formats, the control library, reviewer sign-offs, the underlying reports and the
 * per-call evidence log — all hashed in a manifest recorded append-only in the DB.
 */
export async function createEvidencePack(
  apiId: string,
  actor: AuditActor,
  now: Date = new Date(),
): Promise<repo.PackMeta> {
  const ctx = await assessTarget(apiId, now);
  const { assessment, reviews, meta } = ctx;
  const packId = randomUUID();
  const files: PackFile[] = [];
  const sourceRuns: SourceRun[] = [];

  files.push({
    path: 'assessment/compliance-matrix.html',
    data: renderMatrixHtml(assessment, meta, reviews),
  });
  files.push({
    path: 'assessment/compliance-matrix.xlsx',
    data: new Uint8Array(await renderMatrixXlsx(assessment, meta, reviews)),
  });
  files.push({ path: 'assessment/compliance-matrix.csv', data: renderMatrixCsv(assessment, meta) });
  files.push({
    path: 'assessment/compliance-matrix.json',
    data: JSON.stringify({ meta, assessment }, null, 2),
  });
  files.push({
    path: 'assessment/controls-library.json',
    data: JSON.stringify({ libraryVersion: LIBRARY_VERSION, controls: CONTROLS }, null, 2),
  });
  files.push({
    path: 'assessment/reviews.json',
    data: JSON.stringify(reviewRows(reviews), null, 2),
  });

  const add = (
    kind: string,
    id: string,
    finishedAt: string | null,
    env: { label: string; isReal: boolean },
  ): void => {
    sourceRuns.push({ kind, id, finishedAt, environment: env.label, isReal: env.isReal });
  };

  // TRACEABILITY: every run the matrix cites must be inside the pack, so an auditor can follow
  // any claim to its evidence. On top of those, include the latest valid REAL run per load
  // profile and per suite, so the pack also stands on its own.
  const cited = new Set(
    assessment.controls.flatMap((c) =>
      c.items.map((i) => i.runId).filter((id): id is string => !!id),
    ),
  );
  const newest = <T extends { finishedAt: string | null }>(xs: T[]): T[] =>
    [...xs].sort((x, y) => (y.finishedAt ?? '').localeCompare(x.finishedAt ?? ''));
  const isRealClass = (c: string | null): boolean =>
    c === 'SANDBOX' || c === 'STAGING' || c === 'PRODUCTION';

  const includeLoad = new Map<string, runs.LoadRun>();
  const latestRealLoad = new Set<string>();
  for (const r of newest(ctx.loadRuns)) {
    const { cfg, evaluation } = evaluate(r);
    if (cited.has(r.id)) includeLoad.set(r.id, r);
    if (
      evaluation.verdict !== 'INCONCLUSIVE' &&
      isRealClass(r.effectiveClass) &&
      !latestRealLoad.has(cfg.profile)
    ) {
      latestRealLoad.add(cfg.profile);
      includeLoad.set(r.id, r);
    }
  }
  for (const r of includeLoad.values()) {
    const { cfg } = evaluate(r);
    const report = await buildLoadRunReport(r.id, now);
    const base = `reports/load-${cfg.profile.toLowerCase()}-${r.id.slice(0, 8)}`;
    files.push({ path: `${base}.json`, data: JSON.stringify(report, null, 2) });
    files.push({ path: `${base}.html`, data: renderHtml(report) });
    add(`load/${cfg.profile}`, r.id, r.finishedAt, environmentLabel(r.effectiveClass));
  }

  const includeSuite = new Map<string, suites.CorrectnessRun>();
  for (const suite of ['correctness', 'security'] as const) {
    const mine = newest(ctx.suiteRuns.filter((r) => r.suite === suite));
    const latestReal = mine.find((r) => isRealClass(r.effectiveClass));
    if (latestReal) includeSuite.set(latestReal.id, latestReal);
    for (const r of mine) if (cited.has(r.id)) includeSuite.set(r.id, r);
    if (!latestReal && mine[0]) includeSuite.set(mine[0].id, mine[0]);
  }
  for (const run of includeSuite.values()) {
    const report = await buildSuiteReport(run.id, now);
    const base = `reports/${run.suite}-${run.id.slice(0, 8)}${isRealClass(run.effectiveClass) ? '' : '-simulator'}`;
    files.push({ path: `${base}.json`, data: JSON.stringify(report, null, 2) });
    files.push({ path: `${base}.html`, data: renderHtml(report) });
    const header = 'check,at,method,path,status,ms,requestId,idempotencyKey,reference,errorCode';
    const rows = report.evidence.map((e) =>
      [
        e.checkId,
        e.at,
        e.method,
        e.path,
        e.status,
        e.ms,
        e.requestId,
        e.idempotencyKey,
        e.reference,
        e.errorCode,
      ]
        .map(csvEscape)
        .join(','),
    );
    files.push({
      path: `evidence/${run.suite}-${run.id.slice(0, 8)}${isRealClass(run.effectiveClass) ? '' : '-simulator'}-calls.csv`,
      data: [header, ...rows].join('\n'),
    });
    add(run.suite, run.id, run.finishedAt, environmentLabel(run.effectiveClass));
  }

  const readiness = await buildReadinessReport(apiId, now);
  files.push({ path: 'reports/readiness.json', data: JSON.stringify(readiness, null, 2) });
  files.push({ path: 'reports/readiness.html', data: renderHtml(readiness) });

  const coverage = assessment.frameworks.map((f) => ({
    framework: f.name,
    total: f.total,
    byStatus: f.byStatus,
    reviewedApproved: f.reviewedApproved,
    unverifiedReferences: f.unverifiedReferences,
  }));
  const packed = assemblePack({
    packId,
    generatedAt: now,
    generatedBy: actor.label ?? 'system',
    toolVersion: appInfo().version,
    libraryVersion: LIBRARY_VERSION,
    target: { id: apiId, name: meta.target.name, host: meta.target.host },
    basis: assessment.basis,
    disclaimer: DISCLAIMER,
    sourceRuns,
    coverage,
    files,
  });
  const zip = Buffer.from(packed.zip);
  const stored = await repo.insertPack({
    id: packId,
    apiId,
    targetName: meta.target.name,
    libraryVersion: LIBRARY_VERSION,
    manifestSha256: packed.manifestSha256,
    zipSha256: packed.zipSha256,
    fileCount: packed.fileCount,
    basis: assessment.basis,
    summary: { coverage, sourceRuns: sourceRuns.length },
    zip,
    createdBy: actor.userId ?? null,
    createdByLabel: actor.label ?? 'system',
  });
  await recordAudit({
    actor,
    action: 'compliance.pack.created',
    entityType: 'compliance_pack',
    entityId: packId,
    summary: `Evidence pack for ${meta.target.name}: ${packed.fileCount} files, manifest ${packed.manifestSha256.slice(0, 16)}…, basis ${assessment.basis}`,
  });
  return stored;
}

export interface PackVerification extends Omit<VerifyResult, 'manifest'> {
  issued: {
    id: string;
    createdAt: string;
    createdByLabel: string;
    targetName: string;
    libraryVersion: string;
  } | null;
  /** The strongest statement we can make: intact AND recorded when it was issued. */
  verdict: 'AUTHENTIC' | 'INTACT_BUT_NOT_ISSUED_HERE' | 'TAMPERED' | 'INVALID';
}

export async function verifyUploadedPack(zip: Uint8Array): Promise<PackVerification> {
  const v = verifyPack(zip);
  const { manifest: _m, ...rest } = v;
  const issued = v.manifestSha256 ? await repo.findPackByManifest(v.manifestSha256) : null;
  const meta = issued
    ? {
        id: issued.id,
        createdAt: issued.createdAt,
        createdByLabel: issued.createdByLabel,
        targetName: issued.targetName,
        libraryVersion: issued.libraryVersion,
      }
    : null;
  const verdict: PackVerification['verdict'] =
    v.manifestSha256 === null
      ? 'INVALID'
      : !v.ok
        ? 'TAMPERED'
        : issued
          ? 'AUTHENTIC'
          : 'INTACT_BUT_NOT_ISSUED_HERE';
  return { ...rest, issued: meta, verdict };
}

export async function packDownload(id: string): Promise<{ meta: repo.PackMeta; zip: Buffer }> {
  const p = await repo.getPack(id);
  if (!p) throw new NotFoundError('Pack not found');
  const { zip, ...meta } = p;
  if (sha256(zip) !== meta.zipSha256) {
    // Defence in depth: the stored bytes must still match the recorded hash.
    throw new AppError('Stored pack no longer matches its recorded hash.', {
      statusCode: 500,
      code: 'PACK_INTEGRITY',
    });
  }
  return { meta, zip };
}

export { matrixTables };
