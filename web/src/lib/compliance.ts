import { useQuery } from '@tanstack/react-query';
import { downloadWithAuth, fetchBlob, postBinary, req, type Wrapped } from './api';

/** Compliance evidence client (Phase 28). Mirrors src/loadtest/compliance/*. */

export type Framework = 'PCI_DSS_4_0_1' | 'OWASP_API_2023' | 'BOG' | 'GH_DPA_843';
export type ControlStatus = 'EVIDENCED' | 'EVIDENCED_STALE' | 'PARTIAL' | 'SIMULATOR_ONLY' | 'NOT_TESTED' | 'FAILING' | 'OUT_OF_SCOPE';
export type ReviewStatus = 'DRAFT' | 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGE' | 'STALE_REVIEW';
export type ReviewDecision = 'APPROVED' | 'REJECTED' | 'NEEDS_CHANGE';

export interface Control {
  id: string;
  framework: Framework;
  ref: string;
  title: string;
  intent: string;
  refVerified: boolean;
  scope: 'testable' | 'partial' | 'out_of_scope';
  limitation: string;
  howToCover?: string;
}
export interface EvidenceItem {
  label: string;
  kind: 'check' | 'load';
  subject: string;
  outcome: 'PASS' | 'STALE' | 'SIM_ONLY' | 'MISSING' | 'FAIL';
  runId?: string;
  runKind?: 'correctness' | 'security' | 'load';
  finishedAt?: string;
  environment?: string | null;
  detail: string;
}
export interface ControlAssessment {
  control: Control;
  status: ControlStatus;
  coverage: Control['scope'];
  items: EvidenceItem[];
  review: { status: ReviewStatus; reviewer?: string; at?: string; note?: string; libraryVersion?: string };
  statement: string;
}
export interface FrameworkSummary {
  framework: Framework;
  name: string;
  note: string;
  total: number;
  byStatus: Record<ControlStatus, number>;
  evidencedShare: number;
  reviewedApproved: number;
  unverifiedReferences: number;
}
export interface Assessment {
  libraryVersion: string;
  asOf: string;
  maxAgeDays: number;
  basis: 'none' | 'simulator' | 'real' | 'mixed';
  controls: ControlAssessment[];
  frameworks: FrameworkSummary[];
}
export interface AssessmentResponse {
  meta: { targetId: string; target: { name: string; host: string }; generatedAt: string };
  assessment: Assessment;
  reviews: { id: string; controlId: string; decision: ReviewDecision; note: string; reviewerLabel: string; createdAt: string; libraryVersion: string }[];
  disclaimer: string;
}
export interface PackMeta {
  id: string;
  targetName: string;
  libraryVersion: string;
  manifestSha256: string;
  zipSha256: string;
  sizeBytes: number;
  fileCount: number;
  basis: string;
  createdByLabel: string;
  createdAt: string;
}
export interface PackVerification {
  ok: boolean;
  verdict: 'AUTHENTIC' | 'INTACT_BUT_NOT_ISSUED_HERE' | 'TAMPERED' | 'INVALID';
  manifestSha256: string | null;
  packId: string | null;
  fileCount: number;
  problems: string[];
  issued: { id: string; createdAt: string; createdByLabel: string; targetName: string; libraryVersion: string } | null;
}

export const complianceApi = {
  library: () => req<Wrapped<{ libraryVersion: string; disclaimer: string; frameworks: Record<Framework, { name: string; short: string; note: string }> }>>('/compliance/library').then((r) => r.data),
  assessment: (apiId: string) => req<Wrapped<AssessmentResponse>>(`/compliance/assessment/${apiId}`).then((r) => r.data),
  review: (controlId: string, decision: ReviewDecision, note: string) =>
    req<Wrapped<unknown>>(`/compliance/controls/${controlId}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }).then((r) => r.data),
  packs: () => req<Wrapped<PackMeta[]>>('/compliance/packs').then((r) => r.data),
  createPack: (apiId: string) => req<Wrapped<PackMeta>>('/compliance/packs', { method: 'POST', body: JSON.stringify({ apiId }) }).then((r) => r.data),
  verify: (file: File) => postBinary<Wrapped<PackVerification>>('/compliance/packs/verify', file, 'application/zip').then((r) => r.data),
};

export type MatrixFormat = 'html' | 'pdf' | 'xlsx' | 'csv';

export const downloadMatrix = (apiId: string, format: MatrixFormat): Promise<void> =>
  downloadWithAuth(`/compliance/assessment/${apiId}?format=${format}`, `compliance-matrix.${format}`);

export async function openMatrixHtml(apiId: string): Promise<void> {
  const blob = await fetchBlob(`/compliance/assessment/${apiId}?format=html`);
  const url = URL.createObjectURL(new Blob([blob], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const downloadPack = (p: PackMeta): Promise<void> =>
  downloadWithAuth(`/compliance/packs/${p.id}/download`, `evidence-pack-${p.id.slice(0, 8)}.zip`);

export const usePacks = () => useQuery({ queryKey: ['cmp-packs'], queryFn: complianceApi.packs, refetchInterval: 30_000 });
