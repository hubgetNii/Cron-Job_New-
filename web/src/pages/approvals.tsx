import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldQuestion } from 'lucide-react';
import { api } from '@/lib/api';
import { authStore } from '@/lib/auth';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const STATUS_COLOR: Record<string, string> = {
  PENDING: 'var(--color-degraded)',
  APPLIED: 'var(--color-up)',
  APPROVED: 'var(--color-up)',
  REJECTED: 'var(--color-unknown)',
  FAILED: 'var(--color-down)',
};

export function ApprovalsPage() {
  const qc = useQueryClient();
  const isAdmin = authStore.user()?.roles.includes('ADMIN') ?? false;
  const { data } = useQuery({
    queryKey: ['config-requests'],
    queryFn: () => api.configRequests(),
    refetchInterval: 10_000,
  });

  const review = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) =>
      api.reviewConfigRequest(id, decision),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config-requests'] });
      void qc.invalidateQueries({ queryKey: ['target-board'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-5 text-[var(--color-brand)]" />
        <h1 className="text-lg font-semibold">Four-eyes approvals</h1>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">
        Money-moving target changes are proposed by one person and applied only after a different
        ADMIN approves them.
      </p>

      <div className="space-y-3">
        {(data ?? []).map((r) => (
          <Card key={r.id} className="p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Badge style={{ color: STATUS_COLOR[r.status], borderColor: 'var(--color-border)' }}>
                    {r.status}
                  </Badge>
                  <span className="text-xs text-[var(--color-text-faint)]">{r.kind}</span>
                </div>
                <p className="mt-1 text-sm font-medium">{r.summary}</p>
                <p className="text-xs text-[var(--color-text-faint)]">
                  proposed by {r.proposedBy.slice(0, 8)} · {new Date(r.createdAt).toLocaleString()}
                  {r.reviewedBy ? ` · reviewed by ${r.reviewedBy.slice(0, 8)}` : ''}
                  {r.error ? ` · error: ${r.error}` : ''}
                </p>
              </div>
              {r.status === 'PENDING' && isAdmin && (
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ id: r.id, decision: 'approve' })}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ id: r.id, decision: 'reject' })}
                  >
                    Reject
                  </Button>
                </div>
              )}
            </div>
          </Card>
        ))}
        {(data ?? []).length === 0 && (
          <p className="py-10 text-center text-sm text-[var(--color-text-faint)]">
            No change requests.
          </p>
        )}
      </div>
    </div>
  );
}
