import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Activity,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Radar,
  ShieldQuestion,
  Siren,
  CircleDot,
} from 'lucide-react';
import { useSummary } from '@/lib/queries';
import { api } from '@/lib/api';
import { authStore } from '@/lib/auth';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/app', label: 'Overview', Icon: LayoutDashboard, end: true },
  { to: '/app/targets', label: 'Targets', Icon: Radar },
  { to: '/app/incidents', label: 'Incidents', Icon: Siren },
  { to: '/app/scheduler', label: 'Scheduler', Icon: Activity },
  { to: '/app/alerts', label: 'Alerts', Icon: ListChecks },
  { to: '/app/approvals', label: 'Approvals', Icon: ShieldQuestion },
];

export function AppShell() {
  const navigate = useNavigate();
  const { data } = useSummary();
  const scheduler = data?.scheduler.health;
  const user = authStore.user();

  async function signOut(): Promise<void> {
    await api.logout();
    authStore.clear();
    navigate('/login', { replace: true });
  }

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
        <div className="ml-auto flex items-center gap-3 text-xs">
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
            title="scheduler health"
          >
            <span className="size-1.5 rounded-full" style={{ background: 'currentColor' }} />
            scheduler {scheduler ?? '…'}
          </span>
          {user && (
            <>
              <span className="text-[var(--color-text-faint)]" title={user.roles.join(', ')}>
                {user.email}
              </span>
              <button
                onClick={() => void signOut()}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)]"
              >
                <LogOut className="size-3.5" />
              </button>
            </>
          )}
        </div>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
