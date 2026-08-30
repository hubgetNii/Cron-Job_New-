import { randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/crypto/passwords.js';
import { recordAudit } from '../audit/audit.service.js';
import {
  countUsers,
  createUser,
  findRefreshToken,
  findUserByEmail,
  findUserById,
  revokeTokenFamily,
  revokeUserTokens,
  rotateRefreshToken,
  storeRefreshToken,
  updateLastLogin,
  type User,
} from '../../repositories/users.repo.js';
import { hashToken, signAccessToken } from './jwt.js';

const log = componentLogger('auth');

export interface RequestMeta {
  userAgent: string | null;
  ip: string | null;
}

export interface AuthResult {
  user: User;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function newRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env().REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function issue(user: User, familyId: string, meta: RequestMeta): Promise<AuthResult> {
  const raw = newRefreshToken();
  await storeRefreshToken({
    userId: user.id,
    tokenHash: hashToken(raw),
    familyId,
    expiresAt: refreshExpiry(),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return {
    user,
    accessToken: await signAccessToken({ sub: user.id, email: user.email, roles: user.roles }),
    refreshToken: raw,
    expiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function login(
  email: string,
  password: string,
  meta: RequestMeta,
): Promise<AuthResult> {
  const record = await findUserByEmail(email.toLowerCase());
  // Always run a hash comparison so timing doesn't reveal whether the email exists.
  const ok =
    record?.passwordHash != null
      ? await verifyPassword(password, record.passwordHash)
      : await verifyPassword(password, '$scrypt$1$1$1$AA==$AA==').then(() => false);

  if (!record || !ok || record.status !== 'active') {
    throw new UnauthorizedError('Invalid email or password');
  }

  await updateLastLogin(record.id);
  await recordAudit({
    actor: { userId: record.id, ip: meta.ip, userAgent: meta.userAgent },
    action: 'auth.login',
    entityType: 'user',
    entityId: record.id,
    summary: `${record.email} signed in`,
  });
  const { passwordHash: _ph, ...user } = record;
  return issue(user, randomUUID(), meta);
}

export async function refresh(rawToken: string, meta: RequestMeta): Promise<AuthResult> {
  const stored = await findRefreshToken(hashToken(rawToken));
  if (!stored || stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token is invalid or expired');
  }

  if (stored.revokedAt) {
    // A revoked token was replayed — treat the whole family as compromised.
    await revokeTokenFamily(stored.familyId);
    log.warn({ familyId: stored.familyId }, 'refresh token reuse detected — family revoked');
    await recordAudit({
      actor: { userId: stored.userId, ip: meta.ip },
      action: 'auth.token_reuse',
      entityType: 'user',
      entityId: stored.userId,
      summary: 'Refresh-token reuse detected; all sessions in the family revoked',
    });
    throw new UnauthorizedError('Session invalidated — please sign in again');
  }

  const user = await findUserById(stored.userId);
  if (!user || user.status !== 'active') throw new UnauthorizedError('Account is not active');

  const raw = newRefreshToken();
  await rotateRefreshToken(stored.id, {
    userId: user.id,
    tokenHash: hashToken(raw),
    familyId: stored.familyId,
    expiresAt: refreshExpiry(),
    userAgent: meta.userAgent,
    ip: meta.ip,
  });
  return {
    user,
    accessToken: await signAccessToken({ sub: user.id, email: user.email, roles: user.roles }),
    refreshToken: raw,
    expiresIn: env().ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function logout(userId: string): Promise<void> {
  await revokeUserTokens(userId);
  await recordAudit({
    actor: { userId },
    action: 'auth.logout',
    entityType: 'user',
    entityId: userId,
    summary: 'Signed out (all refresh tokens revoked)',
  });
}

export function getMe(userId: string): Promise<User | null> {
  return findUserById(userId);
}

/**
 * Creates the first ADMIN user if the users table is empty and bootstrap
 * credentials are configured. Runs once on API start.
 */
export async function bootstrapAdmin(): Promise<void> {
  if ((await countUsers()) > 0) return;
  const email = env().BOOTSTRAP_ADMIN_EMAIL;
  let password = env().BOOTSTRAP_ADMIN_PASSWORD;
  if (!email) {
    log.warn('no users and BOOTSTRAP_ADMIN_EMAIL unset — create one with `npm run create-admin`');
    return;
  }
  if (!password) {
    password = randomBytes(12).toString('base64url');
    log.warn({ email, password }, 'bootstrap admin created with a generated password — change it');
  }
  try {
    const user = await createUser({
      email: email.toLowerCase(),
      fullName: 'Bootstrap Admin',
      passwordHash: await hashPassword(password),
      roles: ['ADMIN'],
    });
    log.info({ email: user.email }, 'bootstrap ADMIN user created');
  } catch (err) {
    // Another process won the race, or the email already exists — that's fine.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return;
    }
    throw err;
  }
}
