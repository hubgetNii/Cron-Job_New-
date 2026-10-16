import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle, XCircle } from 'lucide-react';

export type StateCfg = { label: string; color: string; Icon: typeof CheckCircle2 };

const UP = 'var(--color-up)';
const WARN = 'var(--color-degraded)';
const DOWN = 'var(--color-down)';
const GREY = 'var(--color-unknown)';

/** One vocabulary for every verdict, gate and check state in the Load Tests area. */
export const STATES: Record<string, StateCfg> = {
  PASS: { label: 'Pass', color: UP, Icon: CheckCircle2 },
  PASS_WITH_WARNINGS: { label: 'Pass with warnings', color: WARN, Icon: AlertTriangle },
  FAIL: { label: 'Fail', color: DOWN, Icon: XCircle },
  ERROR: { label: 'Error', color: DOWN, Icon: XCircle },
  INCONCLUSIVE: { label: 'Inconclusive', color: GREY, Icon: CircleHelp },
  READY: { label: 'Ready', color: UP, Icon: CheckCircle2 },
  READY_WITH_WARNINGS: { label: 'Ready with warnings', color: WARN, Icon: AlertTriangle },
  NOT_READY: { label: 'Not ready', color: DOWN, Icon: XCircle },
  INCOMPLETE: { label: 'Incomplete', color: GREY, Icon: CircleHelp },
  WARN: { label: 'Warning', color: WARN, Icon: AlertTriangle },
  INFO: { label: 'Info', color: GREY, Icon: MinusCircle },
  MISSING: { label: 'Missing', color: GREY, Icon: CircleHelp },
  SKIPPED: { label: 'Not run', color: GREY, Icon: MinusCircle },
};

export const verdictColor = (v: string): string => STATES[v]?.color ?? GREY;
