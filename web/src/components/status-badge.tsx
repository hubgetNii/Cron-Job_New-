import {
  CheckCircle2,
  CircleHelp,
  AlertTriangle,
  XCircle,
  Activity,
  ShieldCheck,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { HealthStatus, IncidentStatus, IncidentType, Severity } from '@/lib/types';

const HEALTH: Record<
  HealthStatus | 'PENDING',
  { label: string; color: string; Icon: typeof CheckCircle2 }
> = {
  UP: { label: 'Up', color: 'var(--color-up)', Icon: CheckCircle2 },
  DEGRADED: { label: 'Degraded', color: 'var(--color-degraded)', Icon: AlertTriangle },
  DOWN: { label: 'Down', color: 'var(--color-down)', Icon: XCircle },
  UNKNOWN: { label: 'Unknown', color: 'var(--color-unknown)', Icon: CircleHelp },
  PENDING: { label: 'No data', color: 'var(--color-unknown)', Icon: Activity },
};

export function HealthBadge({ status }: { status: HealthStatus | 'PENDING' | null }) {
  const s = HEALTH[status ?? 'PENDING'];
  return (
    <Badge style={{ color: s.color, borderColor: `color-mix(in oklab, ${s.color} 45%, transparent)` }}>
      <s.Icon className="size-3" />
      {s.label}
    </Badge>
  );
}

const SEVERITY: Record<Severity, string> = {
  CRITICAL: 'var(--color-down)',
  HIGH: 'var(--color-degraded)',
  MEDIUM: 'var(--color-series-1)',
  LOW: 'var(--color-unknown)',
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  const color = SEVERITY[severity];
  return (
    <Badge style={{ color, borderColor: `color-mix(in oklab, ${color} 45%, transparent)` }}>
      <ShieldCheck className="size-3" />
      {severity}
    </Badge>
  );
}

const INCIDENT: Record<IncidentStatus, { label: string; color: string }> = {
  OPEN: { label: 'Open', color: 'var(--color-down)' },
  ACKNOWLEDGED: { label: 'Acknowledged', color: 'var(--color-degraded)' },
  RESOLVED: { label: 'Resolved', color: 'var(--color-up)' },
};

export function IncidentStatusBadge({
  status,
  type,
}: {
  status: IncidentStatus;
  type?: IncidentType;
}) {
  const s = INCIDENT[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge style={{ color: s.color, borderColor: `color-mix(in oklab, ${s.color} 45%, transparent)` }}>
        {s.label}
      </Badge>
      {type === 'FLAPPING' && (
        <Badge style={{ color: 'var(--color-degraded)', borderColor: 'color-mix(in oklab, var(--color-degraded) 45%, transparent)' }}>
          <Activity className="size-3" /> Flapping
        </Badge>
      )}
      {type === 'DEGRADATION' && <Badge className="text-[var(--color-text-faint)]">Degradation</Badge>}
    </span>
  );
}
