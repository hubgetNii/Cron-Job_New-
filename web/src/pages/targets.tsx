import { useState } from 'react';
import { Play, Power, PowerOff } from 'lucide-react';
import { useTargetBoard, useTargetActions } from '@/lib/queries';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { HealthBadge } from '@/components/status-badge';
import type { TestOutcome } from '@/lib/types';

export function TargetsPage() {
  const { data, isLoading } = useTargetBoard();
  const { setEnabled, test } = useTargetActions();
  const [result, setResult] = useState<{ id: string; outcome: TestOutcome } | null>(null);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Monitored targets</h1>
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Status</TH>
              <TH>Name</TH>
              <TH>Class</TH>
              <TH>Env</TH>
              <TH className="text-right">Latency</TH>
              <TH className="text-right">Uptime 24h</TH>
              <TH>Last check</TH>
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {isLoading && (
              <TR>
                <TD colSpan={8} className="py-8 text-center text-[var(--color-text-faint)]">
                  Loading…
                </TD>
              </TR>
            )}
            {(data ?? []).map((t) => (
              <TR key={t.id}>
                <TD>
                  <HealthBadge status={t.status} />
                </TD>
                <TD>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    {t.isMoneyMoving && (
                      <Badge
                        style={{
                          color: 'var(--color-degraded)',
                          borderColor: 'color-mix(in oklab, var(--color-degraded) 45%, transparent)',
                        }}
                      >
                        money-moving
                      </Badge>
                    )}
                  </div>
                  {result?.id === t.id && (
                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                      test → <span className="font-medium">{result.outcome.status}</span>{' '}
                      (HTTP {result.outcome.httpStatus ?? 'n/a'},{' '}
                      {result.outcome.responseTimeMs ?? '—'}ms, {result.outcome.attempts} attempt
                      {result.outcome.attempts === 1 ? '' : 's'})
                      {result.outcome.errorMessage ? ` · ${result.outcome.errorMessage}` : ''}
                    </p>
                  )}
                </TD>
                <TD className="text-[var(--color-text-muted)]">{t.endpointClass}</TD>
                <TD className="text-[var(--color-text-muted)]">{t.environment}</TD>
                <TD className="text-right tabular-nums">
                  {t.lastResponseMs == null ? '—' : `${t.lastResponseMs} ms`}
                </TD>
                <TD className="text-right tabular-nums">
                  {t.uptime24h == null ? '—' : `${t.uptime24h}%`}
                </TD>
                <TD className="text-xs text-[var(--color-text-faint)]">
                  {t.lastActualRunAt ? new Date(t.lastActualRunAt).toLocaleTimeString() : '—'}
                </TD>
                <TD>
                  <div className="flex justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={test.isPending}
                      onClick={() =>
                        test.mutate(t.id, {
                          onSuccess: (outcome) => setResult({ id: t.id, outcome }),
                        })
                      }
                    >
                      <Play className="size-3" /> Test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={setEnabled.isPending}
                      onClick={() => setEnabled.mutate({ id: t.id, enabled: !t.isActive })}
                    >
                      {t.isActive ? <PowerOff className="size-3" /> : <Power className="size-3" />}
                      {t.isActive ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                </TD>
              </TR>
            ))}
            {!isLoading && (data ?? []).length === 0 && (
              <TR>
                <TD colSpan={8} className="py-10 text-center text-[var(--color-text-faint)]">
                  No targets. Register one with{' '}
                  <code className="rounded bg-[var(--color-surface-2)] px-1">
                    POST /api/v1/targets
                  </code>
                  .
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
