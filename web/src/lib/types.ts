export type RbacRole =
  | 'ADMIN'
  | 'OPERATOR'
  | 'DEVELOPER'
  | 'COMPLIANCE'
  | 'MANAGEMENT'
  | 'VIEWER';

export type HealthStatus = 'UP' | 'DOWN' | 'DEGRADED' | 'UNKNOWN';
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type IncidentStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
export type IncidentType = 'OUTAGE' | 'DEGRADATION' | 'FLAPPING';
export type AlertStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SUPPRESSED';

export interface DashboardSummary {
  targets: {
    total: number;
    active: number;
    moneyMoving: number;
    byStatus: Record<HealthStatus | 'PENDING', number>;
  };
  incidents: {
    open: number;
    acknowledged: number;
    resolved24h: number;
    bySeverity: Record<Severity, number>;
    flapping: number;
  };
  alerts: { pending: number; failed24h: number; suppressed24h: number };
  uptime24h: number | null;
  checks24h: number;
  scheduler: {
    health: 'ok' | 'stale' | 'not_running';
    heartbeat: {
      instanceId: string;
      lastTickAt: string;
      activeJobCount: number;
      queueDepth: number;
      ageMs: number;
    } | null;
    graceMs: number;
    missedRunTotal: number;
  };
}

export interface PerfBucket {
  bucket: string;
  avgMs: number | null;
  p95Ms: number | null;
  up: number;
  down: number;
  degraded: number;
}

export interface TargetStatusRow {
  id: string;
  name: string;
  endpointClass: string;
  environment: string;
  isMoneyMoving: boolean;
  isActive: boolean;
  status: HealthStatus | null;
  lastActualRunAt: string | null;
  lastResponseMs: number | null;
  uptime24h: number | null;
  openIncidentId: string | null;
}

export interface Incident {
  id: string;
  apiId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  severity: Severity;
  endpointClassSnapshot: string;
  isMoneyMovingSnapshot: boolean;
  status: IncidentStatus;
  startedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  resolvedAt: string | null;
  durationSeconds: number | null;
  failureCount: number;
  failureType: string | null;
  escalationLevelReached: number;
  rootCause: string | null;
  resolution: string | null;
}

