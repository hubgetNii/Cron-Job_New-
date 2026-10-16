import { createHash } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { assemblePack, assertSafePath, sha256, verifyPack, type AssembleInput } from './pack.js';

const input = (over: Partial<AssembleInput> = {}): AssembleInput => ({
  packId: '11111111-1111-4111-8111-111111111111',
  generatedAt: new Date('2026-10-16T12:00:00Z'),
  generatedBy: 'user:compliance@x.test',
  toolVersion: '0.1.0',
  libraryVersion: '2026.10.16-draft-1',
  target: { id: 'api-1', name: 'Sandbox API', host: 'stg.example' },
  basis: 'real',
  disclaimer: 'Evidence mapping, not certification.',
  sourceRuns: [
    {
      kind: 'security',
      id: 'run-1',
      finishedAt: '2026-10-15T10:00:00Z',
      environment: 'iSmartPay sandbox',
      isReal: true,
    },
  ],
  coverage: { frameworks: 4 },
  files: [
    { path: 'assessment/compliance-matrix.html', data: '<html>matrix</html>' },
    { path: 'reports/security-run1.json', data: JSON.stringify({ verdict: 'PASS' }) },
    { path: 'evidence/security-run1-calls.csv', data: 'check,status\nauth,401\n' },
  ],
  ...over,
});

/** Rebuilds a zip with one change applied, to simulate tampering. */
function tamper(zip: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(zip);
  edit(files);
  return zipSync(files);
}

describe('assemblePack', () => {
  it('lists every file with a correct SHA-256, size, and a matching SHA256SUMS', () => {
    const p = assemblePack(input());
    const files = unzipSync(p.zip);
    expect(Object.keys(files).sort()).toEqual([
      'README.txt',
      'SHA256SUMS',
      'assessment/compliance-matrix.html',
      'evidence/security-run1-calls.csv',
      'manifest.json',
      'reports/security-run1.json',
    ]);
    for (const f of p.manifest.files) {
      expect(sha256(files[f.path]!)).toBe(f.sha256);
      expect(files[f.path]!.length).toBe(f.bytes);
    }
    // The format `shasum -a 256 -c` expects: "<hash>␣␣<path>".
    const sums = new TextDecoder().decode(files['SHA256SUMS']).trim().split('\n');
    expect(sums).toHaveLength(p.manifest.files.length + 1);
    expect(sums).toContain(
      `${createHash('sha256').update(files['manifest.json']!).digest('hex')}  manifest.json`,
    );
    expect(p.manifestSha256).toBe(sha256(files['manifest.json']!));
  });

  it('is deterministic: same evidence in, same bytes out', () => {
    const a = assemblePack(input());
    const b = assemblePack(input());
    expect(b.zipSha256).toBe(a.zipSha256);
    expect(b.manifestSha256).toBe(a.manifestSha256);
    // File order must not matter.
    const shuffled = assemblePack(input({ files: [...input().files].reverse() }));
    expect(shuffled.manifestSha256).toBe(a.manifestSha256);
  });

  it('changes the manifest hash when any evidence changes', () => {
    const a = assemblePack(input());
    const edited = assemblePack(
      input({
        files: input().files.map((f) =>
          f.path.startsWith('reports/') ? { ...f, data: JSON.stringify({ verdict: 'FAIL' }) } : f,
        ),
      }),
    );
    expect(edited.manifestSha256).not.toBe(a.manifestSha256);
  });

  it('refuses unsafe, duplicate and reserved paths', () => {
    for (const bad of ['../etc/passwd', '/abs.txt', 'a/../../b', 'a\\b', 'a//b', ''])
      expect(() => assertSafePath(bad), bad).toThrow();
    expect(() =>
      assemblePack(
        input({
          files: [
            { path: 'x.txt', data: '1' },
            { path: 'x.txt', data: '2' },
          ],
        }),
      ),
    ).toThrow(/Duplicate/);
    expect(() => assemblePack(input({ files: [{ path: 'manifest.json', data: '{}' }] }))).toThrow(
      /reserved/,
    );
    expect(() => assemblePack(input({ files: [{ path: '../x', data: '1' }] }))).toThrow(/Unsafe/);
  });

  it('ships a README that explains how to verify and states the disclaimer', () => {
    const readme = new TextDecoder().decode(unzipSync(assemblePack(input()).zip)['README.txt']);
    expect(readme).toContain('shasum -a 256 -c SHA256SUMS');
    expect(readme).toContain('verify:evidence-pack');
    expect(readme).toContain('Evidence mapping, not certification.');
  });
});

describe('verifyPack', () => {
  it('accepts an untouched pack and reports its manifest hash', () => {
    const p = assemblePack(input());
    const v = verifyPack(p.zip);
    expect(v).toMatchObject({
      ok: true,
      problems: [],
      manifestSha256: p.manifestSha256,
      packId: input().packId,
      fileCount: 6,
    });
  });

  it('detects a modified file', () => {
    const p = assemblePack(input());
    const v = verifyPack(
      tamper(p.zip, (f) => (f['reports/security-run1.json'] = strToU8('{"verdict":"FAIL"}'))),
    );
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('Content changed: reports/security-run1.json');
  });

  it('detects an added file and a removed file', () => {
    const p = assemblePack(input());
    const added = verifyPack(tamper(p.zip, (f) => (f['extra/notes.txt'] = strToU8('sneaky'))));
    expect(added.problems.join('\n')).toContain('Unlisted file added: extra/notes.txt');
    const removed = verifyPack(
      tamper(p.zip, (f) => void delete f['assessment/compliance-matrix.html']),
    );
    expect(removed.problems.join('\n')).toContain(
      'Listed file is missing: assessment/compliance-matrix.html',
    );
  });

  it('detects a rewritten manifest even if the attacker also fixes the file hashes', () => {
    const p = assemblePack(input());
    const forged = tamper(p.zip, (f) => {
      f['reports/security-run1.json'] = strToU8('{"verdict":"FAIL"}');
      const m = JSON.parse(new TextDecoder().decode(f['manifest.json'])) as typeof p.manifest;
      const entry = m.files.find((x) => x.path === 'reports/security-run1.json')!;
      entry.sha256 = sha256(f['reports/security-run1.json']);
      entry.bytes = f['reports/security-run1.json'].length;
      f['manifest.json'] = strToU8(`${JSON.stringify(m, null, 2)}\n`);
    });
    const v = verifyPack(forged);
    // Internally consistent file hashes, but SHA256SUMS now disagrees AND the manifest hash differs from the issued one.
    expect(v.problems.join('\n')).toContain('SHA256SUMS disagrees for manifest.json');
    expect(v.manifestSha256).not.toBe(p.manifestSha256);
  });

  it('rejects garbage, a missing manifest, and a foreign schema', () => {
    expect(verifyPack(strToU8('not a zip')).ok).toBe(false);
    expect(verifyPack(zipSync({ 'a.txt': strToU8('x') })).problems).toContain(
      'manifest.json is missing',
    );
    const foreign = zipSync({
      'manifest.json': strToU8('{"schema":"other"}'),
      SHA256SUMS: strToU8(''),
    });
    expect(verifyPack(foreign).problems).toContain(
      'manifest.json does not match the expected schema',
    );
  });

  it('flags a path-traversal entry smuggled into the archive', () => {
    const p = assemblePack(input());
    const evil = zipSync({ ...unzipSync(p.zip), '../../evil.sh': strToU8('rm -rf /') });
    expect(verifyPack(evil).problems.join('\n')).toContain('Unsafe path in archive');
  });
});
