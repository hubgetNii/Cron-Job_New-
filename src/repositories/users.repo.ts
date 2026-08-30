import { query, withTransaction } from '../lib/db.js';
import type { RbacRole, UserStatus } from '../domain/enums.js';

export interface User {
  id: string;
  email: string;
  fullName: string;
  status: UserStatus;
  teamId: string | null;
  roles: RbacRole[];
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  status: UserStatus;
  team_id: string | null;
  password_hash: string | null;
  roles: RbacRole[] | null;
  created_at: Date;
}

function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    status: r.status,
    teamId: r.team_id,
    roles: (r.roles ?? []).filter(Boolean),
    createdAt: r.created_at,
  };
}

const SELECT = `
  SELECT u.id, u.email, u.full_name, u.status, u.team_id, u.password_hash, u.created_at,
         array_remove(array_agg(r.key), NULL) AS roles
  FROM users u
  LEFT JOIN user_roles ur ON ur.user_id = u.id
  LEFT JOIN roles r ON r.id = ur.role_id`;

export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string | null }) | null> {
  const { rows } = await query<UserRow>(`${SELECT} WHERE u.email = $1 GROUP BY u.id`, [email]);
  return rows[0] ? { ...toUser(rows[0]), passwordHash: rows[0].password_hash } : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await query<UserRow>(`${SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return rows[0] ? toUser(rows[0]) : null;
}

export async function countUsers(): Promise<number> {
  const { rows } = await query<{ n: string }>(`SELECT count(*) n FROM users`);
  return Number(rows[0]?.n ?? 0);
}

export async function createUser(input: {
  email: string;
  fullName: string;
  passwordHash: string;
  roles: RbacRole[];
}): Promise<User> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO users (email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'active') RETURNING id, created_at`,
      [input.email, input.fullName, input.passwordHash],
    );
    const id = rows[0]!.id;
    for (const roleKey of input.roles) {
      await client.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT $1, id FROM roles WHERE key = $2
         ON CONFLICT DO NOTHING`,
        [id, roleKey],
      );
    }
    const user = await findUserById(id);
    return user!;
  });
}

export async function updateLastLogin(id: string): Promise<void> {
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
}

/* --- refresh tokens ---------------------------------------------------- */

export interface StoredRefreshToken {
  id: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedBy: string | null;
}

export async function storeRefreshToken(input: {
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.userId, input.tokenHash, input.familyId, input.expiresAt, input.userAgent, input.ip],
  );
  return rows[0]!.id;
}

export async function findRefreshToken(tokenHash: string): Promise<StoredRefreshToken | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by
     FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r['id'] as string,
    userId: r['user_id'] as string,
    familyId: r['family_id'] as string,
    expiresAt: r['expires_at'] as Date,
    revokedAt: (r['revoked_at'] as Date | null) ?? null,
    replacedBy: (r['replaced_by'] as string | null) ?? null,
  };
}

export async function rotateRefreshToken(
  oldId: string,
  next: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
    userAgent: string | null;
    ip: string | null;
  },
): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [next.userId, next.tokenHash, next.familyId, next.expiresAt, next.userAgent, next.ip],
    );
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
      [oldId, rows[0]!.id],
    );
  });
}

/** Reuse detection: a revoked token was presented → burn the whole family. */
export async function revokeTokenFamily(familyId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE family_id = $1`,
    [familyId],
  );
}

export async function revokeUserTokens(userId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE user_id = $1`,
    [userId],
  );
}

export async function pruneExpiredRefreshTokens(): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens WHERE expires_at < now() - interval '7 days'`,
  );
  return rowCount ?? 0;
}
