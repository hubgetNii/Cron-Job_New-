import { query } from '../lib/db.js';

type Row = Record<string, unknown>;

export interface DataSetSummary {
  id: string;
  name: string;
  environment: string;
  recordCount: number;
  fields: string[];
  description: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface DataSet extends DataSetSummary {
  records: Record<string, unknown>[];
}

const summary = (r: Row): DataSetSummary => ({
  id: r['id'] as string,
  name: r['name'] as string,
  environment: r['environment'] as string,
  recordCount: Number(r['record_count']),
  fields: r['fields'] as string[],
  description: (r['description'] as string | null) ?? null,
  createdBy: (r['created_by'] as string | null) ?? null,
  createdAt: (r['created_at'] as Date).toISOString(),
});

/** Dotted paths present in EVERY record, e.g. `payer.value`. */
export function commonFieldPaths(records: Record<string, unknown>[]): string[] {
  const paths = (v: unknown, prefix: string, out: Set<string>): void => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) paths(x, prefix ? `${prefix}.${k}` : k, out);
    } else if (prefix) out.add(prefix);
  };
  const sets = records.map((r) => {
    const s = new Set<string>();
    paths(r, '', s);
    return s;
  });
  const [first, ...rest] = sets;
  if (!first) return [];
  return [...first].filter((p) => rest.every((s) => s.has(p))).sort();
}

export async function createDataSet(input: {
  name: string;
  environment: string;
  records: Record<string, unknown>[];
  description?: string | undefined;
  createdBy: string | null;
}): Promise<DataSetSummary> {
  const { rows } = await query<Row>(
    `INSERT INTO load_test_data_sets (name, environment, records, record_count, fields, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.name,
      input.environment,
      JSON.stringify(input.records),
      input.records.length,
      commonFieldPaths(input.records),
      input.description ?? null,
      input.createdBy,
    ],
  );
  return summary(rows[0]!);
}

export async function getDataSet(id: string): Promise<DataSet | null> {
  const { rows } = await query<Row>(`SELECT * FROM load_test_data_sets WHERE id = $1`, [id]);
  const r = rows[0];
  return r ? { ...summary(r), records: r['records'] as Record<string, unknown>[] } : null;
}

export async function listDataSets(): Promise<DataSetSummary[]> {
  const { rows } = await query<Row>(
    `SELECT id, name, environment, record_count, fields, description, created_by, created_at
       FROM load_test_data_sets ORDER BY created_at DESC LIMIT 200`,
  );
  return rows.map(summary);
}

/** Plans (any age) that still reference this set. */
export async function plansUsingDataSet(id: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM load_test_plans WHERE config->>'dataSetId' = $1`,
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function deleteDataSet(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM load_test_data_sets WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}
