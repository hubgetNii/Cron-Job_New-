import { useState } from 'react';
import { CheckCircle2, XCircle, Download } from 'lucide-react';
import { useSlaSummary } from '@/lib/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { downloadWithAuth } from '@/lib/api';

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function SlaMet({ met }: { met: boolean }) {
  return met ? (
    <span className="inline-flex items-center gap-1 text-[var(--color-up)]">
      <CheckCircle2 className="size-4" /> Meeting
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[var(--color-down)]">
      <XCircle className="size-4" /> Breaching
    </span>
  );
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function SlaPage() {
  const summary = useSlaSummary();
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [busy, setBusy] = useState<'json' | 'csv' | null>(null);

  const s = summary.data;

  async function download(format: 'json' | 'csv'): Promise<void> {
    setBusy(format);
    try {
      const fromIso = new Date(`${from}T00:00:00Z`).toISOString();
      const toIso = new Date(`${to}T23:59:59Z`).toISOString();
      await downloadWithAuth(
        `/reports/compliance?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(
          toIso,
        )}&format=${format}`,
        `compliance-${from}_${to}.${format === 'csv' ? 'csv' : 'json'}`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">SLA &amp; compliance</h1>
        {s && (
          <span className="text-sm text-[var(--color-text-faint)]">
            {s.meeting} meeting · {s.breaching} breaching
          </span>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rolling 30-day uptime</CardTitle>
        </CardHeader>
        <CardContent>
          {summary.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (s?.targets ?? []).length === 0 ? (
            <p className="py-8 text-center text-sm text-[var(--color-text-faint)]">
              No SLA reports yet — the reporting job runs every 30 minutes.
            </p>
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Target</TH>
                  <TH>Class</TH>
                  <TH className="text-right">Uptime · 30d</TH>
                  <TH className="text-right">Target</TH>
                  <TH>SLA</TH>
                  <TH className="text-right">Downtime</TH>
                  <TH className="text-right">Excl. (maint.)</TH>
                </TR>
              </THead>
              <TBody>
                {(s?.targets ?? []).map((t) => (
                  <TR key={t.apiId}>
                    <TD className="font-medium">
                      {t.targetName}
                      {t.isMoneyMoving && (
                        <span className="ml-2 text-xs text-[var(--color-degraded)]">
                          money-moving
                        </span>
                      )}
                    </TD>
                    <TD className="text-[var(--color-text-muted)]">{t.endpointClass}</TD>
                    <TD className="text-right tabular-nums">
                      {t.uptimePercent == null ? '—' : `${t.uptimePercent.toFixed(3)}%`}
                    </TD>
                    <TD className="text-right tabular-nums text-[var(--color-text-faint)]">
                      {t.slaTargetPercent.toFixed(2)}%
                    </TD>
                    <TD>
                      <SlaMet met={t.slaMet} />
                    </TD>
                    <TD className="text-right tabular-nums">{fmtSeconds(t.downtimeSeconds)}</TD>
                    <TD className="text-right tabular-nums text-[var(--color-text-faint)]">
                      {fmtSeconds(t.excludedSeconds)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Compliance report export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-[var(--color-text-muted)]">
            Incidents, SLA outcomes, maintenance windows and an audit-action summary for a period.
            Requires the COMPLIANCE, MANAGEMENT or ADMIN role.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-[var(--color-text-faint)]">
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="mt-1 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
            </label>
            <label className="text-xs text-[var(--color-text-faint)]">
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-1 block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm"
              />
            </label>
            <Button variant="outline" disabled={busy != null} onClick={() => void download('json')}>
              <Download className="mr-1 size-4" />
              {busy === 'json' ? 'Preparing…' : 'JSON'}
            </Button>
            <Button variant="outline" disabled={busy != null} onClick={() => void download('csv')}>
              <Download className="mr-1 size-4" />
              {busy === 'csv' ? 'Preparing…' : 'Incidents CSV'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
