import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/crypto/passwords.js';
import {
  createUser,
  findUserByEmail,
  revokeUserTokens,
} from '../repositories/users.repo.js';
import { query, closePool } from '../lib/db.js';

/* eslint-disable no-console */

/**
 * Locks down the admin accounts before public exposure:
 *  - ensures `<email>` is an ADMIN with a fresh, strong, generated password
 *    (created if missing, password-reset if it already exists),
 *  - disables the well-known local test accounts (`admin@admin.local`,
 *    `admin@ismartpay.local`) — disabled, not deleted, so audit and
 *    config-change-request history stay intact,
 *  - revokes every refresh token for any account it touches.
 *
 * The generated password is printed once and stored only as a hash.
 *
 *   npm run rotate-admin -- admin@yourorg.com
 */
const TEST_ACCOUNTS = ['admin@admin.local', 'admin@ismartpay.local'];

async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Usage: npm run rotate-admin -- <email>');

  const password = randomBytes(18).toString('base64url'); // 24 url-safe chars
  const passwordHash = await hashPassword(password);

  const existing = await findUserByEmail(email);
  if (existing) {
    await query(`UPDATE users SET password_hash = $1, status = 'active' WHERE id = $2`, [
      passwordHash,
      existing.id,
    ]);
    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE key = 'ADMIN' ON CONFLICT DO NOTHING`,
      [existing.id],
    );
    await revokeUserTokens(existing.id);
    console.log(`\n  reset     ${email}  (password rotated, ADMIN ensured, sessions revoked)`);
  } else {
    const user = await createUser({ email, fullName: 'Platform Admin', passwordHash, roles: ['ADMIN'] });
    console.log(`\n  created   ${user.email}  (roles: ${user.roles.join(', ')})`);
  }
  console.log(`  password  ${password}`);
  console.log(`  ^ save this now — shown once, stored only as a hash\n`);

  const disabled = await query<{ email: string }>(
    `UPDATE users SET status = 'disabled'
     WHERE email = ANY($1) AND email <> $2
     RETURNING id, email`,
    [TEST_ACCOUNTS, email],
  );
  for (const row of disabled.rows as unknown as { id: string; email: string }[]) {
    await revokeUserTokens(row.id);
  }
  console.log(`  disabled test accounts: ${disabled.rows.map((r) => r.email).join(', ') || 'none'}`);

  const active = await query<{ email: string; roles: string[] }>(
    `SELECT u.email, coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS roles
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     WHERE u.status = 'active'
     GROUP BY u.email ORDER BY u.email`,
  );
  console.log(`  active users now:`);
  for (const u of active.rows) console.log(`    ${u.email}  [${u.roles.join(', ')}]`);

  const admins = active.rows.filter((u) => u.roles.includes('ADMIN')).length;
  if (admins === 0) {
    console.error('\n  ERROR: no active ADMIN remains.');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
