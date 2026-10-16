import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadReport, openHtmlReport, type ReportFormat, type ReportMeta } from '@/lib/loadtest';

const FORMATS: { f: ReportFormat; label: string }[] = [
  { f: 'pdf', label: 'PDF' },
  { f: 'xlsx', label: 'Excel' },
  { f: 'csv', label: 'CSV' },
  { f: 'json', label: 'JSON' },
];

/** Open the printable report, or download it in any format. Every format comes from the same data. */
export function ReportActions({ kind, id }: { kind: ReportMeta['kind']; id: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<void>): Promise<void> {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" disabled={busy !== null} onClick={() => void run('html', () => openHtmlReport(kind, id))}>
        <ExternalLink /> {busy === 'html' ? 'Opening…' : 'Open printable report'}
      </Button>
      {FORMATS.map(({ f, label }) => (
        <Button key={f} size="sm" variant="outline" disabled={busy !== null} onClick={() => void run(f, () => downloadReport(kind, id, f))}>
          <Download /> {busy === f ? '…' : label}
        </Button>
      ))}
      {error && <span className="text-xs text-[var(--color-down)]">{error}</span>}
    </div>
  );
}
