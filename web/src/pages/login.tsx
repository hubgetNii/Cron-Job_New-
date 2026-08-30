import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { CircleDot, LogIn } from 'lucide-react';
import { api } from '@/lib/api';
import { authStore } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (authStore.isAuthed()) return <Navigate to="/app" replace />;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(email, password);
      authStore.set({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: session.user,
      });
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <CircleDot className="size-5 text-[var(--color-brand)]" />
          <span className="font-semibold tracking-tight">FinTech Cron Monitor</span>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs font-medium text-[var(--color-text-muted)]">
            Email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          <label className="block text-xs font-medium text-[var(--color-text-muted)]">
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand)]"
            />
          </label>
          {error && <p className="text-xs text-[var(--color-down)]">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy}>
            <LogIn className="size-4" />
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
