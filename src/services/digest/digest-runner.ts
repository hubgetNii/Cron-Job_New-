import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { evaluateDigest } from './health-digest.service.js';

const log = componentLogger('digest-runner');

export interface DigestRunnerHandle {
  stop(): void;
  /** Runs one evaluation now (tests / on-demand). */
  runOnce(): Promise<void>;
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

/**
 * Periodic system-health digest. Every SMS_DIGEST_INTERVAL_MINUTES it snapshots
 * overall health and sends ONE SMS iff the overall level changed (Rule A).
 * Runs in the scheduler process alongside the cron engine.
 */
export function startDigestRunner(
  intervalMs = env().SMS_DIGEST_INTERVAL_MINUTES * 60_000,
): DigestRunnerHandle {
  void cycle();
  const timer = setInterval(() => void cycle(), intervalMs);
  timer.unref();
  return {
    stop: (): void => clearInterval(timer),
    runOnce: cycle,
  };
}
