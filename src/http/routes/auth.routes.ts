import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { loginRateLimit } from '../middleware/rate-limit.js';
import {
  getMe,
  login,
  logout,
  refresh,
  type RequestMeta,
} from '../../services/auth/auth.service.js';
import { UnauthorizedError } from '../../lib/errors.js';

export const authRouter: Router = Router();

function meta(req: Request): RequestMeta {
  return { userAgent: req.header('user-agent') ?? null, ip: req.ip ?? null };
}

const loginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const refreshBody = z.object({ refreshToken: z.string().min(1) });

authRouter.post('/auth/login', loginRateLimit(), async (req: Request, res: Response) => {
  const { email, password } = loginBody.parse(req.body);
  const result = await login(email, password, meta(req));
  res.json({ data: result });
});

authRouter.post('/auth/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = refreshBody.parse(req.body);
  const result = await refresh(refreshToken, meta(req));
  res.json({ data: result });
});

authRouter.post('/auth/logout', authenticate, async (req: Request, res: Response) => {
  if (req.user) await logout(req.user.id);
  res.status(204).send();
});

authRouter.get('/auth/me', authenticate, async (req: Request, res: Response) => {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  res.json({ data: await getMe(req.user.id) });
});
