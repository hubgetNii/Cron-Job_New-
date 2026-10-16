import PDFDocument from 'pdfkit';
import { rowsToXlsx, type XlsxSheet } from '../../../lib/xlsx.js';
import type { AnyReport, LoadRunReport, SuiteReport } from './report.types.js';
import { DECISION_TEXT } from './humanize.js';

/**
 * Report exporters (Phase 27). Every format is generated from the same report
 * object, so the dashboard, the HTML file you email, the PDF you print and the
 * workbook you analyse can never disagree.
 */

export type ReportFormat = 'json' | 'html' | 'xlsx' | 'csv' | 'pdf';
export const REPORT_CONTENT_TYPES: Record<Exclude<ReportFormat, 'json'>, string> = {
  html: 'text/html; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
};

type Row = Record<string, unknown>;

/** Any value as display text, without ever printing "[object Object]". */
const text = (v: unknown): string => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v) ?? '';
};
export interface NamedTable {
  name: string;
  rows: Row[];
}

const kv = (pairs: [string, unknown][]): Row[] => pairs.map(([field, value]) => ({ field, value }));

/* ── tabular view (XLSX / CSV / PDF share it) ──────────────────────────── */

export function tablesOf(report: AnyReport): NamedTable[] {
  if (isLoad(report)) {
    return [
      {
        name: 'Summary',
        rows: kv([
          ['Report', report.meta.title],
          ['Target', report.meta.target.name],
          ['Host', report.meta.target.host],
          ['Environment', report.meta.environment.label],
          ['Verdict', report.executive.verdict],
          ['Decision', DECISION_TEXT[report.executive.decision]],
          ['Headline', report.executive.headline],
          ['Why', report.results.verdictReason],
          ['Scenario', report.tested.scenario],
          ['Load shape', report.tested.shape],
          ['Generated', report.meta.generatedAt],
          ...report.executive.keyNumbers.map((k): [string, unknown] => [
            k.label,
            `${k.value} — ${k.caption}`,
          ]),
        ]),
      },
      {
        name: 'Objectives',
        rows: report.results.slo.map((c) => ({
          objective: c.name,
          target: c.target,
          actual: c.actual,
          status: c.status,
          meaning: c.why,
        })),
      },
      { name: 'Findings', rows: report.findings.map(findingRow) },
      {
        name: 'Time series',
        rows: report.results.series.map((m) => ({
          at: m.at,
          requests: m.requests,
          failures: m.failures,
          rps: m.rps,
          p50Ms: m.p50Ms,
          p95Ms: m.p95Ms,
          p99Ms: m.p99Ms,
          maxMs: m.maxMs,
          statusCounts: m.statusCounts,
        })),
      },
      {
        name: 'Trend',
        rows: report.trend.map((t) => ({
          run: t.runId,
          finishedAt: t.finishedAt,
          verdict: t.verdict,
          p95Ms: t.p95Ms,
          errorRate: t.errorRate,
          achievedRps: t.achievedRps,
          thisRun: t.current,
        })),
      },
      {
        name: 'Status codes',
        rows: Object.entries(report.results.errors.statusCounts).map(([status, count]) => ({
          status,
          count,
        })),
      },
      {
        name: 'Event log',
        rows: report.logs.timeline.map((e) => ({
          at: e.at,
          event: e.event,
          detail: e.detail,
          actor: e.actor,
        })),
      },
      {
        name: 'Run config',
        rows: kv(Object.entries((report.logs.runConfig ?? {}) as Record<string, unknown>)),
      },
    ];
  }
  if (isSuite(report)) {
    return [
      {
        name: 'Summary',
        rows: kv([
          ['Report', report.meta.title],
          ['Target', report.meta.target.name],
          ['Environment', report.meta.environment.label],
          ['Verdict', report.executive.verdict],
          ['Headline', report.executive.headline],
          ['Summary', report.executive.summary],
          ['Generated', report.meta.generatedAt],
          ...report.executive.keyNumbers.map((k): [string, unknown] => [
            k.label,
            `${k.value} — ${k.caption}`,
          ]),
        ]),
      },
      {
        name: 'Checks',
        rows: report.checks.map((c) => ({
          check: c.title,
          id: c.id,
          owasp: c.owasp ?? '',
          status: c.status,
          warnings: c.warnings,
          whyItMatters: c.whyItMatters,
          evidenceCalls: c.evidenceCount,
          note: c.note ?? '',
        })),
      },
      {
        name: 'Assertions',
        rows: report.checks.flatMap((c) =>
          c.assertions.map((a) => ({
            check: c.id,
            assertion: a.name,
            result: a.pass ? 'pass' : a.advisory ? 'warning' : 'FAIL',
            detail: a.detail ?? '',
          })),
        ),
      },
      { name: 'Findings', rows: report.findings.map(findingRow) },
      {
        name: 'Not checked',
        rows: report.coverageGaps.map((g) => ({ check: g.title, id: g.id, reason: g.reason })),
      },
      {
        name: 'Evidence',
        rows: report.evidence.map((e) => ({
          check: e.checkId,
          at: e.at,
          method: e.method,
          path: e.path,
          status: e.status,
          ms: e.ms,
          requestId: e.requestId ?? '',
          idempotencyKey: e.idempotencyKey ?? '',
          reference: e.reference ?? '',
          errorCode: e.errorCode ?? '',
        })),
      },
      {
        name: 'Event log',
        rows: report.logs.timeline.map((e) => ({
          at: e.at,
          event: e.event,
          detail: e.detail,
          actor: e.actor,
        })),
      },
    ];
  }
  return [
    {
      name: 'Summary',
      rows: kv([
        ['Target', report.meta.target.name],
        ['Status', report.readiness.status],
        ['Score (provisional)', report.readiness.score ?? 'n/a'],
        ['Evidence basis', report.readiness.basis],
        ['Headline', report.headline],
        ['As of', report.readiness.asOf],
      ]),
    },
    {
      name: 'Gates',
      rows: report.readiness.gates.map((g) => ({
        gate: g.name,
        required: g.required,
        status: g.status,
        detail: g.detail,
        evidenceRun: g.evidenceId ?? '',
      })),
    },
    {
      name: 'Next steps',
      rows: report.readiness.nextSteps.map((s, i) => ({ step: i + 1, action: s })),
    },
    {
      name: 'Load evidence',
      rows: report.evidence.load.map((l) => ({
        profile: l.profile,
        verdict: l.verdict,
        finishedAt: l.finishedAt,
        environment: l.environmentLabel,
        run: l.id,
      })),
    },
    { name: 'Findings', rows: report.findings.map(findingRow) },
  ];
}

