import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BellRing, X } from 'lucide-react';
import { authStore } from '@/lib/auth';
import { runApi } from '@/lib/loadrun';

const SEEN_KEY = 'cronmon.approvalDismissed';

function dismissed(): string[] {
  try {
    return JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

/**
 * Pop-up for ADMINs when a test authorization is waiting for their decision.
 * It never lists requests the viewer proposed themselves (they cannot approve
 * those), and a dismissed request stays hidden for the rest of the session.
 */
export function ApprovalNotice() {
  const user = authStore.user();
  const isAdmin = user?.roles.includes('ADMIN') ?? false;
  const location = useLocation();
  const [hidden, setHidden] = useState<string[]>(dismissed);
  const { data = [] } = useQuery({
    queryKey: ['lt-auths'],
    queryFn: runApi.authorizations,
    enabled: isAdmin,
    refetchInterval: 15_000,
  });

  const mine = user?.id ?? '';
  const waiting = data.filter(
    (a) => a.status === 'PENDING' && a.proposedBy !== mine && !hidden.includes(a.id),
  );
  const onPage = location.pathname.startsWith('/app/load-tests/launch');
  if (!isAdmin || waiting.length === 0 || onPage) return null;

  const first = waiting[0]!;
  const dismiss = (): void => {
    const next = [...hidden, ...waiting.map((a) => a.id)];
    setHidden(next);
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* optional */
    }
  };

  return (
    <div
      role="alert"
      className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--color-degraded)] bg-[var(--color-surface-1)] p-4 shadow-lg"
    >
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 size-5 shrink-0 text-[var(--color-degraded)]" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-semibold">
            {waiting.length === 1
              ? 'A test is waiting for your approval'
              : `${waiting.length} tests are waiting for your approval`}
          </p>
          <p className="truncate text-sm">{first.reference}</p>
          <p className="text-xs text-[var(--color-text-muted)]">
            Up to {first.maxRps} requests/s, {first.maxVus} users,{' '}
            {Math.round(first.maxDurationSeconds / 60)} min
            {first.allowRealSideEffects ? ' · REAL side effects' : ''}. Nothing runs until you
            decide.
          </p>
          <Link
            to="/app/load-tests/launch#authorizations"
            className="mt-1 inline-block rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-[var(--color-brand-fg)] hover:opacity-90"
          >
            Review and decide
          </Link>
        </div>
        <button
          aria-label="Dismiss"
          className="text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
          onClick={dismiss}
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
