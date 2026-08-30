import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { previousSlot, slotsBetween } from '../../lib/cron.js';
import type { MonitoredApi } from '../../domain/target.js';
import { listActiveTargets } from '../../repositories/monitored-apis.repo.js';
import {
  pruneHeartbeats,
  writeHeartbeat,
  bumpMissedRunCount,
  recordAlert,
} from '../../repositories/scheduler.repo.js';
import { pruneExpiredLocks } from './lock.service.js';
import { runScheduledCheck } from './job-runner.service.js';
import { detectMissedRuns } from './missed-run-detector.js';

const log = componentLogger('scheduler');

interface Entry {
  target: MonitoredApi;
  lastFiredSlot: Date | null;
}

export interface SchedulerOptions {
  instanceId?: string;
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxConcurrent?: number;
  now?: () => Date;
  loadTargets?: () => Promise<MonitoredApi[]>;
  run?: typeof runScheduledCheck;
}

/**
 * Single-node, database-driven scheduler (MVP — see vault: "MVP Single-Node
 * Scheduler"). A 1s tick compares each target's most recent wall-clock slot
 * against the last one it fired, so scheduling is anchored to `:00` boundaries
 * and never drifts. Slots skipped while the scheduler was down are detected and
 * alerted, not silently swallowed.
 *
 * Horizontal scaling (BullMQ + Redis) is the Phase 2+ path; the job runner
 * already carries the distributed-lock + idempotency guarantees that make it
 * safe to run more than one of these.
 */
export class Scheduler {
  private readonly instanceId: string;
  private readonly tickIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => Date;
  private readonly loadTargets: () => Promise<MonitoredApi[]>;
  private readonly run: typeof runScheduledCheck;

  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<string>();
  private tickTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private ticking = false;
  private started = false;

  constructor(opts: SchedulerOptions = {}) {
    this.instanceId = opts.instanceId ?? env().INSTANCE_ID;
    this.tickIntervalMs = opts.tickIntervalMs ?? 1000;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? env().SCHEDULER_HEARTBEAT_INTERVAL_MS;
    this.maxConcurrent = opts.maxConcurrent ?? env().MAX_GLOBAL_CONCURRENT_CHECKS;
    this.now = opts.now ?? ((): Date => new Date());
    this.loadTargets = opts.loadTargets ?? listActiveTargets;
    this.run = opts.run ?? runScheduledCheck;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.reload();
    await this.heartbeat();
    this.tickTimer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), this.heartbeatIntervalMs);
    log.info({ instanceId: this.instanceId, targets: this.entries.size }, 'scheduler started');
  }

  async stop(): Promise<void> {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.started = false;
    // Give in-flight checks a brief chance to finish.
    for (let i = 0; i < 50 && this.inFlight.size > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    log.info({ inFlight: this.inFlight.size }, 'scheduler stopped');
  }

  /** Reconciles the in-memory schedule with the active targets in the database. */
  async reload(): Promise<void> {
    const targets = await this.loadTargets();
    const seen = new Set<string>();
    const now = this.now();

    for (const target of targets) {
      seen.add(target.id);
      const existing = this.entries.get(target.id);
      if (existing) {
        existing.target = target;
      } else {
        // New target: anchor to the current slot so only future slots fire.
        this.entries.set(target.id, {
          target,
          lastFiredSlot: safePreviousSlot(target, now),
        });
      }
    }
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) this.entries.delete(id);
    }
  }

  /** Exposed for tests and for scheduler status endpoints. */
  activeJobCount(): number {
    return this.inFlight.size;
  }

  trackedTargetCount(): number {
    return this.entries.size;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    try {
      for (const entry of this.entries.values()) {
        const { target } = entry;
        const due = safePreviousSlot(target, now);
        if (!due) continue;
        if (entry.lastFiredSlot && due.getTime() <= entry.lastFiredSlot.getTime()) continue;

        if (entry.lastFiredSlot) {
          const skipped = slotsBetween(
            target.frequencyCron,
            entry.lastFiredSlot,
            new Date(due.getTime() - 1),
          );
          if (skipped.length > 0) {
            log.warn(
              { targetId: target.id, skipped: skipped.length, since: entry.lastFiredSlot },
              'scheduler skipped slots (was it down?)',
            );
            await bumpMissedRunCount(target.id, skipped.length);
            await recordAlert({
              alertType: 'SCHEDULER_HEARTBEAT_MISSED',
              channel: 'WEBHOOK',
              recipient: 'ops',
              apiId: target.id,
              errorMessage: `Scheduler skipped ${skipped.length} slot(s) for "${target.name}"`,
            });
          }
        }

        if (this.inFlight.has(target.id)) continue; // never overlap a target
        if (this.inFlight.size >= this.maxConcurrent) {
          log.warn({ max: this.maxConcurrent }, 'at global concurrency limit; deferring');
          continue; // do not advance lastFiredSlot — retry next tick
        }

        entry.lastFiredSlot = due;
        this.fire(target, due);
      }
    } finally {
      this.ticking = false;
    }
  }

  private fire(target: MonitoredApi, slot: Date): void {
    this.inFlight.add(target.id);
    void this.run(target, slot, { workerId: this.instanceId })
      .then((result) => {
        log.debug({ targetId: target.id, slot, result: result.kind }, 'scheduled check done');
      })
      .catch((err: unknown) => {
        log.error({ err, targetId: target.id, slot }, 'scheduled check threw');
      })
      .finally(() => {
        this.inFlight.delete(target.id);
      });
  }

  async heartbeat(): Promise<void> {
    try {
      await writeHeartbeat({
        instanceId: this.instanceId,
        activeJobCount: this.inFlight.size,
        queueDepth: 0,
      });
      await detectMissedRuns(
        [...this.entries.values()].map((e) => e.target),
        this.now(),
      );
      await pruneHeartbeats();
      await pruneExpiredLocks();
    } catch (err) {
      log.error({ err }, 'heartbeat cycle failed');
    }
  }
}

function safePreviousSlot(target: MonitoredApi, now: Date): Date | null {
  try {
    return previousSlot(target.frequencyCron, now);
  } catch (err) {
    log.error(
      { err, targetId: target.id, cron: target.frequencyCron },
      'invalid cron on active target',
    );
    return null;
  }
}
