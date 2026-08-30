import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { hashPassword } from '../lib/crypto/passwords.js';
import { createUser, findUserByEmail } from '../repositories/users.repo.js';
import { closePool } from '../lib/db.js';
import { RBAC_ROLES, type RbacRole } from '../domain/enums.js';

/* eslint-disable no-console */

async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const email = (await rl.question('Email: ')).trim().toLowerCase();
    const fullName = (await rl.question('Full name: ')).trim() || 'Admin';
    const password = (await rl.question('Password (min 8): ')).trim();
    const roleInput =
      (await rl.question(`Roles [${RBAC_ROLES.join(',')}] (default ADMIN): `)).trim() || 'ADMIN';

    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    if (await findUserByEmail(email)) throw new Error(`A user with ${email} already exists`);

    const roles = roleInput
      .split(/[,\s]+/)
      .map((r) => r.toUpperCase())
      .filter((r): r is RbacRole => (RBAC_ROLES as readonly string[]).includes(r));
    if (roles.length === 0) throw new Error('No valid roles given');

    const user = await createUser({
      email,
      fullName,
      passwordHash: await hashPassword(password),
      roles,
    });
    console.log(`\nCreated ${user.email} with roles: ${user.roles.join(', ')}`);
  } finally {
    rl.close();
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
