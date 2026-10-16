import { randomUUID } from 'node:crypto';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';
import { SimError, Simulator, type Reply } from './simulator.js';

/**
 * HTTP surface of the simulator. `/v1/*` mirrors the documented iSmartPay
 * developer API (bare response objects, `{items}` lists, `{error:{code,message}}`
 * errors, `Request-Id` on every response); `/__sim/*` is the control plane
 * (reconfigure faults, reset, inspect the ledger) and is only ever bound to
 * loopback by `main.ts`.
 */
export function createSimulatorApp(sim: Simulator = new Simulator()): {
  app: Express;
  sim: Simulator;
} {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  /* ── control plane ───────────────────────────────────────────────────── */
  app.get('/__sim/config', (_req, res) => void res.json({ data: sim.config }));
  app.put('/__sim/config', (req, res) => void res.json({ data: sim.patchConfig(req.body) }));
  app.post('/__sim/reset', (req, res) => {
    sim.reset(req.body ?? {});
    res.json({ data: sim.config });
  });
  app.put('/__sim/wallets/:id', (req, res) => {
    const b = z.object({ balance: z.string() }).parse(req.body);
    sim.setBalance(String(req.params['id']), b.balance);
    res.json({ data: sim.state() });
  });
  app.get('/__sim/state', (_req, res) => void res.json({ data: sim.state() }));
  app.get('/__sim/health', (_req, res) => void res.json({ status: 'ok', simulator: true }));

  /* ── API ─────────────────────────────────────────────────────────────── */
  const v1 = express.Router();

  // Every response — success or failure — carries a Request-Id.
  v1.use((_req, res, next) => {
    res.setHeader('Request-Id', `req_${randomUUID().slice(0, 12)}`);
    next();
  });

  // Faults first: an injected failure happens before the request touches any state.
  v1.use(async (_req, _res, next) => {
    try {
      await sim.applyFaults();
      next();
    } catch (e) {
      next(e);
    }
  });

  v1.post('/oauth/token', (req, res) => {
    sim.takeRateToken(`ip:${req.ip ?? 'unknown'}`);
    if (!req.is('application/x-www-form-urlencoded')) {
      throw new SimError(
        'invalid_input',
        'the token endpoint takes application/x-www-form-urlencoded',
      );
    }
    res.json(sim.issueToken(req.body));
  });

  // Everything below needs a bearer token; rate limiting is per credential.
  v1.use((req, res, next) => {
    try {
      const cred = sim.authenticate(req.header('authorization'));
      sim.takeRateToken(`cred:${cred}`);
      res.locals['cred'] = cred;
      next();
    } catch (e) {
      next(e);
    }
  });

  const cred = (res: Response): string => res.locals['cred'] as string;
  const send = (res: Response, r: Reply): void => void res.status(r.status).json(r.body);
  const get = (path: string, fn: (req: Request, res: Response) => unknown): void => {
    v1.get(path, (req, res) => void res.json(fn(req, res)));
  };

  /**
   * Every POST needs an Idempotency-Key. After the idempotent run, an
   * "ambiguous timeout" may replace the reply with a 504 even though the effect
   * was applied — retrying with the same key must replay the real result.
   */
  const post = (
    path: string,
    fn: (c: string, body: unknown, req: Request) => Reply | Promise<Reply>,
  ): void => {
    const h: RequestHandler = async (req, res) => {
      const body: unknown = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body))
        throw new SimError('invalid_input', 'body must be a JSON object');
      const reply = await sim.idempotent(cred(res), req.header('idempotency-key'), body, async () =>
        fn(cred(res), body, req),
      );
      if (reply.status < 500 && sim.shouldAmbiguousTimeout()) {
        throw new SimError('upstream_timeout', 'internal server error');
      }
      send(res, reply);
    };
    v1.post(path, h);
  };

  // Money-moving
  post('/collections', (c, b) => sim.createCollection(c, b));
  post('/payouts', (c, b) => sim.createPayout(c, b));
  post('/payout-batches', (c, b) => sim.createPayoutBatch(c, b));
  post('/utility-purchases', (c, b) => sim.createUtilityPurchase(c, b));
  post('/transfers', (c, b) => sim.createTransfer(c, b));
  post('/checkouts', (c, b) => sim.createCheckout(c, b));
  post('/checkouts/:id/cancel', (c, _b, req) => sim.cancelCheckout(c, String(req.params['id'])));
  post('/settlements', (c, b) => sim.settleNow(c, b));
  post('/settlements/:id/resettlements', (c, _b, req) => sim.retryRun(c, String(req.params['id'])));

  // Reads by reference
  const byRef = (
    path: string,
    kind: 'collection' | 'payout' | 'utility_purchase' | 'transfer',
  ): void =>
    get(`/${path}/:reference`, (req, res) =>
      sim.viewFor(sim.getTx(cred(res), kind, String(req.params['reference']))),
    );
  byRef('collections', 'collection');
  byRef('payouts', 'payout');
  byRef('utility-purchases', 'utility_purchase');
  byRef('transfers', 'transfer');

  get('/checkouts', (_req, res) => sim.listCheckouts(cred(res)));
  get('/checkouts/:id', (req, res) => sim.getCheckout(cred(res), String(req.params['id'])));
  get('/settlements', (_req, res) => sim.listRuns(cred(res)));
  get('/settlements/latest', (_req, res) => sim.getRun(cred(res), 'latest'));
  get('/settlements/:id', (req, res) => sim.getRun(cred(res), String(req.params['id'])));
  get('/settlement-policy', () => sim.getPolicy());
  v1.put('/settlement-policy', async (req, res) => {
    const body: unknown = req.body ?? {};
    const reply = await sim.idempotent(cred(res), req.header('idempotency-key'), body, () =>
      Promise.resolve({ status: 200, body: sim.putPolicy(body) }),
    );
    send(res, reply);
  });
  v1.delete('/settlement-policy', (_req, res) => void res.json(sim.deletePolicy()));

  get('/wallet', (_req, res) => sim.wallet(cred(res)));
  get('/limits', (_req, res) => sim.limits(cred(res)));
  get('/payment-methods', () => sim.paymentMethods());
  get('/utility-products', () => sim.utilityProducts());
  get('/party-lookups', (req) => {
    const q = z
      .object({ provider: z.enum(['mtn', 'telecel']), partyValue: z.string().min(1).max(32) })
      .safeParse(req.query);
    if (!q.success)
      throw new SimError('invalid_input', 'provider (mtn|telecel) and partyValue are required');
    return {
      provider: q.data.provider,
      partyValue: q.data.partyValue,
      name: 'SIMULATED HOLDER',
      active: true,
    };
  });
  get('/recipients/:handle', (req, res) => sim.recipient(String(req.params['handle']), cred(res)));
  get('/transactions', (req, res) => {
    const q = z
      .object({
        kind: z
          .enum(['collection', 'payout', 'settlement', 'utility', 'wallet_transfer'])
          .optional(),
        status: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(512).optional(),
      })
      .safeParse(req.query);
    if (!q.success) throw new SimError('invalid_input', 'invalid query parameters');
    return sim.transactions(cred(res), q.data);
  });
  get('/events', (req, res) => {
    const q = z
      .object({
        after: z.string().max(128).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .safeParse(req.query);
    if (!q.success) throw new SimError('invalid_input', 'invalid query parameters');
    return sim.listEvents(cred(res), q.data.after, q.data.limit);
  });
  for (const kind of ['collections', 'payouts']) {
    get(`/fee-quotes/${kind}`, (req) => sim.feeQuote(req.query));
  }
  get('/fee-quotes/utilities', (req) => sim.utilityFeeQuote(req.query));

  app.use('/v1', v1);
  app.use((_req, _res, next) => next(new SimError('not_found', 'unknown route')));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (!res.getHeader('Request-Id'))
      res.setHeader('Request-Id', `req_${randomUUID().slice(0, 12)}`);
    if (err instanceof SimError) {
      for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      res.status(err.status).json(err.body);
      return;
    }
    if (err instanceof z.ZodError || err instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'invalid_input', message: 'request is malformed' } });
      return;
    }
    const leak = sim.config.weak.verboseErrors && err instanceof Error ? err.stack : undefined;
    res.status(500).json({ error: { code: 'internal', message: leak ?? 'internal server error' } });
  });

  return { app, sim };
}
