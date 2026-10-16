import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, FileArchive, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { authStore } from '@/lib/auth';
import { useReportIndex } from '@/lib/loadtest';
import {
  complianceApi,
  downloadMatrix,
  downloadPack,
  openMatrixHtml,
  usePacks,
  type ControlAssessment,
  type ControlStatus,
  type Framework,
  type PackVerification,
  type ReviewDecision,
  type ReviewStatus,
} from '@/lib/compliance';
import { cn } from '@/lib/utils';

const UP = 'var(--color-up)';
const WARN = 'var(--color-degraded)';
const DOWN = 'var(--color-down)';
const GREY = 'var(--color-unknown)';

const STATUS: Record<ControlStatus, { label: string; color: string }> = {
  EVIDENCED: { label: 'Evidenced', color: UP },
  EVIDENCED_STALE: { label: 'Evidenced (stale)', color: WARN },
  PARTIAL: { label: 'Partial', color: WARN },
  SIMULATOR_ONLY: { label: 'Simulator only', color: WARN },
  NOT_TESTED: { label: 'Not tested', color: GREY },
  FAILING: { label: 'Failing', color: DOWN },
  OUT_OF_SCOPE: { label: 'Needs other evidence', color: GREY },
};

const REVIEW: Record<ReviewStatus, { label: string; color: string }> = {
  DRAFT: { label: 'Draft', color: GREY },
  APPROVED: { label: 'Approved', color: UP },
  REJECTED: { label: 'Rejected', color: DOWN },
  NEEDS_CHANGE: { label: 'Changes requested', color: WARN },
  STALE_REVIEW: { label: 'Review out of date', color: WARN },
};

const tag = (label: string, color: string) => (
  <Badge style={{ color, borderColor: `color-mix(in oklab, ${color} 45%, transparent)` }}>{label}</Badge>
);

const OUTCOME_COLOR: Record<string, string> = { PASS: UP, FAIL: DOWN, STALE: WARN, SIM_ONLY: WARN, MISSING: GREY };

function ReviewForm({ control, onDone }: { control: ControlAssessment; onDone: () => void }) {
  const [decision, setDecision] = useState<ReviewDecision>('APPROVED');
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => complianceApi.review(control.control.id, decision, note), onSuccess: onDone });
  return (
    <div className="mt-2 space-y-2 rounded-md border border-[var(--color-border)] p-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        Your decision is recorded permanently against library version and cannot be edited. Confirm the mapping is right
        {control.control.refVerified ? '' : ' — and supply the exact regulator clause, because this reference is not yet verified'}.
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <select
          className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm"
          value={decision}
          onChange={(e) => setDecision(e.target.value as ReviewDecision)}
          aria-label="Decision"
        >
          <option value="APPROVED">Approve the mapping</option>
          <option value="NEEDS_CHANGE">Request changes</option>
          <option value="REJECTED">Reject the mapping</option>
        </select>
        <textarea
          className="min-h-9 min-w-64 flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-sm"
          placeholder="Reviewer note (at least 10 characters)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button size="sm" disabled={note.trim().length < 10 || m.isPending} onClick={() => m.mutate()}>
          {m.isPending ? 'Saving…' : 'Record decision'}
        </Button>
      </div>
      {m.error && <p className="text-xs text-[var(--color-down)]">{m.error instanceof Error ? m.error.message : 'Failed'}</p>}
    </div>
  );
}

