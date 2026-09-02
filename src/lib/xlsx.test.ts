import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { rowsToXlsx } from './xlsx.js';

describe('rowsToXlsx', () => {
  it('writes one sheet per spec with a header row', async () => {
    const buf = await rowsToXlsx([
      { name: 'Traces', rows: [{ requestId: 'REQ-1', httpStatus: 200 }, { requestId: 'REQ-2', httpStatus: 503 }] },
      { name: 'Summary', rows: [{ total: 2, failed: 1 }] },
    ]);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
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
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const names = wb.worksheets.map((w) => w.name);
    expect(names[0]).toBe('a b c');
    expect(new Set(names).size).toBe(2);
  });

  it('serialises objects/arrays to JSON strings', async () => {
    const buf = await rowsToXlsx([{ name: 'S', rows: [{ headers: { a: 1 }, tags: ['x'] }] }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0]!;
    expect(ws.getRow(2).getCell(1).value).toBe('{"a":1}');
    expect(ws.getRow(2).getCell(2).value).toBe('["x"]');
  });
});
