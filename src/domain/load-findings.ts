import { pct, type SloCheck, type SloEvaluation } from './load-slo.js';

/**
 * Findings (Phase 27): every failed objective or assertion becomes a typed
 * finding with the same four parts a business reader and an engineer both need —
 * what it means for customers (impact), what was measured (cause), and what to
 * do about it (recommendation). Deterministic: the same inputs always produce
 * the same words, so reports are comparable across runs and auditable.
 */

export type FindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type FindingSource = 'performance' | 'correctness' | 'security';

export interface Finding {
  id: string;
  source: FindingSource;
  severity: FindingSeverity;
  title: string;
  /** What this means for customers / the business. */
  impact: string;
  /** What was actually observed. */
  cause: string;
  recommendation: string;
  /** SLO id or check id, for tracing. */
  reference: string;
  /** OWASP category, for security findings. */
  owasp?: string;
  /** True for warnings that do not change the verdict. */
  advisory: boolean;
}

const RANK: Record<FindingSeverity, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
export const worst = (a: FindingSeverity, b: FindingSeverity): FindingSeverity =>
  RANK[a] >= RANK[b] ? a : b;
export const severityRank = (s: FindingSeverity): number => RANK[s];

interface ControlInfo {
  severity: FindingSeverity;
  impact: string;
  recommendation: string;
}

/** What a failed control means in business terms, and the standard fix. */
export const CONTROL_INFO: Record<string, ControlInfo> = {
  idempotency: {
    severity: 'CRITICAL',
    impact: 'A retried or double-submitted payment could be charged or paid out twice.',
    recommendation:
      'Enforce Idempotency-Key replay and reference uniqueness on the server before any money moves; never apply a request twice.',
  },
  'ledger-integrity': {
    severity: 'CRITICAL',
    impact:
      'Money could be lost, created or spent twice, and balances would no longer be trustworthy.',
    recommendation:
      'Make balance checks and debits atomic (one transaction or row lock) and add a ledger invariant check.',
  },
  reconciliation: {
    severity: 'CRITICAL',
    impact: 'What customers see, what the ledger holds and what settles could disagree.',
    recommendation:
      'Reconcile wallet balances against the ledger continuously and alert on any drift.',
  },
  'race-conditions': {
    severity: 'CRITICAL',
    impact: 'Simultaneous requests could overspend a wallet.',
    recommendation:
      'Serialise debits per wallet (lock or compare-and-set) and test with concurrent bursts.',
  },
  authentication: {
    severity: 'CRITICAL',
    impact: 'An unauthorised party could act as a customer or obtain credentials.',
    recommendation:
      'Validate every token and client secret server-side, expire tokens, and return identical errors for unknown clients and wrong secrets.',
  },
  'session-management': {
    severity: 'HIGH',
    impact: 'A stolen or old token would keep working.',
    recommendation: 'Enforce token expiry and reject tampered tokens.',
  },
  'access-control': {
    severity: 'CRITICAL',
    impact: 'One customer could see or change another customer’s data.',
    recommendation:
      'Scope every object lookup to the caller’s account and answer “not yours” exactly like “does not exist”.',
  },
  'data-isolation': {
    severity: 'CRITICAL',
    impact: 'Customer data could leak between accounts.',
    recommendation: 'Add account scoping to every query and test with two accounts.',
  },
  'least-privilege': {
    severity: 'HIGH',
    impact: 'A read-only key could move money.',
    recommendation: 'Check the credential’s permission on every function, not just at login.',
  },
  'input-validation': {
    severity: 'MEDIUM',
    impact: 'Malformed or hostile input could create bad records or errors.',
    recommendation: 'Validate every field against a strict schema and refuse unknown fields.',
  },
  injection: {
    severity: 'HIGH',
    impact: 'Hostile text could be interpreted as code or crash the service.',
    recommendation:
      'Treat all input as data: parameterised queries, output encoding, no string-built commands.',
  },
  availability: {
    severity: 'HIGH',
    impact: 'A flood of requests or oversized input could take the service down for everyone.',
    recommendation:
      'Enforce request size, nesting and page-size limits and rate limits that answer 429 with Retry-After.',
  },
  'abuse-resilience': {
    severity: 'MEDIUM',
    impact: 'Automated abuse would not be slowed down.',
    recommendation: 'Add per-credential rate limiting and burst protection.',
  },
  'fraud-velocity': {
    severity: 'HIGH',
    impact: 'Rapid automated repetition of a money flow would not be capped.',
    recommendation: 'Enforce per-transaction and daily limits server-side and alert on velocity.',
  },
  ssrf: {
    severity: 'HIGH',
    impact: 'The service could be tricked into calling internal systems.',
    recommendation:
      'Allow only public https URLs and block loopback, link-local and private ranges and non-web schemes.',
  },
  'pci-data-protection': {
    severity: 'CRITICAL',
    impact: 'Card-like data could be exposed, which is a PCI DSS breach.',
    recommendation: 'Never return or log card numbers; tokenise and mask at the edge.',
  },
  'data-minimisation': {
    severity: 'HIGH',
    impact: 'Responses expose more than the client needs, including internal fields.',
    recommendation: 'Return an explicit allow-list of fields per endpoint.',
  },
  'information-disclosure': {
    severity: 'HIGH',
    impact: 'Errors reveal internals an attacker can use.',
    recommendation: 'Return generic errors; keep stack traces, paths and SQL in server logs only.',
  },
  'secure-configuration': {
    severity: 'MEDIUM',
    impact: 'Default or verbose settings widen the attack surface.',
    recommendation: 'Remove server banners, disable debug endpoints and tighten CORS.',
  },
  'transport-security': {
    severity: 'HIGH',
    impact: 'Traffic could be read or altered in transit.',
    recommendation: 'Require TLS 1.2+ with a valid certificate and HSTS.',
  },
  'attack-surface': {
    severity: 'MEDIUM',
    impact: 'Unused methods or paths give an attacker more to probe.',
    recommendation: 'Expose only documented methods and paths.',
  },
  'api-inventory': {
    severity: 'MEDIUM',
    impact: 'An old or undocumented API version may bypass today’s protections.',
    recommendation: 'Retire legacy versions and keep an inventory of everything that is served.',
  },
  'contract-integrity': {
    severity: 'MEDIUM',
    impact:
      'The vendor’s API no longer matches what we integrate against; payments could be mis-read.',
    recommendation:
      'Update the integration and contract tests, and agree change notice with the vendor.',
  },
  'data-integrity': {
    severity: 'HIGH',
    impact: 'Two views of the same payment disagree.',
    recommendation:
      'Serve list and detail from the same source of truth and add a consistency check.',
  },
  'webhook-authenticity': {
    severity: 'HIGH',
    impact: 'Forged, replayed or tampered payment notifications could be accepted.',
    recommendation:
      'Verify the signature over the raw body, reject stale timestamps, and de-duplicate by Webhook-Id.',
  },
  ordering: {
    severity: 'MEDIUM',
    impact: 'Out-of-order notifications could leave a payment in the wrong state.',
    recommendation:
      'Keep the highest-ranked status and fetch the current state instead of trusting arrival order.',
  },
  resilience: {
    severity: 'MEDIUM',
    impact: 'Timeouts and retries could produce duplicates or lost updates.',
    recommendation:
      'Retry only with the same Idempotency-Key and read back by reference after a timeout.',
  },
  'account-enumeration': {
    severity: 'MEDIUM',
    impact: 'An attacker could discover which client ids exist.',
    recommendation: 'Return identical responses for unknown clients and wrong secrets.',
  },
};

