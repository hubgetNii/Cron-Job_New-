import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { fetchPublicStatus } from '@/lib/api';
import type { HealthStatus } from '@/lib/types';

const OVERALL = {
  operational: { label: 'All systems operational', color: 'var(--color-up)', Icon: CheckCircle2 },
  degraded: { label: 'Partial degradation', color: 'var(--color-degraded)', Icon: AlertTriangle },
  major_outage: { label: 'Major outage', color: 'var(--color-down)', Icon: XCircle },
} as const;

function StatusPill({ status }: { status: HealthStatus | null }) {
  const map: Record<string, { label: string; color: string }> = {
    UP: { label: 'Operational', color: 'var(--color-up)' },
    DEGRADED: { label: 'Degraded', color: 'var(--color-degraded)' },
    DOWN: { label: 'Down', color: 'var(--color-down)' },
    UNKNOWN: { label: 'Unknown', color: 'var(--color-text-faint)' },
  };
  const v = map[status ?? 'UNKNOWN'] ?? map.UNKNOWN!;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm" style={{ color: v.color }}>
      <span className="size-2 rounded-full" style={{ background: 'currentColor' }} />
      {v.label}
    </span>
  );
}

export function StatusPage() {
  const q = useQuery({
    queryKey: ['public-status'],
    queryFn: fetchPublicStatus,
    refetchInterval: 30_000,
  });

  const overall = q.data ? OVERALL[q.data.overall] : null;

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">iSmartPay — Service Status</h1>

      {q.isLoading && (
        <p className="mt-8 text-sm text-[var(--color-text-faint)]">Loading status…</p>
      )}
      {q.isError && (
        <p className="mt-8 text-sm text-[var(--color-down)]">Status is temporarily unavailable.</p>
      )}

      {q.data && overall && (
        <>
          <div
            className="mt-6 flex items-center gap-2 rounded-lg border p-4"
            style={{ borderColor: overall.color, color: overall.color }}
          >
            <overall.Icon className="size-5" />
            <span className="font-medium">{overall.label}</span>
          </div>

          <ul className="mt-8 divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
            {q.data.services.map((svc) => (
              <li key={svc.name} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium">{svc.name}</p>
                  <p className="text-xs text-[var(--color-text-faint)]">
                    {svc.endpointClass}
                    {svc.uptime90d != null && ` · ${svc.uptime90d.toFixed(2)}% uptime (90d)`}
                  </p>
                </div>
                <StatusPill status={svc.status} />
              </li>
            ))}
            {q.data.services.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-[var(--color-text-faint)]">
                No public services listed.
              </li>
            )}
          </ul>

          <p className="mt-6 text-xs text-[var(--color-text-faint)]">
            Updated {new Date(q.data.generatedAt).toLocaleString()}. Refreshes automatically.
          </p>
        </>
      )}
    </div>
  );
}
