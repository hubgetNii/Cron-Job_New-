import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.js';
import {
  buildReport,
  renderReport,
  REPORT_CONTENT_TYPE,
} from '../../services/reporting/reports.service.js';

/**
 * Advanced report types (spec §15). SLA / compliance live in sla.routes.ts.
 * Every report is a period query rendered as JSON, CSV, Excel or PDF.
 */
export const reportsRouter: Router = Router();

const REPORT_TYPES = [
  'system-health',
  'api-performance',
  'failure',
  'incident',
  'dependency',
  'latency',
  'security',
  'executive',
] as const;

const canRead = requireRole('OPERATOR', 'ADMIN', 'COMPLIANCE', 'MANAGEMENT', 'DEVELOPER');

const EXT: Record<'csv' | 'xlsx' | 'pdf', string> = { csv: 'csv', xlsx: 'xlsx', pdf: 'pdf' };

const q = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).optional(),
});

reportsRouter.get('/reports/catalog', canRead, (_req: Request, res: Response) => {
  res.json({
    data: REPORT_TYPES.map((t) => ({ type: t })),
    note: 'GET /reports/{type}?from=&to=&format=json|csv|xlsx|pdf',
  });
});

reportsRouter.get('/reports/:type', canRead, async (req: Request, res: Response) => {
  const type = z.enum(REPORT_TYPES).parse(req.params.type);
  const { from, to, format } = q.parse(req.query);
  const toDate = to ?? new Date();
  const fromDate = from ?? new Date(toDate.getTime() - 30 * 86_400_000);
  if (fromDate >= toDate) {
    res.status(422).json({ error: { code: 'VALIDATION', message: 'from must be before to' } });
    return;
  }

  const report = await buildReport(type, fromDate, toDate);

  if (format && format !== 'json') {
    const body = await renderReport(report, format);
    res.setHeader('content-type', REPORT_CONTENT_TYPE[format]);
    res.setHeader(
      'content-disposition',
      `attachment; filename="${type}-report-${fromDate.toISOString().slice(0, 10)}_${toDate
        .toISOString()
        .slice(0, 10)}.${EXT[format]}"`,
    );
    res.send(body);
    return;
  }
  res.json({ data: report });
});
