import PDFDocument from 'pdfkit';
import { rowsToXlsx } from '../../lib/xlsx.js';
import { CSS, esc, htmlTable } from '../../services/loadtest/report/exporters.js';
import type { Assessment, ControlAssessment, ControlStatus, ReviewRecord } from './assess.js';
import { FRAMEWORKS, type Framework } from './controls.js';

/**
 * Compliance matrix exporters (Phase 28): HTML, XLSX, CSV, PDF — all rendered from
 * the same `Assessment`, so an auditor's workbook and the dashboard cannot differ.
 * Every dynamic value is escaped; CSV neutralises formula injection.
 */

export interface MatrixMeta {
  target: { name: string; host: string };
  generatedAt: string;
}

type Row = Record<string, unknown>;

const STATUS_LABEL: Record<ControlStatus, { label: string; cls: string }> = {
  EVIDENCED: { label: 'Evidenced', cls: 'ok' },
  EVIDENCED_STALE: { label: 'Evidenced (stale)', cls: 'warn' },
  PARTIAL: { label: 'Partial', cls: 'warn' },
  SIMULATOR_ONLY: { label: 'Simulator only', cls: 'warn' },
  NOT_TESTED: { label: 'Not tested', cls: 'neutral' },
  FAILING: { label: 'Failing', cls: 'bad' },
  OUT_OF_SCOPE: { label: 'Needs other evidence', cls: 'neutral' },
};

const REVIEW_LABEL: Record<string, string> = {
  DRAFT: 'Draft — awaiting review',
  APPROVED: 'Reviewed and approved',
  REJECTED: 'Rejected by reviewer',
  NEEDS_CHANGE: 'Reviewer asked for changes',
  STALE_REVIEW: 'Review is for an older library version',
};

export const statusLabel = (s: ControlStatus): string => STATUS_LABEL[s].label;
const pill = (text: string, cls: string): string => `<span class="pill ${cls}">${esc(text)}</span>`;

export const DISCLAIMER =
  'This matrix maps test EVIDENCE onto compliance controls. It is not a certification, an audit opinion, an ASV scan or a penetration test. Every mapping is DRAFT until a compliance reviewer approves it for the current library version, and references marked “unverified” must be confirmed by the compliance owner or QSA before they are quoted.';

/* ── tables ────────────────────────────────────────────────────────────── */

const evidenceSummary = (a: ControlAssessment): string =>
  a.items.length === 0
    ? ''
    : a.items
        .map(
          (i) =>
            `${i.outcome}: ${i.subject}${i.runId ? ` (run ${i.runId.slice(0, 8)}, ${i.environment ?? '?'}, ${i.finishedAt?.slice(0, 10)})` : ''}`,
        )
        .join('; ');

export function matrixTables(a: Assessment, meta: MatrixMeta): { name: string; rows: Row[] }[] {
  return [
    {
      name: 'Summary',
      rows: [
        { field: 'Target', value: meta.target.name },
        { field: 'Library version', value: a.libraryVersion },
        { field: 'As of', value: a.asOf },
        { field: 'Evidence basis', value: a.basis },
        { field: 'Freshness window (days)', value: a.maxAgeDays },
        { field: 'Important', value: DISCLAIMER },
        ...a.frameworks.map((f) => ({
          field: f.name,
          value: `${f.byStatus.EVIDENCED} evidenced · ${f.byStatus.PARTIAL} partial · ${f.byStatus.SIMULATOR_ONLY} simulator-only · ${f.byStatus.NOT_TESTED} not tested · ${f.byStatus.FAILING} failing · ${f.byStatus.OUT_OF_SCOPE} need other evidence · ${f.reviewedApproved}/${f.total} reviewed · ${f.unverifiedReferences} unverified references`,
        })),
      ],
    },
    {
      name: 'Controls',
      rows: a.controls.map((c) => ({
        framework: FRAMEWORKS[c.control.framework].short,
        id: c.control.id,
        reference: c.control.ref,
        referenceVerified: c.control.refVerified ? 'yes' : 'NO — confirm with compliance owner',
        control: c.control.title,
        status: statusLabel(c.status),
        coverage: c.coverage,
        review: REVIEW_LABEL[c.review.status] ?? c.review.status,
        reviewer: c.review.reviewer ?? '',
        reviewedAt: c.review.at ?? '',
        whatTheEvidenceSays: c.statement,
        evidence: evidenceSummary(c),
        limitation: c.control.limitation,
        howToCover: c.control.howToCover ?? '',
      })),
    },
    {
      name: 'Evidence',
      rows: a.controls.flatMap((c) =>
        c.items.map((i) => ({
          control: c.control.id,
          evidence: i.label,
          outcome: i.outcome,
          run: i.runId ?? '',
          environment: i.environment ?? '',
          finishedAt: i.finishedAt ?? '',
          detail: i.detail,
        })),
      ),
    },
  ];
}

