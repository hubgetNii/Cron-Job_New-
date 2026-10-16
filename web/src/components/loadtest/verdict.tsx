import { CircleHelp, FlaskConical, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { FindingSeverity } from '@/lib/loadtest';

import { STATES } from '@/lib/verdict-states';

export function VerdictBadge({ value }: { value: string | null | undefined }) {
  const s = value ? STATES[value] : undefined;
  const cfg = s ?? { label: value ?? 'Running', color: GREY, Icon: CircleHelp };
  return (
    <Badge style={{ color: cfg.color, borderColor: `color-mix(in oklab, ${cfg.color} 45%, transparent)` }}>
      <cfg.Icon className="size-3" />
      {cfg.label}
    </Badge>
  );
}

const DOWN = 'var(--color-down)';
const WARN = 'var(--color-degraded)';
const GREY = 'var(--color-unknown)';

const SEV: Record<FindingSeverity, string> = {
  CRITICAL: DOWN,
  HIGH: DOWN,
  MEDIUM: WARN,
  LOW: GREY,
  INFO: GREY,
};

export function SeverityTag({ severity }: { severity: FindingSeverity }) {
  const c = SEV[severity];
  return (
    <Badge style={{ color: c, borderColor: `color-mix(in oklab, ${c} 45%, transparent)` }}>
      <ShieldCheck className="size-3" />
      {severity.charAt(0) + severity.slice(1).toLowerCase()}
    </Badge>
  );
}

/** Real service vs simulator — the single most important caveat on any report. */
export function EnvTag({ label, isReal }: { label: string; isReal: boolean }) {
  const c = isReal ? 'var(--color-brand)' : WARN;
  return (
    <Badge style={{ color: c, borderColor: `color-mix(in oklab, ${c} 45%, transparent)` }}>
      <FlaskConical className="size-3" />
      {label}
    </Badge>
  );
}

