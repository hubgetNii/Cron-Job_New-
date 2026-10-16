import { query } from '../lib/db.js';
import type { ReviewDecision, ReviewRecord } from '../loadtest/compliance/assess.js';

type Row = Record<string, unknown>;

export async function insertReview(r: {
  controlId: string;
  libraryVersion: string;
  decision: ReviewDecision;
  note: string;
  reviewerId: string;
  reviewerLabel: string;
}): Promise<ReviewRecord & { id: string }> {
  const { rows } = await query<Row>(
    `INSERT INTO compliance_reviews (control_id, library_version, decision, note, reviewer_id, reviewer_label)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [r.controlId, r.libraryVersion, r.decision, r.note, r.reviewerId, r.reviewerLabel],
  );
  return toReview(rows[0]!);
}

const toReview = (r: Row): ReviewRecord & { id: string } => ({
  id: r['id'] as string,
  controlId: r['control_id'] as string,
  libraryVersion: r['library_version'] as string,
  decision: r['decision'] as ReviewDecision,
  note: r['note'] as string,
  reviewerLabel: r['reviewer_label'] as string,
  createdAt: (r['created_at'] as Date).toISOString(),
});

export async function listReviews(controlId?: string): Promise<(ReviewRecord & { id: string })[]> {
  const { rows } = await query<Row>(
    `SELECT * FROM compliance_reviews WHERE ($1::text IS NULL OR control_id = $1) ORDER BY created_at DESC LIMIT 1000`,
    [controlId ?? null],
  );
  return rows.map(toReview);
}

export interface PackMeta {
  id: string;
  apiId: string | null;
  targetName: string;
  libraryVersion: string;
  manifestSha256: string;
  zipSha256: string;
  sizeBytes: number;
  fileCount: number;
  basis: string;
  summary: unknown;
  createdBy: string | null;
  createdByLabel: string;
  createdAt: string;
}

const toPack = (r: Row): PackMeta => ({
  id: r['id'] as string,
  apiId: (r['api_id'] as string | null) ?? null,
  targetName: r['target_name'] as string,
  libraryVersion: r['library_version'] as string,
  manifestSha256: r['manifest_sha256'] as string,
  zipSha256: r['zip_sha256'] as string,
  sizeBytes: Number(r['size_bytes']),
  fileCount: Number(r['file_count']),
  basis: r['basis'] as string,
  summary: r['summary'],
  createdBy: (r['created_by'] as string | null) ?? null,
  createdByLabel: r['created_by_label'] as string,
  createdAt: (r['created_at'] as Date).toISOString(),
});

export async function insertPack(p: {
  id: string;
  apiId: string;
  targetName: string;
  libraryVersion: string;
  manifestSha256: string;
  zipSha256: string;
  fileCount: number;
  basis: string;
  summary: unknown;
  zip: Buffer;
  createdBy: string | null;
  createdByLabel: string;
}): Promise<PackMeta> {
  const { rows } = await query<Row>(
    `INSERT INTO compliance_evidence_packs
       (id, api_id, target_name, library_version, manifest_sha256, zip_sha256, size_bytes, file_count, basis, summary, zip, created_by, created_by_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, api_id, target_name, library_version, manifest_sha256, zip_sha256, size_bytes, file_count, basis, summary, created_by, created_by_label, created_at`,
    [
      p.id,
      p.apiId,
      p.targetName,
      p.libraryVersion,
      p.manifestSha256,
      p.zipSha256,
      p.zip.length,
      p.fileCount,
      p.basis,
      JSON.stringify(p.summary),
      p.zip,
      p.createdBy,
      p.createdByLabel,
    ],
  );
  return toPack(rows[0]!);
}

const META_COLS = `id, api_id, target_name, library_version, manifest_sha256, zip_sha256, size_bytes, file_count, basis, summary, created_by, created_by_label, created_at`;

export async function listPacks(limit = 50): Promise<PackMeta[]> {
  const { rows } = await query<Row>(
    `SELECT ${META_COLS} FROM compliance_evidence_packs ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 200)],
  );
  return rows.map(toPack);
}

export async function getPack(id: string): Promise<(PackMeta & { zip: Buffer }) | null> {
  const { rows } = await query<Row>(
    `SELECT ${META_COLS}, zip FROM compliance_evidence_packs WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  return r ? { ...toPack(r), zip: r['zip'] as Buffer } : null;
}

export async function findPackByManifest(sha: string): Promise<PackMeta | null> {
  const { rows } = await query<Row>(
    `SELECT ${META_COLS} FROM compliance_evidence_packs WHERE manifest_sha256 = $1 ORDER BY created_at LIMIT 1`,
    [sha],
  );
  return rows[0] ? toPack(rows[0]) : null;
}