function ControlRow({ c, canReview, onChanged }: { c: ControlAssessment; canReview: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const s = STATUS[c.status];
  return (
    <TR className="align-top">
      <TD className="whitespace-nowrap text-xs">
        <div className="font-medium">{c.control.ref}</div>
        {!c.control.refVerified && <div className="text-[11px] text-[var(--color-degraded)]">unverified reference</div>}
      </TD>
      <TD className="max-w-md">
        <div className="text-sm font-medium">{c.control.title}</div>
        <div className="text-xs text-[var(--color-text-faint)]">{c.control.intent}</div>
      </TD>
      <TD className="whitespace-nowrap">
        {tag(s.label, s.color)}
        {c.coverage === 'partial' && <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">partial scope</div>}
      </TD>
      <TD className="whitespace-nowrap">
        {tag(REVIEW[c.review.status].label, REVIEW[c.review.status].color)}
        {c.review.reviewer && <div className="mt-1 text-[11px] text-[var(--color-text-faint)]">{c.review.reviewer.replace('user:', '')}</div>}
      </TD>
      <TD className="max-w-lg text-sm">
        <p className="text-[var(--color-text-muted)]">{c.statement}</p>
        {c.items.length > 0 && (
          <button className="mt-1 text-xs underline" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'} {c.items.length} evidence item{c.items.length > 1 ? 's' : ''}
          </button>
        )}
        {open && (
          <ul className="mt-2 space-y-1 text-xs">
            {c.items.map((i, k) => (
              <li key={k} className="flex flex-wrap gap-1.5">
                <span style={{ color: OUTCOME_COLOR[i.outcome] }} className="font-medium">{i.outcome}</span>
                <span>{i.label}</span>
                {i.runId && i.runKind && (
                  <Link className="underline" to={`/app/load-tests/${i.runKind === 'load' ? 'run' : i.runKind}/${i.runId}`}>
                    run {i.runId.slice(0, 8)} · {i.environment ?? '?'} · {i.finishedAt?.slice(0, 10)}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-[var(--color-text-faint)]">
          <b>Limits:</b> {c.control.limitation}
          {c.control.howToCover && (
            <>
              {' '}
              <b>To cover:</b> {c.control.howToCover}
            </>
          )}
        </p>
        {canReview && (
          <>
            <button className="mt-1 text-xs underline" onClick={() => setReviewing(!reviewing)}>
              {reviewing ? 'Cancel review' : 'Review this mapping'}
            </button>
            {reviewing && <ReviewForm control={c} onDone={() => { setReviewing(false); onChanged(); }} />}
          </>
        )}
        {c.review.note && <p className="mt-1 text-xs italic text-[var(--color-text-faint)]">“{c.review.note}”</p>}
      </TD>
    </TR>
  );
}

function PacksCard({ apiId, canIssue }: { apiId: string | null; canIssue: boolean }) {
  const qc = useQueryClient();
  const { data: packs } = usePacks();
  const make = useMutation({ mutationFn: () => complianceApi.createPack(apiId!), onSuccess: () => void qc.invalidateQueries({ queryKey: ['cmp-packs'] }) });
  const [verdict, setVerdict] = useState<PackVerification | null>(null);
  const [vErr, setVErr] = useState<string | null>(null);

  async function check(f: File | undefined): Promise<void> {
    if (!f) return;
    setVErr(null);
    setVerdict(null);
    try {
      setVerdict(await complianceApi.verify(f));
    } catch (e) {
      setVErr(e instanceof Error ? e.message : 'Verification failed');
    }
  }
  const color: Record<PackVerification['verdict'], string> = { AUTHENTIC: UP, INTACT_BUT_NOT_ISSUED_HERE: WARN, TAMPERED: DOWN, INVALID: DOWN };
  const words: Record<PackVerification['verdict'], string> = {
    AUTHENTIC: 'Authentic — untouched, and this system recorded issuing it.',
    INTACT_BUT_NOT_ISSUED_HERE: 'Intact, but this system has no record of issuing it.',
    TAMPERED: 'Tampered — the contents do not match the manifest.',
    INVALID: 'Not a valid evidence pack.',
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2"><FileArchive className="size-4" /> Evidence packs</CardTitle>
        {canIssue && (
          <Button size="sm" disabled={!apiId || make.isPending} onClick={() => make.mutate()}>
            {make.isPending ? 'Building…' : 'Generate evidence pack for this service'}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-[var(--color-text-muted)]">
          A pack is a zip of the matrix, the reports it cites, the per-call evidence and the reviewer sign-offs — every file hashed in a manifest whose hash is recorded permanently when the pack is issued, so an auditor can prove nothing was changed afterwards.
        </p>
        {make.error && <p className="text-sm text-[var(--color-down)]">{make.error instanceof Error ? make.error.message : 'Failed'}</p>}
        <Table>
          <THead>
            <TR><TH>Issued</TH><TH>Service</TH><TH>Evidence</TH><TH>Files</TH><TH>Manifest SHA-256</TH><TH>By</TH><TH /></TR>
          </THead>
          <TBody>
            {(packs ?? []).map((p) => (
              <TR key={p.id}>
                <TD className="whitespace-nowrap text-xs">{new Date(p.createdAt).toLocaleString()}</TD>
                <TD className="text-sm">{p.targetName}</TD>
                <TD className="text-xs">{p.basis}</TD>
                <TD className="text-xs tabular-nums">{p.fileCount} · {(p.sizeBytes / 1024).toFixed(0)} KB</TD>
                <TD className="font-mono text-[11px]" title={p.manifestSha256}>{p.manifestSha256.slice(0, 20)}…</TD>
                <TD className="text-xs text-[var(--color-text-faint)]">{p.createdByLabel.replace('user:', '')}</TD>
                <TD><Button size="sm" variant="outline" onClick={() => void downloadPack(p)}><Download /> Zip</Button></TD>
              </TR>
            ))}
          </TBody>
        </Table>
        {packs?.length === 0 && <p className="text-sm text-[var(--color-text-faint)]">No packs issued yet.</p>}

        <div className="rounded-md border border-[var(--color-border)] p-3">
          <p className="mb-2 text-sm font-medium">Verify a pack someone handed you</p>
          <input type="file" accept=".zip,application/zip" onChange={(e) => void check(e.target.files?.[0])} aria-label="Evidence pack to verify" />
          {vErr && <p className="mt-2 text-sm text-[var(--color-down)]">{vErr}</p>}
          {verdict && (
            <div className="mt-2 space-y-1 text-sm">
              <p style={{ color: color[verdict.verdict] }} className="font-medium">{words[verdict.verdict]}</p>
              {verdict.issued && <p className="text-xs text-[var(--color-text-muted)]">Issued {new Date(verdict.issued.createdAt).toLocaleString()} by {verdict.issued.createdByLabel.replace('user:', '')} for {verdict.issued.targetName}.</p>}
              {verdict.problems.map((p) => <p key={p} className="text-xs text-[var(--color-down)]">✗ {p}</p>)}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function CompliancePage() {
  const qc = useQueryClient();
  const roles = authStore.user()?.roles ?? [];
  const canReview = roles.includes('COMPLIANCE');
  const canIssue = canReview || roles.includes('ADMIN');
  const { data: index } = useReportIndex();
  const targets = useMemo(() => [...new Map((index ?? []).map((r) => [r.targetId, r.targetName])).entries()], [index]);
  const [picked, setPicked] = useState<string | null>(null);
  const apiId = picked ?? targets[0]?.[0] ?? null;
  const [fw, setFw] = useState<Framework>('PCI_DSS_4_0_1');
  const q = useQuery({ queryKey: ['cmp-assessment', apiId], queryFn: () => complianceApi.assessment(apiId!), enabled: apiId != null });
  const a = q.data?.assessment;
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['cmp-assessment'] });
  const summary = a?.frameworks.find((f) => f.framework === fw);

  const basisText = {
    none: 'No test evidence yet.',
    simulator: 'Simulator evidence only — it shows the tests work, not that the real service complies.',
    mixed: 'Mixed evidence — only controls proven on the real environment count as “Evidenced”.',
    real: 'Evidence comes from the real environment.',
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Compliance evidence</h1>
        <p className="text-sm text-[var(--color-text-muted)]">What our tests can prove about PCI DSS, the OWASP API Top 10, Bank of Ghana expectations and data protection — and exactly what they cannot.</p>
      </div>
      <div className="flex items-start gap-2 rounded-md border border-[var(--color-degraded)]/50 bg-[var(--color-degraded)]/10 p-3 text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-degraded)]" />
        <p>
          <b>This is a mapping of evidence, not a certification.</b> Every mapping is a <b>draft</b> until a compliance reviewer approves it for the current library version, and Bank of Ghana and data-protection references are themes whose exact clauses the compliance owner must supply. Penetration testing, ASV scans and incident-response process need other evidence.
        </p>
      </div>

      {targets.length === 0 ? (
        <p className="text-sm text-[var(--color-text-faint)]">No test evidence yet. Run the correctness, security and load suites first.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 text-sm" value={apiId ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Service">
              {targets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
            {apiId && (
              <>
                <Button size="sm" onClick={() => void openMatrixHtml(apiId)}><ExternalLink /> Open printable matrix</Button>
                {(['pdf', 'xlsx', 'csv'] as const).map((f) => (
                  <Button key={f} size="sm" variant="outline" onClick={() => void downloadMatrix(apiId, f)}><Download /> {f === 'xlsx' ? 'Excel' : f.toUpperCase()}</Button>
                ))}
              </>
            )}
            {a && <span className="text-xs text-[var(--color-text-faint)]">library {a.libraryVersion} · evidence freshness {a.maxAgeDays} days</span>}
          </div>
          {a && <p className="text-sm text-[var(--color-text-muted)]">{basisText[a.basis]}</p>}
          {q.isLoading && <Skeleton className="h-64" />}
          {q.error && <p className="text-sm text-[var(--color-down)]">{q.error instanceof Error ? q.error.message : 'Failed to load'}</p>}

          {a && (
            <>
              <div className="flex flex-wrap gap-1 border-b border-[var(--color-border)]" role="tablist">
                {a.frameworks.map((f) => (
                  <button
                    key={f.framework}
                    role="tab"
                    aria-selected={fw === f.framework}
                    onClick={() => setFw(f.framework)}
                    className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-medium', fw === f.framework ? 'border-[var(--color-brand)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]')}
                  >
                    {f.name.replace(' — payment-system expectations', '')} <span className="text-xs text-[var(--color-text-faint)]">{f.total}</span>
                  </button>
                ))}
              </div>
              {summary && (
                <Card>
                  <CardContent className="space-y-2 p-4">
                    <p className="text-sm text-[var(--color-text-muted)]">{summary.note}</p>
                    <p className="flex flex-wrap gap-2">
                      {(Object.keys(STATUS) as ControlStatus[]).filter((k) => summary.byStatus[k] > 0).map((k) => <span key={k}>{tag(`${STATUS[k].label}: ${summary.byStatus[k]}`, STATUS[k].color)}</span>)}
                      {tag(`${summary.reviewedApproved}/${summary.total} reviewed`, summary.reviewedApproved === summary.total ? UP : GREY)}
                      {summary.unverifiedReferences > 0 && tag(`${summary.unverifiedReferences} unverified references`, WARN)}
                    </p>
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <THead>
                      <TR><TH>Reference</TH><TH>Control</TH><TH>Evidence</TH><TH>Review</TH><TH>What the evidence says</TH></TR>
                    </THead>
                    <TBody>
                      {a.controls.filter((c) => c.control.framework === fw).map((c) => <ControlRow key={c.control.id} c={c} canReview={canReview} onChanged={refresh} />)}
                    </TBody>
                  </Table>
                </CardContent>
              </Card>
            </>
          )}
          <PacksCard apiId={apiId} canIssue={canIssue} />
        </>
      )}
    </div>
  );
}