const FALLBACK: ControlInfo = {
  severity: 'MEDIUM',
  impact: 'A protection the programme expects did not hold.',
  recommendation: 'Review the failed assertions and fix the underlying behaviour.',
};

/* ── Performance ───────────────────────────────────────────────────────── */

const PERF: Record<
  string,
  { sev: (c: SloCheck) => FindingSeverity; title: string; impact: string; rec: string }
> = {
  p95: {
    sev: (c) => (c.status === 'FAIL' ? 'HIGH' : 'MEDIUM'),
    title: 'Response time is above target at peak load',
    impact: 'Customers would notice slow payments at the busiest times.',
    rec: 'Find the slowest step (provider call, database query, lock contention) from the slow-request samples; add timeouts, caching or capacity, then re-run the same plan.',
  },
  p99: {
    sev: (c) => (c.status === 'FAIL' ? 'MEDIUM' : 'LOW'),
    title: 'The slowest requests are too slow',
    impact: '1 in 100 customers waits far longer than the rest.',
    rec: 'Look for retries, cold paths and queueing behind slow dependencies; set per-call timeouts.',
  },
  'server-errors': {
    sev: (c) => (c.status === 'FAIL' ? 'CRITICAL' : 'HIGH'),
    title: 'The service fails requests under load',
    impact: 'Some customers’ payments would fail outright.',
    rec: 'Check service logs for 5xx during the test window: connection-pool exhaustion, upstream provider limits or unhandled errors. Clients must retry only with the same Idempotency-Key.',
  },
  'client-errors': {
    sev: () => 'HIGH',
    title: 'Valid requests are being refused',
    impact: 'Real customers would be blocked from paying.',
    rec: 'Compare the refusals (limits, permissions, validation) with the test data and the account’s configured limits.',
  },
  'rate-limited': {
    sev: (c) => (c.status === 'FAIL' ? 'HIGH' : 'MEDIUM'),
    title: 'The service throttles at this volume',
    impact: 'At this volume callers are told to slow down, capping throughput.',
    rec: 'Agree higher limits with iSmart or add client-side pacing and back-off that honours Retry-After.',
  },
  throughput: {
    sev: (c) => (c.status === 'FAIL' ? 'HIGH' : 'MEDIUM'),
    title: 'The planned volume was not delivered',
    impact: 'The service (or the test) could not sustain the intended number of payments.',
    rec: 'Check for rising latency or queueing as load ramps; confirm the load generator is not the limit.',
  },
  auth: {
    sev: () => 'MEDIUM',
    title: 'Tokens expired in the middle of the run',
    impact: 'Long-running clients would see unexpected authentication failures.',
    rec: 'Refresh the token before it expires (5-minute lifetime) instead of waiting for a 401.',
  },
  capacity: {
    sev: (c) => (c.status === 'FAIL' ? 'HIGH' : 'MEDIUM'),
    title: 'Sustained capacity is below the requirement',
    impact: 'The service may not cope with launch volume.',
    rec: 'Identify the bottleneck at the breaking point, fix it, and re-run BREAKPOINT to confirm the new ceiling.',
  },
  generator: {
    sev: () => 'INFO',
    title: 'The load generator could not keep up',
    impact: 'This run does not prove anything about the service.',
    rec: 'Re-run from a larger worker (more CPU) or reduce the target rate.',
  },
};

