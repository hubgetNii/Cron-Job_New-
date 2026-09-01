import { useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { api, downloadWithAuth } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const TYPES: { type: string; label: string; blurb: string }[] = [
  { type: 'executive', label: 'Executive', blurb: 'Business summary — availability, incidents, MTTR, no technical noise.' },
  { type: 'system-health', label: 'System Health', blurb: 'Whole-platform snapshot: uptime, latency, failures, top problem services.' },
  { type: 'api-performance', label: 'API Performance', blurb: 'Per-service uptime, avg / P95 latency, throughput and error rate.' },
  { type: 'failure', label: 'Failure', blurb: 'Failures grouped by root-cause category and failure type.' },
  { type: 'incident', label: 'Incident', blurb: 'Incidents with severity, duration, MTTR and resolution.' },
  { type: 'dependency', label: 'Dependency', blurb: 'Incidents implicating a downstream dependency or database.' },
  { type: 'latency', label: 'Latency', blurb: 'Daily P50 / P90 / P95 / P99 per service.' },
  { type: 'security', label: 'Security / Auth', blurb: 'Auth failures, credential audits and trace reveals.' },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export function ReportsPage() {
  const [type, setType] = useState('executive');
  const [from, setFrom] = useState(isoDaysAgo(30));
  const [to, setTo] = useState(isoDaysAgo(0));
  const [result, setResult] = useState<unknown>(null);
  const [busy, setBusy] = useState<'run' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fromIso = new Date(`${from}T00:00:00Z`).toISOString();
  const toIso = new Date(`${to}T23:59:59Z`).toISOString();
  const active = TYPES.find((t) => t.type === type)!;

  async function run(): Promise<void> {
    setBusy('run');
    setError(null);
    try {
      setResult(await api.report(type, fromIso, toIso));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate report');
      setResult(null);
    } finally {
      setBusy(null);
    }
  }

  async function csv(): Promise<void> {
    setBusy('csv');
    try {
      await downloadWithAuth(
        `/reports/${type}?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&format=csv`,
        `${type}-report-${from}_${to}.csv`,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Reports</h1>

      <Card>
        <CardHeader>
          <CardTitle>Generate a report</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {TYPES.map((t) => (
              <button
                key={t.type}
                onClick={() => {
                  setType(t.type);
                  setResult(null);
                }}
                className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                  type === t.type
                    ? 'border-[var(--color-brand)] bg-[var(--color-surface-2)]'
                    : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'
                }`}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  <FileText className="size-3.5" />
                  {t.label}
                </div>
                <p className="mt-0.5 text-xs text-[var(--color-text-faint)]">{t.blurb}</p>
              </button>
            ))}
          </div>

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
            <Button disabled={busy != null} onClick={() => void run()}>
              {busy === 'run' ? 'Generating…' : `Generate ${active.label}`}
            </Button>
            <Button variant="outline" disabled={busy != null} onClick={() => void csv()}>
              <Download className="mr-1 size-4" />
              {busy === 'csv' ? 'Preparing…' : 'Download CSV'}
            </Button>
          </div>
          {error && <p className="text-sm text-[var(--color-down)]">{error}</p>}
        </CardContent>
      </Card>

      {busy === 'run' && <Skeleton className="h-64 w-full" />}

      {result != null && busy !== 'run' && (
        <Card>
          <CardHeader>
            <CardTitle>{active.label} report</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[520px] overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
