import type {
  CheckFailureType,
  EndpointClass,
  IncidentStatus,
  IncidentType,
  Severity,
} from './enums.js';

export interface Incident {
  id: string;
  apiId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  severity: Severity;
  endpointClassSnapshot: EndpointClass;
  isMoneyMovingSnapshot: boolean;
  status: IncidentStatus;
  startedAt: Date;
  detectedByCheckId: string | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  durationSeconds: number | null;
  failureCount: number;
  failureType: CheckFailureType | null;
  escalationLevelReached: number;
  rootCause: string | null;
  resolution: string | null;
  createdAt: Date;
  updatedAt: Date;
}
