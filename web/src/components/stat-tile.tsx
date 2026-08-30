import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: string;
  icon?: ReactNode;
}

/** A bare stat tile — headline number, no plot (dataviz: this form skips the hover layer). */
export function StatTile({ label, value, hint, accent, icon }: StatTileProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--color-text-faint)]">
          {label}
        </p>
        {icon && <span className="text-[var(--color-text-faint)]">{icon}</span>}
      </div>
      <p
        className={cn('mt-2 text-2xl font-semibold tabular-nums text-[var(--color-text)]')}
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </Card>
  );
}