const findingRow = (f: AnyReportFinding): Row => ({
  severity: f.severity,
  source: f.source,
  owasp: f.owasp ?? '',
  title: f.title,
  impact: f.impact,
  cause: f.cause,
  recommendation: f.recommendation,
  advisory: f.advisory,
  reference: f.reference,
});
type AnyReportFinding = LoadRunReport['findings'][number];

const isLoad = (r: AnyReport): r is LoadRunReport => r.meta.kind === 'load';
const isSuite = (r: AnyReport): r is SuiteReport =>
  r.meta.kind === 'correctness' || r.meta.kind === 'security';

/* ── XLSX / CSV ────────────────────────────────────────────────────────── */

export function renderXlsx(report: AnyReport): Promise<Buffer> {
  const sheets: XlsxSheet[] = tablesOf(report).filter((t) => t.rows.length > 0);
  return rowsToXlsx(sheets);
}

const csvCell = (v: unknown): string => {
  const s = text(v);
  // Neutralise spreadsheet formula injection from any untrusted text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function renderCsv(report: AnyReport, table?: string): string {
  const tables = tablesOf(report);
  const t =
    tables.find((x) => x.name.toLowerCase() === (table ?? '').toLowerCase()) ??
    tables.find(
      (x) => x.name === (isLoad(report) ? 'Objectives' : isSuite(report) ? 'Checks' : 'Gates'),
    ) ??
    tables[0]!;
  const headers = Object.keys(t.rows[0] ?? {});
  return [
    headers.join(','),
    ...t.rows.map((r) => headers.map((h) => csvCell(r[h])).join(',')),
  ].join('\n');
}

/* ── PDF ───────────────────────────────────────────────────────────────── */

