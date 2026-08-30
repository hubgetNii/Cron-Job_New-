import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PkgShape {
  name?: string;
  version?: string;
}

let info: { name: string; version: string } | undefined;

/** Reads name/version from package.json once, for /health and log context. */
export function appInfo(): { name: string; version: string } {
  if (!info) {
    try {
      const pkgUrl = new URL('../../package.json', import.meta.url);
      const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as PkgShape;
      info = { name: pkg.name ?? 'fintech-cron-monitor', version: pkg.version ?? '0.0.0' };
    } catch {
      info = { name: 'fintech-cron-monitor', version: '0.0.0' };
    }
  }
  return info;
}
