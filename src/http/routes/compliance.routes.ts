import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { actorFromRequest } from '../actor.js';
import { ValidationError } from '../../lib/errors.js';
import { CONTROLS, FRAMEWORKS, LIBRARY_VERSION } from '../../loadtest/compliance/controls.js';
import {
  DISCLAIMER,
  renderMatrixCsv,
  renderMatrixHtml,
  renderMatrixPdf,
  renderMatrixXlsx,
} from '../../loadtest/compliance/exporters.js';
import * as repo from '../../repositories/compliance.repo.js';
import {
  assessTarget,
  createEvidencePack,
  packDownload,
  reviewControl,
  verifyUploadedPack,
} from '../../services/loadtest/compliance.service.js';

/**
 * Compliance evidence (Phase 28). Reads are open to the roles that read reports.
 * SEPARATION OF DUTIES: only the COMPLIANCE role can approve or reject a control
 * mapping — ADMIN deliberately cannot, so the people who run the tests are never
 * the people who sign off what they prove.
 */
export const complianceRouter: Router = Router();

const canRead = requireRole('ADMIN', 'COMPLIANCE', 'MANAGEMENT', 'OPERATOR', 'DEVELOPER');
const canIssue = requireRole('ADMIN', 'COMPLIANCE');
const complianceOnly = requireRole('COMPLIANCE');
const idParam = z.string().uuid();

complianceRouter.get('/compliance/library', canRead, (_req: Request, res: Response) => {
  res.json({
    data: {
      libraryVersion: LIBRARY_VERSION,
      disclaimer: DISCLAIMER,
      frameworks: FRAMEWORKS,
      controls: CONTROLS,
    },
  });
});

const assessQuery = z.object({
  format: z.enum(['json', 'html', 'xlsx', 'csv', 'pdf']).default('json'),
  maxAgeDays: z.coerce.number().int().min(1).max(730).optional(),
});

complianceRouter.get(
  '/compliance/assessment/:apiId',
  canRead,
  async (req: Request, res: Response) => {
    const apiId = idParam.parse(req.params.apiId);
    const q = assessQuery.parse(req.query);
    const ctx = await assessTarget(apiId, new Date(), q.maxAgeDays);
    const base = `compliance-matrix-${apiId.slice(0, 8)}`;
    if (q.format === 'json') {
      res.json({
        data: {
          meta: ctx.meta,
          assessment: ctx.assessment,
          reviews: ctx.reviews,
          disclaimer: DISCLAIMER,
        },
      });
      return;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${q.format}"`);
    if (q.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
      res.send(renderMatrixHtml(ctx.assessment, ctx.meta, ctx.reviews));
    } else if (q.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(renderMatrixCsv(ctx.assessment, ctx.meta));
    } else if (q.format === 'xlsx') {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.send(await renderMatrixXlsx(ctx.assessment, ctx.meta, ctx.reviews));
    } else {
      res.setHeader('Content-Type', 'application/pdf');
      res.send(await renderMatrixPdf(ctx.assessment, ctx.meta, ctx.reviews));
    }
  },
);

const reviewBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED', 'NEEDS_CHANGE']),
  note: z.string().min(1).max(2000),
});

/** Append-only sign-off on one control's mapping, for the current library version. */
complianceRouter.post(
  '/compliance/controls/:id/review',
  complianceOnly,
  async (req: Request, res: Response) => {
    const body = reviewBody.parse(req.body);
    const saved = await reviewControl(
      String(req.params.id),
      body.decision,
      body.note,
      actorFromRequest(req),
    );
    res.status(201).json({ data: saved });
  },
);

complianceRouter.get('/compliance/reviews', canRead, async (req: Request, res: Response) => {
  const q = z.object({ controlId: z.string().max(60).optional() }).parse(req.query);
  res.json({ data: await repo.listReviews(q.controlId) });
});

complianceRouter.post('/compliance/packs', canIssue, async (req: Request, res: Response) => {
  const { apiId } = z.object({ apiId: z.string().uuid() }).parse(req.body);
  res.status(201).json({ data: await createEvidencePack(apiId, actorFromRequest(req)) });
});

complianceRouter.get('/compliance/packs', canRead, async (_req: Request, res: Response) => {
  res.json({ data: await repo.listPacks() });
});

complianceRouter.get(
  '/compliance/packs/:id/download',
  canRead,
  async (req: Request, res: Response) => {
    const { meta, zip } = await packDownload(idParam.parse(req.params.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="evidence-pack-${meta.id.slice(0, 8)}.zip"`,
    );
    res.setHeader('X-Manifest-Sha256', meta.manifestSha256);
    res.send(zip);
  },
);

/**
 * Upload a pack (raw zip body) to check it: intact? edited? issued by us? The
 * answer AUTHENTIC means the bytes are untouched AND this system recorded issuing it.
 */
complianceRouter.post(
  '/compliance/packs/verify',
  canRead,
  express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '25mb' }),
  async (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError('Send the pack as a raw body with Content-Type: application/zip.');
    }
    res.json({ data: await verifyUploadedPack(new Uint8Array(body)) });
  },
);
