import { NavLink, Outlet } from 'react-router-dom';
import { Activity, LayoutDashboard, ListChecks, Radar, Siren, CircleDot } from 'lucide-react';
import { useSummary } from '@/lib/queries';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/app', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/app/targets', label: 'Targets', Icon: Radar },
  { to: '/app/incidents', label: 'Incidents', Icon: Siren },
  { to: '/app/scheduler', label: 'Scheduler', Icon: Activity },
  { to: '/app/alerts', label: 'Alerts', Icon: ListChecks },
];

export function AppShell() {
  const { data } = useSummary();
  const scheduler = data?.scheduler.health;

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col">
      <header className="flex items-center gap-4 border-b border-[var(--color-border)] px-6 py-3">
        <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <CircleDot className="size-5 text-[var(--color-brand)]" />
          <span>FinTech Cron Monitor</span>
        </NavLink>
        <nav className="ml-4 flex items-center gap-1">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-2)]',
                  isActive && 'bg-[var(--color-surface-2)] text-[var(--color-text)]',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-[var(--color-text-faint)]">scheduler</span>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium"
            style={{
              color:
                scheduler === 'ok'
                  ? 'var(--color-up)'
                  : scheduler === 'stale'
                    ? 'var(--color-degraded)'
                    : 'var(--color-down)',
              borderColor: 'var(--color-border)',
            }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{ background: 'currentColor' }}
            />
            {scheduler ?? '…'}
          </span>
        </div>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
