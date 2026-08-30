import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PerfBucket } from '@/lib/types';

const SERIES = {
  p95: { key: 'p95Ms', label: 'p95 latency', color: 'var(--color-series-1)' },
  avg: { key: 'avgMs', label: 'avg latency', color: 'var(--color-series-3)' },
} as const;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-[var(--color-text-muted)]">{label ? fmtTime(label) : ''}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 tabular-nums">
          <span className="size-2 rounded-full" style={{ background: p.color }} />
          <span className="text-[var(--color-text-muted)]">{p.name}</span>
          <span className="ml-auto font-medium text-[var(--color-text)]">
            {p.value == null ? '—' : `${p.value} ms`}
          </span>
        </p>
      ))}
    </div>
  );
}

export function PerformanceChart({ data }: { data: PerfBucket[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-faint)]">
        No checks recorded in this window yet.
      </div>
    );
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <defs>
            <linearGradient id="p95Fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES.p95.color} stopOpacity={0.25} />
              <stop offset="100%" stopColor={SERIES.p95.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={fmtTime}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v: number) => `${v}ms`}
          />
          <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-border)' }} />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 11, color: 'var(--color-text-muted)' }}
          />
          <Area
            type="monotone"
            dataKey={SERIES.p95.key}
            name={SERIES.p95.label}
            stroke={SERIES.p95.color}
            strokeWidth={2}
            fill="url(#p95Fill)"
            connectNulls
            dot={false}
          />
          <Area
            type="monotone"
            dataKey={SERIES.avg.key}
            name={SERIES.avg.label}
            stroke={SERIES.avg.color}
            strokeWidth={2}
            fill="none"
            connectNulls
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