export function renderPdf(report: AnyReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 40,
      info: { Title: report.meta.title, Author: 'FinTech Cron Monitor' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const verdict = isLoad(report)
      ? report.executive.verdict
      : isSuite(report)
        ? report.executive.verdict
        : report.readiness.status;
    doc.fontSize(18).text(report.meta.title);
    doc
      .fontSize(9)
      .fillColor('#555')
      .text(
        `${report.meta.target.name} · ${report.meta.environment.label} · generated ${report.meta.generatedAt.slice(0, 19).replace('T', ' ')}`,
      );
    doc
      .moveDown(0.6)
      .fillColor('#000')
      .fontSize(14)
      .text(`Verdict: ${verdict.replace(/_/g, ' ')}`);
    const headline =
      isLoad(report) || isSuite(report) ? report.executive.headline : report.headline;
    doc.moveDown(0.3).fontSize(10).text(headline);
    if (isLoad(report) || isSuite(report))
      doc.moveDown(0.3).fillColor('#444').text(report.executive.summary).fillColor('#000');
    if (!report.meta.environment.isReal && report.meta.kind !== 'readiness') {
      doc
        .moveDown(0.5)
        .fillColor('#b45309')
        .fontSize(9)
        .text(
          'Evidence from the simulator: it demonstrates the tests work; it is not evidence about the real service.',
        )
        .fillColor('#000');
    }

    for (const table of tablesOf(report)) {
      if (
        table.rows.length === 0 ||
        ['Time series', 'Evidence', 'Run config', 'Status codes'].includes(table.name)
      )
        continue;
      doc.moveDown(0.8).fontSize(12).text(table.name);
      doc.moveDown(0.2);
      const headers = Object.keys(table.rows[0]!);
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colW = headers.map((h) =>
        ['field', 'status', 'severity', 'verdict', 'step', 'required'].includes(h)
          ? 0.6
          : [
                'value',
                'meaning',
                'impact',
                'cause',
                'recommendation',
                'detail',
                'whyItMatters',
                'action',
              ].includes(h)
            ? 2.2
            : 1,
      );
      const sum = colW.reduce((a, b) => a + b, 0);
      const widths = colW.map((w) => (w / sum) * width);
      const row = (cells: string[], bold: boolean): void => {
        const y = doc.y;
        let h = 10;
        cells.forEach((c, i) => {
          doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5);
          h = Math.max(h, doc.heightOfString(c, { width: widths[i]! - 4 }));
        });
        if (y + h > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
        }
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
      row(
        headers.map((h) => h.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()),
        true,
      );
      for (const r of table.rows.slice(0, 120))
        row(
          headers.map((h) => text(r[h]).slice(0, 400)),
          false,
        );
      if (table.rows.length > 120)
        doc
          .fontSize(7)
          .fillColor('#888')
          .text(`… ${table.rows.length - 120} more rows (see the workbook)`)
          .fillColor('#000');
    }
    doc
      .moveDown(1)
      .fontSize(7)
      .fillColor('#777')
      .text(
        'Generated from stored test evidence. This report supports, but is not, a certification or audit opinion.',
      );
    doc.end();
  });
}

/* ── HTML ──────────────────────────────────────────────────────────────── */