export function findingsFromSlo(evaluation: SloEvaluation, ctx: { targetRps: number }): Finding[] {
  const out: Finding[] = [];
  for (const c of evaluation.checks) {
    if (c.status !== 'FAIL' && c.status !== 'WARN') continue;
    const m = PERF[c.id];
    if (!m) continue;
    out.push({
      id: `perf.${c.id}`,
      source: 'performance',
      severity: m.sev(c),
      title: m.title,
      impact: m.impact,
      cause: `${c.name}: measured ${c.actual} against a target of ${c.target} (planned rate ${ctx.targetRps}/s).`,
      recommendation: m.rec,
      reference: c.id,
      advisory: c.status === 'WARN',
    });
  }
  return out;
}

/* ── Correctness & security suites ─────────────────────────────────────── */

export interface SuiteAssertionLike {
  name: string;
  pass: boolean;
  detail?: string | undefined;
  advisory?: boolean | undefined;
}
export interface SuiteResultLike {
  id: string;
  title: string;
  controls: string[];
  owasp?: string | undefined;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'SKIPPED';
  assertions: SuiteAssertionLike[];
  note?: string | undefined;
}

export function findingsFromSuite(
  results: SuiteResultLike[],
  source: 'correctness' | 'security',
): Finding[] {
  const out: Finding[] = [];
  for (const r of results) {
    if (r.status === 'SKIPPED') continue;
    const infos = r.controls.map((c) => CONTROL_INFO[c] ?? FALLBACK);
    const base = infos.reduce<FindingSeverity>((s, i) => worst(s, i.severity), 'LOW');
    const best = [...infos].sort((a, b) => RANK[b.severity] - RANK[a.severity]);

    if (r.status === 'ERROR') {
      out.push({
        id: `${source}.${r.id}`,
        source,
        severity: 'HIGH',
        title: `${r.title} — the check could not run`,
        impact: 'Whether this protection holds is unknown.',
        cause: r.note ?? 'The check raised an error.',
        recommendation:
          'Fix the test environment or credentials, then re-run; treat the area as unverified until then.',
        reference: r.id,
        ...(r.owasp ? { owasp: r.owasp } : {}),
        advisory: false,
      });
      continue;
    }

    const failed = r.assertions.filter((a) => !a.pass && !a.advisory);
    if (failed.length > 0) {
      out.push({
        id: `${source}.${r.id}`,
        source,
        severity: base,
        title: r.title,
        impact: best[0]?.impact ?? FALLBACK.impact,
        cause: failed.map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`).join('; '),
        recommendation: [...new Set(best.slice(0, 2).map((i) => i.recommendation))].join(' '),
        reference: r.id,
        ...(r.owasp ? { owasp: r.owasp } : {}),
        advisory: false,
      });
    }
    const warned = r.assertions.filter((a) => !a.pass && a.advisory);
    for (const [i, a] of warned.entries()) {
      out.push({
        id: `${source}.${r.id}.warn${i + 1}`,
        source,
        severity: 'LOW',
        title: `Hardening: ${a.name}`,
        impact: 'Not a defect today, but a recommended protection is missing or unconfirmed.',
        cause: a.detail ? `${a.name} (${a.detail})` : a.name,
        recommendation: best[0]?.recommendation ?? FALLBACK.recommendation,
        reference: r.id,
        ...(r.owasp ? { owasp: r.owasp } : {}),
        advisory: true,
      });
    }
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.id.localeCompare(b.id));
}

export const sortFindings = (f: Finding[]): Finding[] =>
  [...f].sort(
    (a, b) =>
      RANK[b.severity] - RANK[a.severity] ||
      Number(a.advisory) - Number(b.advisory) ||
      a.id.localeCompare(b.id),
  );

/** One-line business summary of a set of findings. */
export function describeFindings(f: Finding[]): string {
  const real = f.filter((x) => !x.advisory);
  if (real.length === 0)
    return f.length === 0
      ? 'No findings.'
      : `No defects; ${f.length} hardening suggestion${f.length > 1 ? 's' : ''}.`;
  const crit = real.filter((x) => x.severity === 'CRITICAL').length;
  const high = real.filter((x) => x.severity === 'HIGH').length;
  return `${real.length} finding${real.length > 1 ? 's' : ''}${crit ? `, ${crit} critical` : ''}${high ? `, ${high} high` : ''}.`;
}

export { pct };
