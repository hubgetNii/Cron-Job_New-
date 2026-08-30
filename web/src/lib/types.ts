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
