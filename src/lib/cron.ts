import { CronExpressionParser } from 'cron-parser';

/**
 * Cron-expression helpers for the scheduler.
 *
 * Standard 5-field (`m h dom mon dow`) and 6-field (`s m h dom mon dow`)
 * expressions are supported; cron-parser already anchors occurrences to
 * wall-clock field boundaries, which is exactly the drift-free behaviour the
 * spec requires (see vault: "Drift Correction and Missed-Run Detection").
 */

export class InvalidCronError extends Error {
  constructor(expression: string, cause: string) {
    super(`Invalid cron expression "${expression}": ${cause}`);
    this.name = 'InvalidCronError';
  }
}

export function assertValidCron(expression: string): void {
  try {
    CronExpressionParser.parse(expression);
  } catch (err) {
    throw new InvalidCronError(expression, err instanceof Error ? err.message : String(err));
  }
}

/** The next scheduled slot strictly after `from` (default: now). */
export function nextSlot(expression: string, from: Date = new Date()): Date {
  const it = CronExpressionParser.parse(expression, { currentDate: from });
  return it.next().toDate();
}

/** The most recent slot at or before `at`. */
export function previousSlot(expression: string, at: Date = new Date()): Date {
  const it = CronExpressionParser.parse(expression, { currentDate: at });
  return it.prev().toDate();
}

/**
 * Effective interval of an expression in seconds, derived from the gap between
 * two consecutive occurrences. For irregular expressions this is the gap after
 * `from`, which is a sound basis for the missed-run tolerance window.
 */
export function intervalSeconds(expression: string, from: Date = new Date()): number {
  const it = CronExpressionParser.parse(expression, { currentDate: from });
  const a = it.next().toDate().getTime();
  const b = it.next().toDate().getTime();
  return Math.round((b - a) / 1000);
}

/** All slots in the half-open range `(after, until]`, capped at `limit`. */
export function slotsBetween(expression: string, after: Date, until: Date, limit = 1000): Date[] {
  const it = CronExpressionParser.parse(expression, { currentDate: after });
  const slots: Date[] = [];
  while (slots.length < limit) {
    const next = it.next().toDate();
    if (next.getTime() > until.getTime()) break;
    slots.push(next);
  }
  return slots;
}
