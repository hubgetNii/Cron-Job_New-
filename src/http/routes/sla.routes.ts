import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import { ValidationError } from '../../lib/errors.js';
import { reportsForTarget, slaSummary } from '../../repositories/sla-reports.repo.js';
import { runSlaReports } from '../../services/reporting/sla.service.js';
import {
  buildComplianceReport,
  incidentsToCsv,
} from '../../services/reporting/compliance.service.js';

export const slaRouter: Router = Router();

const idParam = z.string().uuid();

slaRouter.get('/sla/summary', async (_req: Request, res: Response) => {
  const rows = await slaSummary();
  res.json({
    data: {
      targets: rows,
      meeting: rows.filter((r) => r.slaMet).length,
      breaching: rows.filter((r) => !r.slaMet).length,
    },
    count: rows.length,
  });
});

slaRouter.get('/sla/:targetId', async (req: Request, res: Response) => {
  const reports = await reportsForTarget(idParam.parse(req.params.targetId));
  res.json({ data: reports, count: reports.length });
});

slaRouter.post(
  '/sla/refresh',
  requireRole('ADMIN', 'COMPLIANCE'),
  async (_req: Request, res: Response) => {
    const result = await runSlaReports();
    res.json({ data: result });
  },
);

const rangeQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

slaRouter.get(
  '/reports/compliance',
  requireRole('COMPLIANCE', 'MANAGEMENT', 'ADMIN'),
  async (req: Request, res: Response) => {
    const q = rangeQuery.parse(req.query);
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    if (from >= to) throw new ValidationError('`from` must be before `to`');

    const report = await buildComplianceReport(from, to);

    if (q.format === 'csv') {
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader(
        'content-disposition',
        `attachment; filename="compliance-incidents-${from.toISOString().slice(0, 10)}_${to
          .toISOString()
          .slice(0, 10)}.csv"`,
      );
      res.send(incidentsToCsv(report));
      return;
    }
    res.json({ data: report });
  },
);