export const esc = (v: unknown): string =>
  text(v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const VERDICT: Record<string, { label: string; cls: string }> = {
  PASS: { label: 'Pass', cls: 'ok' },
  PASS_WITH_WARNINGS: { label: 'Pass with warnings', cls: 'warn' },
  FAIL: { label: 'Fail', cls: 'bad' },
  INCONCLUSIVE: { label: 'Inconclusive', cls: 'neutral' },
  READY: { label: 'Ready', cls: 'ok' },
  READY_WITH_WARNINGS: { label: 'Ready with warnings', cls: 'warn' },
  NOT_READY: { label: 'Not ready', cls: 'bad' },
  INCOMPLETE: { label: 'Incomplete', cls: 'neutral' },
  WARN: { label: 'Warning', cls: 'warn' },
  INFO: { label: 'Info', cls: 'neutral' },
  MISSING: { label: 'Missing', cls: 'neutral' },
  ERROR: { label: 'Error', cls: 'bad' },
  SKIPPED: { label: 'Not run', cls: 'neutral' },
  CRITICAL: { label: 'Critical', cls: 'bad' },
  HIGH: { label: 'High', cls: 'bad' },
  MEDIUM: { label: 'Medium', cls: 'warn' },
  LOW: { label: 'Low', cls: 'neutral' },
};
const pill = (s: string): string => {
  const v = VERDICT[s] ?? { label: s, cls: 'neutral' };
  return `<span class="pill ${v.cls}">${esc(v.label)}</span>`;
};

export function htmlTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="muted">Nothing to show.</p>';
  return `<div class="tablewrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function chart(series: LoadRunReport['results']['series']): string {
  if (series.length < 2) return '<p class="muted">Not enough data points for a chart.</p>';
  const W = 720;
  const H = 180;
  const pad = 34;
  const maxRps = Math.max(1, ...series.map((s) => s.rps));
  const maxMs = Math.max(1, ...series.map((s) => s.p95Ms));
  const x = (i: number): number => pad + (i / (series.length - 1)) * (W - pad * 2);
  const line = (vals: number[], max: number): string =>
    vals
      .map((v, i) => `${x(i).toFixed(1)},${(H - pad - (v / max) * (H - pad * 2)).toFixed(1)}`)
      .join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Throughput and P95 latency over time" class="chart">
  <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#d4d4d8"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#d4d4d8"/>
  <polyline fill="none" stroke="#2563eb" stroke-width="2" points="${line(
    series.map((s) => s.rps),
    maxRps,
  )}"/>
  <polyline fill="none" stroke="#d97706" stroke-width="2" stroke-dasharray="5 3" points="${line(
    series.map((s) => s.p95Ms),
    maxMs,
  )}"/>
  <text x="${pad}" y="${pad - 8}" font-size="10" fill="#2563eb">throughput (peak ${maxRps}/s)</text>
  <text x="${W - pad}" y="${pad - 8}" font-size="10" fill="#d97706" text-anchor="end">P95 latency (peak ${Math.round(maxMs)} ms)</text>
  <text x="${pad}" y="${H - 10}" font-size="10" fill="#71717a">${esc(series[0]!.at.slice(11, 19))}</text>
  <text x="${W - pad}" y="${H - 10}" font-size="10" fill="#71717a" text-anchor="end">${esc(series.at(-1)!.at.slice(11, 19))}</text></svg>`;
}

function findingsHtml(findings: AnyReportFinding[]): string {
  if (findings.length === 0) return '<p class="muted">No findings.</p>';
  return findings
    .map(
      (f) => `<div class="finding ${f.advisory ? 'advisory' : ''}">
  <div class="fh">${pill(f.severity)} <strong>${esc(f.title)}</strong>${f.advisory ? ' <span class="muted">(suggestion)</span>' : ''}${f.owasp ? ` <span class="tag">${esc(f.owasp.split(' ')[0])}</span>` : ''}</div>
  <p><b>What it means:</b> ${esc(f.impact)}</p>
  <p><b>What we saw:</b> ${esc(f.cause)}</p>
  <p><b>What to do:</b> ${esc(f.recommendation)}</p></div>`,
    )
    .join('\n');
}

export const CSS = `
:root{--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--bg:#fff;--soft:#f4f4f5;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;--blue:#2563eb}
*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}section{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin:14px 0}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 10px}h3{font-size:14px;margin:14px 0 6px}p{margin:6px 0}.muted{color:var(--muted)}
.pill{display:inline-block;border-radius:999px;padding:1px 10px;font-size:12px;font-weight:600;border:1px solid}
.pill.ok{color:var(--ok);border-color:#86efac;background:#f0fdf4}.pill.warn{color:var(--warn);border-color:#fcd34d;background:#fffbeb}
.pill.bad{color:var(--bad);border-color:#fca5a5;background:#fef2f2}.pill.neutral{color:#52525b;border-color:#d4d4d8;background:#fafafa}
.hero{border-left:6px solid #a1a1aa}.hero.ok{border-color:var(--ok)}.hero.warn{border-color:var(--warn)}.hero.bad{border-color:var(--bad)}
.hero .headline{font-size:17px;font-weight:600;margin:8px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:10px}
.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card .v{font-size:20px;font-weight:700}.card .l{font-size:12px;color:var(--muted)}.card .c{font-size:11px;color:var(--muted);margin-top:2px}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.finding{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}.finding.advisory{background:#fafafa}.fh{margin-bottom:4px}.tag{font-size:11px;border:1px solid var(--line);border-radius:4px;padding:0 5px;color:var(--muted)}
.banner{background:#fffbeb;border:1px solid #fcd34d;color:#78350f;border-radius:8px;padding:8px 12px;margin:10px 0}.chart{width:100%;height:auto}
details{margin:8px 0}summary{cursor:pointer;font-weight:600}code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px}pre{background:var(--soft);padding:10px;border-radius:6px;overflow-x:auto}
footer{color:var(--muted);font-size:12px;margin-top:20px}@media print{body{background:#fff}section{break-inside:avoid;border-color:#ddd}details{display:block}details>summary{display:none}}
`;

