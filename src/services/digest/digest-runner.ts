import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { broadcastStatusSms, evaluateDigest } from './health-digest.service.js';

const log = componentLogger('digest-runner');

export interface DigestRunnerHandle {
  stop(): void;
  /** Runs one evaluation now (tests / on-demand). */
  runOnce(): Promise<void>;
  /** Runs one routine SMS status broadcast now. */
  broadcastOnce(): Promise<void>;
}

async function cycle(): Promise<void> {
  try {
    const digest = await evaluateDigest();
    log.info(
      {
        level: digest.overallLevel,
        previous: digest.previousLevel,
        smsSent: digest.smsSent,
        reason: digest.reason,
      },
      'health digest evaluated',
    );
  } catch (err: unknown) {
    log.error({ err }, 'health digest evaluation failed');
  }
}

async function broadcastCycle(): Promise<void> {
  try {
    const d = await broadcastStatusSms();
    log.info(
      { level: d.overallLevel, smsSent: d.smsSent, recipients: d.smsRecipients },
      'routine SMS status broadcast sent',
    );
  } catch (err: unknown) {
    log.error({ err }, 'routine SMS status broadcast failed');
  }
}

/**
 * Periodic system-health digest. Every SMS_DIGEST_INTERVAL_MINUTES it snapshots
 * overall health and sends ONE SMS iff the overall level changed (Rule A) plus
 * the every-run email. Separately, every SMS_STATUS_INTERVAL_MINUTES it sends the
 * full platform status to every SMS contact regardless of change. Runs in the
 * scheduler process alongside the cron engine.
 */
export function startDigestRunner(
  intervalMs = env().SMS_DIGEST_INTERVAL_MINUTES * 60_000,
  broadcastMs = env().SMS_STATUS_INTERVAL_MINUTES * 60_000,
): DigestRunnerHandle {
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();

  // No immediate fire — the broadcast is unconditional, so firing on every
  // process restart would spam. It starts one interval in.
  let broadcastTimer: ReturnType<typeof setInterval> | undefined;
  if (env().SMS_STATUS_BROADCAST_ENABLED) {
    broadcastTimer = setInterval(() => void broadcastCycle(), broadcastMs);
    broadcastTimer.unref();
  }

  return {
    stop: (): void => {
      clearInterval(timer);
      if (broadcastTimer) clearInterval(broadcastTimer);
    },
    runOnce: cycle,
    broadcastOnce: broadcastCycle,
  };
}
