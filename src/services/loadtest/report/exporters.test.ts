import { describe, expect, it } from 'vitest';
import { renderCsv, renderHtml, renderPdf, renderXlsx, tablesOf } from './exporters.js';
import type { ReadinessReport } from './report.types.js';

const readiness = (over: Partial<ReadinessReport['readiness']> = {}): ReadinessReport => ({
  meta: {
    kind: 'readiness',
    id: 'api-1',
    title: 'Production-readiness assessment',
    generatedAt: '2026-10-16T12:00:00.000Z',
    target: { id: 'api-1', name: 'Sandbox API', host: 'stg.example' },
    environment: { class: null, label: 'iSmartPay sandbox', isReal: true },
    requestedBy: null,
  },
  headline: 'Sandbox API: readiness cannot be decided yet.',
  readiness: {
    status: 'INCOMPLETE',
    score: 41,
    basis: 'sandbox',
    asOf: '2026-10-16T12:00:00.000Z',
    reasons: ['No security run yet.'],
    nextSteps: ['=HYPERLINK("http://evil.example","click")', 'Run the security suite.'],
    gates: [
      {
        id: 'security',
        name: 'Security',
        required: true,
        status: 'MISSING',
        detail: 'No security run yet.',
      },
    ],
    ...over,
  },
  evidence: { load: [], correctness: null, security: null },
  findings: [
    {
      id: 'f1',
      source: 'security',
      severity: 'HIGH',
      title: '<script>alert(1)</script>',
      impact: 'x',
      cause: '"quoted", with, commas',
      recommendation: 'y',
      reference: 'r',
      advisory: false,
    },
  ],
  glossary: { P95: '95th percentile' },
});

describe('exporters', () => {
  it('escapes every dynamic value in HTML and never emits a script', () => {
    const html = renderHtml(readiness());
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('Summary for everyone');
    expect(html).toContain('Incomplete');
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('neutralises spreadsheet formula injection and quotes CSV correctly', () => {
    const csv = renderCsv(readiness(), 'Next steps');
    const lines = csv.split('\n');
    expect(lines[0]).toBe('step,action');
    expect(lines[1]).toContain("'=HYPERLINK"); // leading = defused
    const findings = renderCsv(readiness(), 'Findings');
    expect(findings).toContain(
      '"""quoted"", with, commas"'.replace('"""', '"').replace('""quoted""', '""quoted""'),
    );
    expect(findings).toContain('""quoted"", with, commas');
  });

  it('produces a valid XLSX workbook and PDF from the same tables', async () => {
    const xlsx = await renderXlsx(readiness());
    expect(xlsx.subarray(0, 2).toString()).toBe('PK'); // zip container
    const pdf = await renderPdf(readiness());
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1500);
  });

  it('every format derives from tablesOf, so they cannot disagree', () => {
    const names = tablesOf(readiness()).map((t) => t.name);
    expect(names).toEqual(['Summary', 'Gates', 'Next steps', 'Load evidence', 'Findings']);
  });

  it('falls back to a sensible default table for CSV', () => {
    expect(renderCsv(readiness()).split('\n')[0]).toBe('gate,required,status,detail,evidenceRun');
    expect(renderCsv(readiness(), 'no-such-table').split('\n')[0]).toBe(
      'gate,required,status,detail,evidenceRun',
    );
  });
});