function frame(report: AnyReport, verdictKey: string, body: string): string {
  const v = VERDICT[verdictKey] ?? VERDICT['INFO']!;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(report.meta.title)} — ${esc(report.meta.target.name)}</title><style>${CSS}</style></head><body><main>
<header class="muted"><div>${esc(report.meta.target.name)} · ${esc(report.meta.target.host)} · ${esc(report.meta.environment.label)} · generated ${esc(report.meta.generatedAt.slice(0, 19).replace('T', ' '))} UTC${report.meta.requestedBy ? ` · requested by ${esc(report.meta.requestedBy)}` : ''}</div></header>
<h1>${esc(report.meta.title)} <span class="pill ${v.cls}">${esc(v.label)}</span></h1>
${report.meta.environment.isReal || report.meta.kind === 'readiness' ? '' : '<div class="banner"><b>Simulator evidence.</b> This run exercised our own mock of the iSmartPay API. It shows the tests work; it is not evidence about the real service.</div>'}
${body}
<footer>Generated from stored test evidence. Figures are measurements, not estimates. This report supports, but is not, a certification or audit opinion.</footer></main></body></html>`;
}

const cards = (k: LoadRunReport['executive']['keyNumbers']): string =>
  `<div class="cards">${k.map((c) => `<div class="card"><div class="v">${esc(c.value)}</div><div class="l">${esc(c.label)}</div><div class="c">${esc(c.caption)}</div></div>`).join('')}</div>`;

const glossaryHtml = (g: Record<string, string>): string =>
  `<details><summary>Glossary — what these terms mean</summary>${htmlTable(
    ['Term', 'Meaning'],
    Object.entries(g).map(([t, m]) => [`<b>${esc(t)}</b>`, esc(m)]),
  )}</details>`;

function suiteDigestHtml(title: string, d: LoadRunReport['moneySafety']): string {
  if (!d)
    return `<section><h2>${esc(title)}</h2><p class="muted">No run yet — this area is unverified.</p></section>`;
  return `<section><h2>${esc(title)} ${pill(d.verdict)}</h2><p>${esc(d.headline)}</p><p class="muted">${esc(d.environmentLabel)} · ${esc(d.finishedAt.slice(0, 10))} · <code>${esc(d.runId)}</code></p>${
    d.failedChecks.length
      ? htmlTable(
          ['Failed check', 'Why it matters'],
          d.failedChecks.map((c) => [esc(c.title), esc(c.why)]),
        )
      : ''
  }</section>`;
}

const readinessHtml = (r: LoadRunReport['readiness']): string =>
  `<section><h2>Production readiness ${pill(r.status)}</h2><p class="muted">Evidence basis: ${esc(r.basis)}${r.score != null ? ` · provisional score ${r.score}/100` : ''}</p>
