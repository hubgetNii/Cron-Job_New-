import ExcelJS from 'exceljs';

export interface XlsxSheet {
  name: string;
  rows: Array<Record<string, unknown>>;
}

const titleCase = (s: string): string =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());

function flat(v: unknown): string | number | boolean {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

/** One workbook, one worksheet per sheet spec. Bold frozen header row. */
export async function rowsToXlsx(sheets: XlsxSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinTech Cron Monitor';
  wb.created = new Date();

  const used = new Set<string>();
  for (const sheet of sheets) {
    let name = sheet.name.replace(/[[\]*?/\\:]/g, ' ').slice(0, 31) || 'Sheet';
    let n = 1;
    while (used.has(name.toLowerCase())) name = `${sheet.name.slice(0, 28)} ${(n += 1)}`;
    used.add(name.toLowerCase());

    const ws = wb.addWorksheet(name);
    const headers = Object.keys(sheet.rows[0] ?? {});
    ws.columns = headers.map((h) => ({
      header: titleCase(h),
      key: h,
      width: Math.min(48, Math.max(12, h.length + 4)),
    }));
    for (const row of sheet.rows) {
      ws.addRow(Object.fromEntries(headers.map((h) => [h, flat(row[h])])));
    }
    if (headers.length > 0) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