export interface Alert {
  id: string;
  incidentId: string | null;
  apiId: string | null;
  alertType: string;
  channel: string;
  recipient: string;
  status: AlertStatus;
  escalationTier: number | null;
  sentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface HealthCheckRow {
  id: string;
  checkedAt: string;
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

export interface CronJobRun {
  id: string;
  targetId: string;
  scheduledSlot: string;
  jobRunId: string;
  workerId: string | null;
  status: string;
  attemptNumber: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MissedRun {
  targetId: string;
  name: string;
  lastActualRunAt: string | null;
  lastExpectedRunAt: string | null;
  missedRunCount: number;
}

export interface Target {
  id: string;
  name: string;
  description: string | null;
  environment: string;
  endpointClass: string;
  severityDefault: Severity;
  isMoneyMoving: boolean;
  url: string;
  method: string;
  authenticationType: string;
  hasCredentials: boolean;
  timeoutMs: number;
  frequencyCron: string;
  slaTargetPercent: number;
  tags: string[];
  isActive: boolean;
  allowPrivateNetwork: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SlaSummaryRow {
  apiId: string;
  targetName: string;
  endpointClass: string;
  isMoneyMoving: boolean;
  uptimePercent: number | null;
  slaTargetPercent: number;
  slaMet: boolean;
  downtimeSeconds: number;
  excludedSeconds: number;
  generatedAt: string;
}

export interface SlaReport {
  id: string;
  apiId: string;
  periodKind: 'rolling_30d' | 'calendar_month';
  periodStart: string;
  periodEnd: string;
  uptimePercent: number | null;
  downtimeSeconds: number;
  excludedSeconds: number;
  slaTargetPercent: number;
  slaMet: boolean;
  totalChecks: number;
  failedChecks: number;
  generatedAt: string;
}

export interface PublicStatus {
  overall: 'operational' | 'degraded' | 'major_outage';
  services: {
    name: string;
    endpointClass: string;
    status: HealthStatus | null;
    uptime90d: number | null;
  }[];
  generatedAt: string;
}

export type AiInsightKind =
  | 'failure_classification'
  | 'root_cause'
  | 'incident_summary'
  | 'latency_anomaly'
  | 'error_rate_anomaly';

export interface AiInsight {
  id: string;
  entityType: 'incident' | 'target';
  entityId: string;
  kind: AiInsightKind;
  assistive: true;
  confidence: number | null;
  model: string;
  content: unknown;
  createdAt: string;
}

export interface IncidentAnalysis {
  model: string;
  classification: {
    assistive: true;
    classification: string;
    confidence: number;
    reasoning: string;
  };
  rootCause: {
    assistive: true;
    hypotheses: { cause: string; confidence: number; evidence: string }[];
    recommendedNextStep: string;
    overallConfidence: number;
  };
  summary: { assistive: true; summary: string; impact: string };
}

export interface AnomalySignal {
  targetId: string;
  targetName: string;
  kind: 'latency' | 'error_rate';
  metric: string;
  baseline: number;
  observed: number;
  zScore: number | null;
  windowMinutes: number;
  note: string;
}

export interface TraceRow {
  id: string;
  checkId: string;
  apiId: string;
  targetName: string | null;
  jobRunId: string | null;
  requestId: string;
  correlationId: string;
  checkedAt: string;
  requestMethod: string;
  requestUrlMasked: string;
  requestHeadersMasked: Record<string, string>;
  requestBodyMasked: string | null;
  responseStatus: number | null;
  responseHeadersMasked: Record<string, string>;
  responseBodyMasked: string | null;
  responseBytes: number | null;
  responseContentType: string | null;
  responseTimeMs: number | null;
  attempts: number;
  healthStatus: HealthStatus;
  failureType: string | null;
  hasRaw: boolean;
}

export type SystemHealthLevel = 'HEALTHY' | 'DEGRADED' | 'CRITICAL';

export type ScoreBand = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'NO_DATA';

export interface HealthScore {
  apiId: string;
  targetName: string;
  score: number | null;
  band: ScoreBand;
  window: { hours: number; samples: number };
  subScores: {
    availability: number | null;
    latency: number | null;
    errorRate: number | null;
    dependencyHealth: number | null;
  };
  contributions: {
    key: 'availability' | 'latency' | 'errorRate' | 'dependencyHealth';
    sub: number | null;
    weight: number;
    points: number | null;
  }[];
  comparison: {
    latency: { currentP95: number | null; yesterdayP95: number | null; deltaPercent: number | null };
    errorRate: { recentPct: number | null; priorPct: number | null; note: string | null };
    recurrence: { count24h: number; note: string | null };
  };
}

export interface HealthCheckRun {
  id: string;
  hcId: string;
  windowStart: string;
  windowEnd: string;
  environment: string | null;
  servicesTested: number;
  healthy: number;
  degraded: number;
  failed: number;
  unknown: number;
  checksTotal: number;
  overallStatus: SystemHealthLevel;
  durationMs: number | null;
  createdAt: string;
}

export interface RunServiceRow {
  checkId: string;
  apiId: string;
  targetName: string;
  endpointClass: string;
  isMoneyMoving: boolean;
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
  checkedAt: string;
}

export interface HealthCheckRunDetail extends HealthCheckRun {
  services: RunServiceRow[];
}

export type LatencyAssessment = 'NORMAL' | 'ELEVATED' | 'HIGH' | 'CRITICAL' | 'NO_DATA';

export interface LatencyStats {
  apiId: string;
  targetName: string;
  endpointClass: string;
  window: { minutes: number; samples: number };
  current: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  baseline: { days: number; avgMs: number | null };
  deviationPercent: number | null;
  thresholds: {
    normalMs: number;
    degradedMs: number;
    criticalMs: number;
    source: 'custom' | 'default';
  };
  assessment: LatencyAssessment;
}

export interface RawTrace {
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
}

export interface TraceSearchParams {
  apiId?: string;
  healthStatus?: HealthStatus;
  httpStatus?: string;
  statusClass?: '2xx' | '3xx' | '4xx' | '5xx';
  failureType?: string;
  requestId?: string;
  correlationId?: string;
  q?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface TimelineEntry {
  at: string;
  kind: string;
  summary: string;
  detail: Record<string, unknown>;
  source: string;
}

export interface RcaRecommendation {
  finding: string;
  recommendation: string;
  priority: 'P1' | 'P2' | 'P3';
}

export interface RootCauseAnalysis {
  generatedAt: string;
  method: 'deterministic';
  category: string;
  subtype: string;
  summary: string;
  evidence: string[];
  probableCause: string;
  confidence: number;
  impact: string;
  recommendation: RcaRecommendation;
  occurrences24h: number;
  latency: { baselineMs: number; recentMs: number; ratio: number } | null;
  assistive: true;
}

export interface TestOutcome {
  status: HealthStatus;
  httpStatus: number | null;
  responseTimeMs: number | null;
  failureType: string | null;
  errorMessage: string | null;
  validation: { passed: boolean; results: { rule: string; passed: boolean; detail?: string }[] } | null;
  attempts: number;
  responseSample: string | null;
}
