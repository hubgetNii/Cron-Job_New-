import { useAlerts } from '@/lib/queries';
import { Card } from '@/components/ui/card';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { AlertStatus } from '@/lib/types';

const STATUS_COLOR: Record<AlertStatus, string> = {
  SENT: 'var(--color-up)',
  PENDING: 'var(--color-series-1)',
  FAILED: 'var(--color-down)',
  SUPPRESSED: 'var(--color-unknown)',
};

export function AlertsPage() {
  const { data, isLoading } = useAlerts('?limit=100');

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Alerts</h1>
      <Card>
        <Table>
          <THead>
            <TR>
              <TH>Type</TH>
              <TH>Channel</TH>
              <TH>Recipient</TH>
              <TH>Tier</TH>
              <TH>Status</TH>
              <TH>Detail</TH>
              <TH>Created</TH>
            </TR>
          </THead>
          <TBody>
            {(data ?? []).map((a) => (
              <TR key={a.id}>
                <TD className="font-medium">{a.alertType}</TD>
                <TD className="text-[var(--color-text-muted)]">{a.channel}</TD>
                <TD className="text-[var(--color-text-muted)]">{a.recipient}</TD>
                <TD className="tabular-nums">{a.escalationTier ?? '—'}</TD>
                <TD>
                  <Badge
                    style={{ color: STATUS_COLOR[a.status], borderColor: 'var(--color-border)' }}
                  >
                    {a.status}
                  </Badge>
                </TD>
                <TD className="max-w-[24ch] truncate text-xs text-[var(--color-text-faint)]">
                  {a.errorMessage ?? '—'}
                </TD>
                <TD className="text-xs text-[var(--color-text-faint)]">
                  {new Date(a.createdAt).toLocaleTimeString()}
                </TD>
              </TR>
            ))}
            {!isLoading && (data ?? []).length === 0 && (
              <TR>
                <TD colSpan={7} className="py-10 text-center text-[var(--color-text-faint)]">
                  No alerts yet.
                </TD>
              </TR>
            )}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
