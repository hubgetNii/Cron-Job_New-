import { useJobRuns, useMissedRuns, useSummary } from '@/lib/queries';
import { StatTile } from '@/components/stat-tile';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

const RUN_COLOR: Record<string, string> = {
  SUCCESS: 'var(--color-up)',
  RUNNING: 'var(--color-series-1)',
  FAILED: 'var(--color-down)',
  DEAD_LETTERED: 'var(--color-down)',
  SKIPPED_LOCK_CONTENDED: 'var(--color-unknown)',
};

export function SchedulerPage() {
  const summary = useSummary();
  const runs = useJobRuns();
  const missed = useMissedRuns();
  const sched = summary.data?.scheduler;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Scheduler &amp; watchdog</h1>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile
          label="Health"
          value={sched?.health ?? '…'}
          accent={
            sched?.health === 'ok'
              ? 'var(--color-up)'
              : sched?.health === 'stale'
                ? 'var(--color-degraded)'
                : 'var(--color-down)'
          }
          hint={sched?.heartbeat ? `instance ${sched.heartbeat.instanceId}` : 'no heartbeat'}
        />
        <StatTile
          label="Last tick"
          value={
            sched?.heartbeat ? `${Math.round(sched.heartbeat.ageMs / 1000)}s ago` : '—'
          }
          hint={`grace ${sched ? Math.round(sched.graceMs / 1000) : '—'}s`}
        />
        <StatTile
          label="Active jobs"
          value={sched?.heartbeat?.activeJobCount ?? '—'}
          hint={`queue depth ${sched?.heartbeat?.queueDepth ?? 0}`}
        />
        <StatTile
          label="Missed runs"
          value={sched?.missedRunTotal ?? 0}
          accent={(sched?.missedRunTotal ?? 0) > 0 ? 'var(--color-degraded)' : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Recent job runs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Slot</TH>
                  <TH>Worker</TH>
                  <TH>Status</TH>
                  <TH>Attempt</TH>
                  <TH>Latency</TH>
                </TR>
              </THead>
              <TBody>
                {(runs.data ?? []).slice(0, 30).map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono text-xs">
                      {new Date(r.scheduledSlot).toLocaleTimeString()}
                    </TD>
                    <TD className="text-[var(--color-text-muted)]">{r.workerId ?? '—'}</TD>
                    <TD>
                      <Badge
                        style={{
                          color: RUN_COLOR[r.status] ?? 'var(--color-text-muted)',
                          borderColor: 'var(--color-border)',
                        }}
                      >
                        {r.status}
                      </Badge>
                    </TD>
                    <TD className="tabular-nums">{r.attemptNumber}</TD>
                    <TD className="tabular-nums text-[var(--color-text-muted)]">
                      {r.startedAt && r.completedAt
                        ? `${new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()}ms`
                        : '—'}
                    </TD>
                  </TR>
                ))}
                {!runs.isLoading && (runs.data ?? []).length === 0 && (
                  <TR>
                    <TD colSpan={5} className="py-8 text-center text-[var(--color-text-faint)]">
                      No runs yet — start the scheduler process.
                    </TD>
                  </TR>
                )}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Missed runs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(missed.data ?? []).length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--color-text-faint)]">
                No missed runs. Every check fired.
              </p>
            ) : (
              (missed.data ?? []).map((m) => (
                <div
                  key={m.targetId}
                  className="rounded-md border border-[var(--color-border)]/60 p-2 text-sm"
                >
                  <p className="font-medium">{m.name}</p>
                  <p className="text-xs text-[var(--color-text-faint)]">
                    {m.missedRunCount} missed · last ran{' '}
                    {m.lastActualRunAt
                      ? new Date(m.lastActualRunAt).toLocaleTimeString()
                      : 'never'}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