${htmlTable(
  ['Gate', 'Required', 'Status', 'Detail'],
  r.gates.map((g) => [esc(g.name), g.required ? 'yes' : 'no', pill(g.status), esc(g.detail)]),
)}
${r.nextSteps.length ? `<h3>Next steps</h3><ol>${r.nextSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}</section>`;

export function renderHtml(report: AnyReport): string {
  if (isLoad(report)) {
    const e = report.executive;
    const body = `
<section class="hero ${(VERDICT[e.verdict] ?? VERDICT['INFO']!).cls}"><h2>Summary for everyone</h2>
<div class="headline">${esc(e.headline)}</div><p><b>Decision:</b> ${esc(DECISION_TEXT[e.decision])}</p><p>${esc(e.summary)}</p>${cards(e.keyNumbers)}</section>
${e.topRisks.length ? `<section><h2>Top risks</h2>${findingsHtml(e.topRisks)}</section>` : ''}
<section><h2>What was tested</h2><p>${esc(report.tested.scenario)}</p><p>${esc(report.tested.shape)}</p>
<p class="muted">Plan “${esc(report.tested.planName)}”${report.tested.dataSet ? ` · data set “${esc(report.tested.dataSet.name)}” (${report.tested.dataSet.records} records)` : ''}${report.tested.window.seconds != null ? ` · ran for ${report.tested.window.seconds} s` : ''}</p>
${report.tested.flags.length ? `<p>${report.tested.flags.map((f) => `<span class="tag">${esc(f)}</span>`).join(' ')}</p>` : ''}</section>
<section><h2>Did it meet its objectives?</h2><p>${esc(report.results.verdictReason)}</p>
${htmlTable(
  ['Objective', 'Target', 'Actual', 'Result', 'In plain words'],
  report.results.slo.map((c) => [
    esc(c.name),
    esc(c.target),
    esc(c.actual),
    pill(c.status),
    esc(c.why),
  ]),
)}</section>
${suiteDigestHtml('Money safety (latest correctness run)', report.moneySafety)}
${suiteDigestHtml('Security (latest OWASP run)', report.security)}
${readinessHtml(report.readiness)}
<section><h2>All findings</h2>${findingsHtml(report.findings)}</section>
<section><h2>Technical detail</h2>
<h3>Speed and volume over time</h3>${chart(report.results.series)}
<h3>Latency</h3>${htmlTable(['Average', 'P50', 'P90', 'P95', 'P99', 'Slowest'], [[report.results.latency.avgMs, report.results.latency.p50Ms, report.results.latency.p90Ms, report.results.latency.p95Ms, report.results.latency.p99Ms, report.results.latency.maxMs].map((n) => `${esc(n)} ms`)])}
<h3>Throughput</h3>${htmlTable(['Requests', 'Planned', 'Average/s', 'Peak/s', 'Clean max/s'], [[report.results.throughput.totalRequests, report.results.throughput.expectedRequests, report.results.throughput.achievedAvgRps, report.results.throughput.peakRps, report.results.throughput.maxSustainedRps].map(esc)])}
<h3>Errors</h3><p>${esc(report.results.errors.plain)}</p>${htmlTable(
      ['HTTP status', 'Count'],
      Object.entries(report.results.errors.statusCounts).map(([s, c]) => [esc(s), esc(c)]),
    )}
<h3>History of this plan</h3>${htmlTable(
      ['Finished', 'Verdict', 'P95', 'Failure rate', 'Avg/s', ''],
      report.trend.map((t) => [
        esc(t.finishedAt.slice(0, 19).replace('T', ' ')),
        pill(t.verdict),
        `${esc(t.p95Ms)} ms`,
        `${esc((t.errorRate * 100).toFixed(2))}%`,
        esc(t.achievedRps),
        t.current ? '← this run' : '',
      ]),
    )}
<details open><summary>Event log</summary>${htmlTable(
      ['When', 'Event', 'Detail', 'By'],
      report.logs.timeline.map((x) => [
        esc(x.at.slice(0, 19).replace('T', ' ')),
        esc(x.event),
        esc(x.detail),
        esc(x.actor ?? ''),
      ]),
    )}</details>
<details><summary>Run configuration &amp; how to reproduce</summary><pre>${esc(JSON.stringify(report.logs.runConfig, null, 2))}</pre><pre>${esc(report.logs.reproduce.join('\n'))}</pre>
<p class="muted">Load generator: k6 ${esc(report.logs.generator.k6Version ?? '?')} · ${report.logs.generator.saturated ? 'SATURATED' : 'kept up'} · dropped iterations ${esc(report.logs.generator.droppedIterations)}${report.logs.error ? ` · error: ${esc(report.logs.error)}` : ''}</p></details></section>
<section>${glossaryHtml(report.glossary)}</section>`;
    return frame(report, e.verdict, body);
  }
  if (isSuite(report)) {
    const e = report.executive;
    const body = `
<section class="hero ${(VERDICT[e.verdict] ?? VERDICT['INFO']!).cls}"><h2>Summary for everyone</h2><div class="headline">${esc(e.headline)}</div><p>${esc(e.summary)}</p>${cards(e.keyNumbers)}</section>
${e.topRisks.length ? `<section><h2>Top risks</h2>${findingsHtml(e.topRisks)}</section>` : ''}
<section><h2>Every check</h2>${htmlTable(
      ['Check', report.suite === 'security' ? 'OWASP' : 'Controls', 'Result', 'Why it matters'],
      report.checks.map((c) => [
        `<b>${esc(c.title)}</b>${c.note ? `<div class="muted">${esc(c.note)}</div>` : ''}`,
        esc(c.owasp ?? c.controls.join(', ')),
        `${pill(c.status)}${c.warnings ? ` <span class="tag">${c.warnings} suggestion(s)</span>` : ''}`,
        esc(c.whyItMatters),
      ]),
    )}</section>
${
  report.coverageGaps.length
    ? `<section><h2>What could not be checked here</h2><p class="muted">These were not run in this environment. They are listed so the gap is visible, not hidden.</p>${htmlTable(
        ['Check', 'Reason'],
        report.coverageGaps.map((g) => [esc(g.title), esc(g.reason)]),
      )}</section>`
    : ''
}
${readinessHtml(report.readiness)}
<section><h2>All findings</h2>${findingsHtml(report.findings)}</section>
<section><h2>Technical detail</h2>${report.checks
      .map(
        (c) =>
          `<details><summary>${esc(c.title)} ${pill(c.status)}</summary>${htmlTable(
            ['Assertion', 'Result', 'Detail'],
            c.assertions.map((a) => [
              esc(a.name),
              a.pass ? pill('PASS') : a.advisory ? pill('WARN') : pill('FAIL'),
              esc(a.detail ?? ''),
            ]),
          )}<p class="muted">${c.evidenceCount} API calls recorded as evidence · ${c.durationMs} ms</p></details>`,
      )
      .join('')}
<details><summary>Event log</summary>${htmlTable(
      ['When', 'Event', 'Detail', 'By'],
      report.logs.timeline.map((x) => [
        esc(x.at.slice(0, 19).replace('T', ' ')),
        esc(x.event),
        esc(x.detail),
        esc(x.actor ?? ''),
      ]),
    )}</details>
<details><summary>Evidence — ${report.evidence.length} API calls (ids and statuses only; no bodies or secrets)</summary>${htmlTable(
      ['Check', 'Call', 'Status', 'ms', 'Request-Id', 'Reference'],
      report.evidence
        .slice(0, 400)
        .map((x) => [
          esc(x.checkId),
          `${esc(x.method)} ${esc(x.path)}`,
          esc(x.status),
          esc(x.ms),
          esc(x.requestId ?? ''),
          esc(x.reference ?? ''),
        ]),
    )}</details></section>
<section>${glossaryHtml(report.glossary)}</section>`;
    return frame(report, e.verdict, body);
  }
  const r = report.readiness;
  const body = `
<section class="hero ${(VERDICT[r.status] ?? VERDICT['INFO']!).cls}"><h2>Summary for everyone</h2><div class="headline">${esc(report.headline)}</div></section>
${readinessHtml(r)}
<section><h2>Evidence used</h2>${htmlTable(
    ['Area', 'Latest result', 'Environment', 'Date'],
    [
      ...report.evidence.load.map((l) => [
        `Load — ${esc(l.profile)}`,
        pill(l.verdict),
        esc(l.environmentLabel),
        esc(l.finishedAt.slice(0, 10)),
      ]),
      ...[report.evidence.correctness, report.evidence.security]
        .filter(Boolean)
        .map((d) => [
          d!.suite === 'security' ? 'Security' : 'Money correctness',
          pill(d!.verdict),
          esc(d!.environmentLabel),
          esc(d!.finishedAt.slice(0, 10)),
        ]),
    ],
  )}</section>
<section><h2>Open findings</h2>${findingsHtml(report.findings)}</section>
<section>${glossaryHtml(report.glossary)}</section>`;
  return frame(report, r.status, body);
}
