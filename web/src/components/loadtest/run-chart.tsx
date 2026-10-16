import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MetricRow } from '@/lib/loadtest';

const time = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Throughput (area, left axis) against P95 latency (line, right axis) for one run. */
export default function RunChart({ data }: { data: MetricRow[] }) {
  if (data.length < 2) {
    return <div className="flex h-56 items-center justify-center text-sm text-[var(--color-text-faint)]">Not enough data points for a chart.</div>;
  }
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="at" tickFormatter={time} stroke="var(--color-text-faint)" fontSize={11} minTickGap={32} />
          <YAxis yAxisId="rps" stroke="var(--color-text-faint)" fontSize={11} width={44} unit="/s" />
          <YAxis yAxisId="ms" orientation="right" stroke="var(--color-text-faint)" fontSize={11} width={52} unit="ms" />
          <Tooltip
            labelFormatter={(l) => time(String(l))}
            contentStyle={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area yAxisId="rps" type="monotone" dataKey="rps" name="Throughput" stroke="var(--color-series-1)" fill="var(--color-series-1)" fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
          <Line yAxisId="ms" type="monotone" dataKey="p95Ms" name="P95 latency" stroke="var(--color-series-2)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
