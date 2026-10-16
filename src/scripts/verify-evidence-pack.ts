/* eslint-disable no-console */
/**
 * Verifies an evidence pack with no server and no database:
 *
 *   npm run verify:evidence-pack -- path/to/evidence-pack.zip
 *   npm run verify:evidence-pack -- path/to/evidence-pack.zip --check-issued
 *
 * Re-derives every file hash, every size, the SHA256SUMS file and the manifest
 * hash from the bytes. With --check-issued it also asks THIS system's database
 * whether it recorded issuing that exact manifest (needs DATABASE_URL).
 * Exit code 0 only when the pack is intact (and, with --check-issued, issued here).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { verifyPack } from '../loadtest/compliance/pack.js';

async function main(): Promise<number> {
  const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: npm run verify:evidence-pack -- <pack.zip> [--check-issued]');
    return 2;
  }
  const v = verifyPack(new Uint8Array(readFileSync(file)));
  console.log(`Pack:           ${v.packId ?? '(unreadable)'}`);
  console.log(`Files:          ${v.fileCount}`);
  console.log(`Manifest hash:  ${v.manifestSha256 ?? '(none)'}`);
  if (v.manifest) {
    console.log(`Target:         ${v.manifest.target.name}`);
    console.log(`Generated:      ${v.manifest.generatedAt} by ${v.manifest.generatedBy}`);
    console.log(`Evidence basis: ${v.manifest.basis}   Library: ${v.manifest.libraryVersion}`);
  }
  if (!v.ok) {
    console.log('\nRESULT: NOT INTACT');
    for (const p of v.problems) console.log(`  ✗ ${p}`);
    return 1;
  }
  console.log('\nRESULT: INTACT — every file matches the manifest and SHA256SUMS.');

  if (process.argv.includes('--check-issued')) {
    const { findPackByManifest } = await import('../repositories/compliance.repo.js');
    const { closePool } = await import('../lib/db.js');
    try {
      const issued = await findPackByManifest(v.manifestSha256!);
      if (!issued) {
        console.log('ISSUED: this system has NO record of issuing a pack with this manifest hash.');
        return 1;
      }
      console.log(
        `ISSUED: recorded ${issued.createdAt} by ${issued.createdByLabel} (pack ${issued.id}).`,
      );
    } finally {
      await closePool();
    }
  } else {
    console.log('Tip: add --check-issued to confirm this system recorded issuing it.');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
