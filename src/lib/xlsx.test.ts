import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { rowsToXlsx } from './xlsx.js';

const dir = mkdtempSync(join(tmpdir(), 'xlsx-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function roundtrip(buf: Buffer, name: string): Promise<ExcelJS.Workbook> {
  const path = join(dir, name);
  writeFileSync(path, buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  return wb;
}

describe('rowsToXlsx', () => {
  it('writes one sheet per spec with a header row', async () => {
    const buf = await rowsToXlsx([
      {
        name: 'Traces',
        rows: [
          { requestId: 'REQ-1', httpStatus: 200 },
          { requestId: 'REQ-2', httpStatus: 503 },
        ],
      },
      { name: 'Summary', rows: [{ total: 2, failed: 1 }] },
    ]);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');

    const wb = await roundtrip(buf, 'one.xlsx');
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Traces', 'Summary']);
    const traces = wb.getWorksheet('Traces')!;
    expect(traces.getRow(1).getCell(1).value).toBe('Request Id');
    expect(traces.getRow(3).getCell(2).value).toBe(503);
  });

  it('de-dupes sheet names and sanitises illegal characters', async () => {
    const buf = await rowsToXlsx([
      { name: 'a/b:c', rows: [{ x: 1 }] },
      { name: 'a b c', rows: [{ x: 2 }] },
    ]);
    const wb = await roundtrip(buf, 'dedupe.xlsx');
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe('a b c');
    expect(new Set(names).size).toBe(2);
  });

  it('serialises objects/arrays to JSON strings', async () => {
    const buf = await rowsToXlsx([{ name: 'S', rows: [{ headers: { a: 1 }, tags: ['x'] }] }]);
    const wb = await roundtrip(buf, 'json.xlsx');
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(2).getCell(1).value).toBe('{"a":1}');
    expect(ws.getRow(2).getCell(2).value).toBe('["x"]');
  });
});
