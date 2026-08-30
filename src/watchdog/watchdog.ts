import { request } from 'undici';
import { env } from '../config/index.js';
import { componentLogger } from '../lib/logger.js';
import { latestHeartbeat, recordAlert } from '../repositories/scheduler.repo.js';

const log = componentLogger('watchdog');

export interface WatchdogVerdict {
  healthy: boolean;
  reason: string;
  lastTickAgeMs: number | null;
}

/**
 * One watchdog evaluation: is the scheduler still ticking? A scheduler that has
 * died cannot report that it has died, so this runs in a separate process and
 * alerts through an independent path (see vault: "Watchdog and Dead Man's
 * Switch"). It shares nothing with the primary alert engine.
 */
export async function evaluateSchedulerLiveness(graceMs: number): Promise<WatchdogVerdict> {
  const hb = await latestHeartbeat();
  if (!hb) {
    return {
      healthy: false,
      reason: 'no scheduler heartbeat has ever been recorded',
      lastTickAgeMs: null,
    };
  }
  if (hb.ageMs > graceMs) {
    return {
      healthy: false,
      reason: `scheduler "${hb.instanceId}" last ticked ${Math.round(hb.ageMs / 1000)}s ago (grace ${Math.round(graceMs / 1000)}s)`,
      lastTickAgeMs: hb.ageMs,
    };
  }
  return { healthy: true, reason: 'scheduler is ticking', lastTickAgeMs: hb.ageMs };
}

/** Fires the CRITICAL alert through the independent path. */
export async function fireWatchdogAlert(verdict: WatchdogVerdict): Promise<void> {
  const payload = {
    alert_type: 'SCHEDULER_HEARTBEAT_MISSED',
    severity: 'CRITICAL',
    detected_at: new Date().toISOString(),
    reason: verdict.reason,
    last_tick_age_ms: verdict.lastTickAgeMs,
    message:
      'Primary scheduler appears to have stopped. Sent via the independent watchdog path, ' +
      'which does not depend on the primary alert engine.',
  };

  log.fatal(payload, 'SCHEDULER DOWN — firing watchdog alert');

  const endpoint = env().WATCHDOG_EXTERNAL_ENDPOINT;
  if (endpoint) {
    try {
      await request(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      log.error({ err, endpoint }, 'failed to deliver watchdog alert to external endpoint');
    }
  } else {
    log.warn('WATCHDOG_EXTERNAL_ENDPOINT is not configured — alert logged only');
  }

  // Best-effort audit trail (may not be delivered if the alert engine is the thing that is down).
  await recordAlert({
    alertType: 'SCHEDULER_HEARTBEAT_MISSED',
    channel: 'WEBHOOK',
    recipient: endpoint ?? 'log-only',
    errorMessage: verdict.reason,
  }).catch((err: unknown) => log.error({ err }, 'could not record watchdog alert row'));
}

export interface WatchdogLoop {
  stop(): void;
}

/** Starts the watchdog polling loop; returns a handle to stop it. */
export function startWatchdog(opts: { intervalMs?: number; graceMs?: number } = {}): WatchdogLoop {
  const intervalMs = opts.intervalMs ?? env().SCHEDULER_HEARTBEAT_INTERVAL_MS;
  const graceMs = opts.graceMs ?? env().SCHEDULER_HEARTBEAT_GRACE_MS;
  let alerting = false;
  let lastAlertAt = 0;

  const tick = async (): Promise<void> => {
    try {
      const verdict = await evaluateSchedulerLiveness(graceMs);
      if (verdict.healthy) {
        alerting = false;
        return;
      }
      // Re-alert at most once per grace window while it stays down.
      const now = Date.now();
      if (alerting && now - lastAlertAt < graceMs) return;
      alerting = true;
      lastAlertAt = now;
      await fireWatchdogAlert(verdict);
    } catch (err) {
      log.error({ err }, 'watchdog tick failed');
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: (): void => clearInterval(timer) };
}
