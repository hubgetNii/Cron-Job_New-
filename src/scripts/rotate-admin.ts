import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../lib/crypto/passwords.js';
import { createUser, findUserByEmail } from '../repositories/users.repo.js';
import { query, closePool } from '../lib/db.js';

/* eslint-disable no-console */

/**
 * Provisions a fresh ADMIN with a strong generated password and removes the
 * well-known local test accounts (`admin@admin.local`, `admin@ismartpay.local`).
 * Prints the password once — it is not stored anywhere retrievable.
 *
 *   npm run rotate-admin -- admin@yourorg.com
 */
async function main(): Promise<void> {
  const email = (process.argv[2] ?? '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    throw new Error('Usage: npm run rotate-admin -- <email>');
  }

  if (await findUserByEmail(email)) {
    console.log(`${email} already exists — not recreating.`);
  } else {
    const password = randomBytes(18).toString('base64url'); // 24 url-safe chars
    const user = await createUser({
      email,
      fullName: 'Platform Admin',
      passwordHash: await hashPassword(password),
      roles: ['ADMIN'],
    });
    console.log(`\n  created  ${user.email}  (roles: ${user.roles.join(', ')})`);
    console.log(`  password ${password}`);
    console.log(`  ^ save this now — it is shown once and stored only as a hash\n`);
  }

  const del = await query<{ email: string }>(
    `DELETE FROM users WHERE email IN ('admin@admin.local', 'admin@ismartpay.local')
       AND email <> $1
     RETURNING email`,
    [email],
  );
  console.log(`  removed test accounts: ${del.rows.map((r) => r.email).join(', ') || 'none'}`);

  const left = await query<{ email: string }>(`SELECT email FROM users ORDER BY email`);
  console.log(`  users now: ${left.rows.map((r) => r.email).join(', ')}`);

  const admins = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM users u
     JOIN user_roles ur ON ur.user_id = u.id
     JOIN roles r ON r.id = ur.role_id
     WHERE r.key = 'ADMIN' AND u.status = 'active'`,
  );
  if (Number(admins.rows[0]?.n ?? '0') === 0) {
    console.error('\n  WARNING: no active ADMIN remains. Re-run with a valid email.');
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