export function reviewRows(reviews: ReviewRecord[]): Row[] {
  return reviews.map((r) => ({
    control: r.controlId,
    libraryVersion: r.libraryVersion,
    decision: r.decision,
    reviewer: r.reviewerLabel,
    at: r.createdAt,
    note: r.note,
  }));
}

export async function renderMatrixXlsx(
  a: Assessment,
  meta: MatrixMeta,
  reviews: ReviewRecord[],
): Promise<Buffer> {
  return rowsToXlsx(
    [...matrixTables(a, meta), { name: 'Reviews', rows: reviewRows(reviews) }].filter(
      (t) => t.rows.length > 0,
    ),
  );
}

const csvCell = (v: unknown): string => {
  const raw =
    v == null
      ? ''
      : typeof v === 'string'
        ? v
        : typeof v === 'object'
          ? JSON.stringify(v)
          : JSON.stringify(v);
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function renderMatrixCsv(a: Assessment, meta: MatrixMeta): string {
  const rows = matrixTables(a, meta).find((t) => t.name === 'Controls')!.rows;
  const headers = Object.keys(rows[0] ?? {});
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join(
    '\n',
  );
}

/* ── HTML ──────────────────────────────────────────────────────────────── */

function frameworkSection(a: Assessment, f: Framework): string {
  const sum = a.frameworks.find((x) => x.framework === f)!;
  const rows = a.controls.filter((c) => c.control.framework === f);
  return `<section><h2>${esc(FRAMEWORKS[f].name)}</h2><p class="muted">${esc(FRAMEWORKS[f].note)}</p>
<p>${(Object.keys(STATUS_LABEL) as ControlStatus[])
    .filter((s) => sum.byStatus[s] > 0)
    .map((s) => `${pill(`${STATUS_LABEL[s].label}: ${sum.byStatus[s]}`, STATUS_LABEL[s].cls)}`)
    .join(
      ' ',
    )} <span class="tag">${sum.reviewedApproved}/${sum.total} reviewed</span>${sum.unverifiedReferences ? ` <span class="tag">${sum.unverifiedReferences} unverified references</span>` : ''}</p>
${htmlTable(
  ['Reference', 'Control', 'Status', 'Review', 'What the evidence says', 'Limits'],
  rows.map((c) => [
    `<b>${esc(c.control.ref)}</b>${c.control.refVerified ? '' : '<div class="muted">unverified reference</div>'}`,
    `${esc(c.control.title)}<div class="muted">${esc(c.control.intent)}</div>`,
    `${pill(STATUS_LABEL[c.status].label, STATUS_LABEL[c.status].cls)}${c.coverage === 'partial' ? '<div class="muted">partial scope</div>' : ''}`,
    `${esc(REVIEW_LABEL[c.review.status] ?? c.review.status)}${c.review.reviewer ? `<div class="muted">${esc(c.review.reviewer)}</div>` : ''}`,
    `${esc(c.statement)}${c.items.length ? `<details><summary>${c.items.length} evidence item(s)</summary><ul>${c.items.map((i) => `<li>${pill(i.outcome, i.outcome === 'PASS' ? 'ok' : i.outcome === 'FAIL' ? 'bad' : 'neutral')} ${esc(i.label)}${i.runId ? ` <span class="muted">run ${esc(i.runId.slice(0, 8))} · ${esc(i.environment ?? '?')} · ${esc(i.finishedAt?.slice(0, 10) ?? '')}</span>` : ''}</li>`).join('')}</ul></details>` : ''}`,
    `${esc(c.control.limitation)}${c.control.howToCover ? `<div><b>To cover:</b> ${esc(c.control.howToCover)}</div>` : ''}`,
  ]),
)}</section>`;
}

export function renderMatrixHtml(a: Assessment, meta: MatrixMeta, reviews: ReviewRecord[]): string {
  const sim = a.basis === 'simulator' || a.basis === 'none' || a.basis === 'mixed';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compliance evidence matrix — ${esc(meta.target.name)}</title><style>${CSS}</style></head><body><main>
<header class="muted">${esc(meta.target.name)} · ${esc(meta.target.host)} · library ${esc(a.libraryVersion)} · as of ${esc(a.asOf.slice(0, 19).replace('T', ' '))} UTC · evidence freshness ${a.maxAgeDays} days</header>
<h1>Compliance evidence matrix</h1>
<div class="banner"><b>Read this first.</b> ${esc(DISCLAIMER)}</div>
${sim ? `<div class="banner"><b>${a.basis === 'none' ? 'No evidence yet.' : a.basis === 'simulator' ? 'Simulator evidence only.' : 'Mixed evidence.'}</b> ${a.basis === 'simulator' ? 'Everything below was produced against our own mock of the iSmartPay API. It shows the tests work, not that the real service complies.' : a.basis === 'mixed' ? 'Only controls evidenced by real-environment runs count as “Evidenced”; simulator results are labelled separately.' : 'Run the correctness, security and load suites first.'}</div>` : ''}
<section><h2>At a glance</h2>${htmlTable(
    [
      'Framework',
      'Evidenced',
      'Partial',
      'Simulator only',
      'Not tested',
      'Failing',
      'Needs other evidence',
      'Reviewed',
    ],
    a.frameworks.map((f) => [
      esc(f.name),
      String(f.byStatus.EVIDENCED + f.byStatus.EVIDENCED_STALE),
      String(f.byStatus.PARTIAL),
      String(f.byStatus.SIMULATOR_ONLY),
      String(f.byStatus.NOT_TESTED),
      String(f.byStatus.FAILING),
      String(f.byStatus.OUT_OF_SCOPE),
      `${f.reviewedApproved}/${f.total}`,
    ]),
  )}</section>
${(Object.keys(FRAMEWORKS) as Framework[]).map((f) => frameworkSection(a, f)).join('\n')}
<section><h2>Not covered by this evidence</h2><p class="muted">These controls cannot be proven by API or load testing. They need other evidence.</p>${htmlTable(
    ['Control', 'Why testing cannot show it', 'How to cover it'],
    a.controls
      .filter((c) => c.status === 'OUT_OF_SCOPE')
      .map((c) => [
        `<b>${esc(c.control.ref)}</b> ${esc(c.control.title)}`,
        esc(c.control.limitation),
        esc(c.control.howToCover ?? ''),
      ]),
  )}</section>
<section><h2>Reviewer sign-off history</h2>${
    reviews.length
      ? htmlTable(
          ['When', 'Control', 'Decision', 'Reviewer', 'Library', 'Note'],
          reviews.map((r) => [
            esc(r.createdAt.slice(0, 19).replace('T', ' ')),
            esc(r.controlId),
            esc(r.decision),
            esc(r.reviewerLabel),
            esc(r.libraryVersion),
            esc(r.note),
          ]),
        )
      : '<p class="muted">No control has been reviewed yet — every mapping is a draft.</p>'
  }</section>
<footer>Generated ${esc(meta.generatedAt.slice(0, 19).replace('T', ' '))} UTC from stored test evidence. ${esc(DISCLAIMER)}</footer></main></body></html>`;
}

/* ── PDF ───────────────────────────────────────────────────────────────── */

export function renderMatrixPdf(
  a: Assessment,
  meta: MatrixMeta,
  reviews: ReviewRecord[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: {
        Title: `Compliance evidence matrix — ${meta.target.name}`,
        Author: 'FinTech Cron Monitor',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('Compliance evidence matrix');
    doc
      .fontSize(9)
      .fillColor('#555')
      .text(
        `${meta.target.name} · library ${a.libraryVersion} · as of ${a.asOf.slice(0, 19).replace('T', ' ')} · evidence basis: ${a.basis}`,
      );
    doc.moveDown(0.5).fillColor('#b45309').fontSize(9).text(DISCLAIMER).fillColor('#000');

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const draw = (headers: string[], weights: number[], rows: string[][]): void => {
      const sum = weights.reduce((x, y) => x + y, 0);
      const widths = weights.map((w) => (w / sum) * width);
      const row = (cells: string[], bold: boolean): void => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
        const h = Math.max(
          10,
          ...cells.map((c, i) => doc.heightOfString(c, { width: widths[i]! - 4 })),
        );
        if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
        const top = doc.y;
        let x = doc.page.margins.left;
        cells.forEach((c, i) => {
          doc
            .font(bold ? 'Helvetica-Bold' : 'Helvetica')
            .fontSize(7.5)
            .text(c, x, top, { width: widths[i]! - 4 });
          x += widths[i]!;
        });
        doc.y = top + h + 3;
      };
      row(headers, true);
      for (const r of rows) row(r, false);
    };

    for (const f of Object.keys(FRAMEWORKS) as Framework[]) {
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).text(FRAMEWORKS[f].name);
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor('#555')
        .text(FRAMEWORKS[f].note)
        .fillColor('#000')
        .moveDown(0.3);
      draw(
        ['Reference', 'Control', 'Status', 'Review', 'What the evidence says'],
        [1.2, 2.4, 1, 1.2, 3],
        a.controls
          .filter((c) => c.control.framework === f)
          .map((c) => [
            c.control.ref + (c.control.refVerified ? '' : ' (unverified)'),
            c.control.title,
            STATUS_LABEL[c.status].label + (c.coverage === 'partial' ? ' · partial scope' : ''),
            REVIEW_LABEL[c.review.status] ?? c.review.status,
            `${c.statement} Limits: ${c.control.limitation}`,
          ]),
      );
    }
    if (reviews.length > 0) {
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).text('Reviewer sign-off history');
      doc.moveDown(0.3);
      draw(
        ['When', 'Control', 'Decision', 'Reviewer', 'Note'],
        [1.3, 1.2, 1, 1.6, 3],
        reviews
          .slice(0, 80)
          .map((r) => [
            r.createdAt.slice(0, 16).replace('T', ' '),
            r.controlId,
            r.decision,
            r.reviewerLabel,
            r.note,
          ]),
      );
    }
    doc.end();
  });
}
