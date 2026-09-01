import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useIncident, useIncidents, useIncidentActions } from '@/lib/queries';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { IncidentStatusBadge, SeverityBadge } from '@/components/status-badge';
import { IncidentAiPanel } from '@/components/incident-ai-panel';
import { IncidentRcaPanel } from '@/components/incident-rca-panel';

function fmtDuration(secs: number | null): string {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function IncidentsPage() {
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') ?? '';
  const openId = params.get('id');

  const list = useIncidents(filter ? `?status=${filter}` : '');
  const detail = useIncident(openId);
  const actions = useIncidentActions();
  const [resolution, setResolution] = useState('');

  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('id', id);
    else next.delete('id');
    setParams(next);
    setResolution('');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Incidents</h1>
        <div className="flex gap-1">
          {['', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED'].map((f) => (
            <Button
              key={f || 'all'}
              size="sm"
              variant={filter === f ? 'default' : 'ghost'}
              onClick={() => {
                const next = new URLSearchParams(params);
                if (f) next.set('status', f);
                else next.delete('status');
                setParams(next);
              }}
            >
              {f || 'All'}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Incident</TH>
              <TH>Severity</TH>
              <TH>Status</TH>
              <TH>Failure</TH>
              <TH className="text-right">Failures</TH>
              <TH className="text-right">Duration</TH>
              <TH>Started</TH>
            </TR>
          </THead>
          <TBody>
            {(list.data ?? []).map((inc) => (
              <TR
                key={inc.id}
                className="cursor-pointer"
                onClick={() => setOpen(inc.id)}
              >
                <TD className="font-mono text-xs">{inc.incidentNumber}</TD>
                <TD>
                  <SeverityBadge severity={inc.severity} />
                </TD>
                <TD>
                  <IncidentStatusBadge status={inc.status} type={inc.incidentType} />
                </TD>
                <TD className="text-[var(--color-text-muted)]">{inc.failureType ?? '—'}</TD>
                <TD className="text-right tabular-nums">{inc.failureCount}</TD>
                <TD className="text-right tabular-nums">{fmtDuration(inc.durationSeconds)}</TD>
                <TD className="text-xs text-[var(--color-text-faint)]">
                  {new Date(inc.startedAt).toLocaleString()}
                </TD>
              </TR>
            ))}
            {!list.isLoading && (list.data ?? []).length === 0 && (
              <TR>
                <TD colSpan={7} className="py-10 text-center text-[var(--color-text-faint)]">
                  No incidents{filter ? ` with status ${filter}` : ''}.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>

      <Sheet open={openId != null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent>
          {detail.data && (
            <>
              <SheetTitle>{detail.data.incidentNumber}</SheetTitle>
              <SheetDescription>
                {detail.data.endpointClassSnapshot}
                {detail.data.isMoneyMovingSnapshot ? ' · money-moving' : ''}
              </SheetDescription>

              <div className="flex flex-wrap gap-2">
                <SeverityBadge severity={detail.data.severity} />
                <IncidentStatusBadge status={detail.data.status} type={detail.data.incidentType} />
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Started</dt>
                  <dd>{new Date(detail.data.startedAt).toLocaleString()}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Duration</dt>
                  <dd>{fmtDuration(detail.data.durationSeconds)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Failure type</dt>
                  <dd>{detail.data.failureType ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Failure count</dt>
                  <dd className="tabular-nums">{detail.data.failureCount}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Escalation tier</dt>
                  <dd className="tabular-nums">{detail.data.escalationLevelReached}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-faint)]">Acknowledged</dt>
                  <dd>
                    {detail.data.acknowledgedAt
                      ? new Date(detail.data.acknowledgedAt).toLocaleTimeString()
                      : '—'}
                  </dd>
                </div>
              </dl>

              <IncidentRcaPanel incidentId={detail.data.id} />

              <IncidentAiPanel incidentId={detail.data.id} />

              {detail.data.resolution && (
                <div className="rounded-md border border-[var(--color-border)] p-3 text-sm">
                  <p className="mb-1 text-xs text-[var(--color-text-faint)]">Resolution</p>
                  {detail.data.resolution}
                </div>
              )}

              {detail.data.status !== 'RESOLVED' && (
                <div className="mt-auto space-y-3 border-t border-[var(--color-border)] pt-4">
                  {detail.data.status === 'OPEN' && (
                    <Button
                      variant="outline"
                      className="w-full"
                      disabled={actions.acknowledge.isPending}
                      onClick={() => actions.acknowledge.mutate(detail.data!.id)}
                    >
                      Acknowledge
                    </Button>
                  )}
                  <textarea
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    placeholder="Resolution note (required to resolve)…"
                    className="min-h-20 w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm outline-none focus:border-[var(--color-brand)]"
                  />
                  <Button
                    className="w-full"
                    disabled={!resolution.trim() || actions.resolve.isPending}
                    onClick={() =>
                      actions.resolve.mutate({ id: detail.data!.id, resolution })
                    }
                  >
                    Resolve incident
                  </Button>
                </div>
              )}
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
