import { createHash } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env, isProduction } from '../../config/index.js';
import { componentLogger } from '../../lib/logger.js';
import type { RbacRole } from '../../domain/enums.js';

const log = componentLogger('jwt');
const ISSUER = 'fintech-cron-monitor';
const AUDIENCE = 'fintech-cron-monitor/api';

let secret: Uint8Array | undefined;

function key(): Uint8Array {
  if (secret) return secret;
  const raw = env().JWT_SECRET;
  if (raw) {
    secret = new TextEncoder().encode(raw);
    return secret;
  }
  if (isProduction()) throw new Error('JWT_SECRET is required in production');
  log.warn('JWT_SECRET not set — using an insecure development signing key');
  secret = new TextEncoder().encode('fintech-cron-monitor-dev-jwt-secret-key-please-change');
  return secret;
}

export interface AccessClaims {
  sub: string;
  email: string;
  roles: RbacRole[];
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ email: claims.email, roles: claims.roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env().ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: AUDIENCE });
  const p = payload as JWTPayload & { email?: unknown; roles?: unknown };
  if (typeof p.sub !== 'string' || typeof p.email !== 'string' || !Array.isArray(p.roles)) {
    throw new Error('malformed access token');
  }
  return { sub: p.sub, email: p.email, roles: p.roles as RbacRole[] };
}

/** Opaque refresh tokens are stored only as a hash. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
