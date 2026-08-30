import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * SSRF protection (see vault: "Credential Encryption and SSRF Protection").
 * Non-negotiable: users supply arbitrary target URLs, so the platform must
 * refuse to reach loopback, private, link-local and cloud-metadata addresses
 * unless an administrator has explicitly set `allow_private_network` on the
 * target — which is itself audit-logged.
 */

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`Target URL blocked by SSRF policy: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(ip: string, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this host"
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local incl. 169.254.169.254 metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24],
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
];

export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return BLOCKED_V4.some(([base, bits]) => inCidr(ip, base, bits));
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v === '::ffff:0:0') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true; // link-local, ULA
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }
  return false;
}

export interface SsrfCheckOptions {
  allowPrivateNetwork?: boolean;
  /** Override DNS resolution (tests). */
  resolve?: (hostname: string) => Promise<string[]>;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((r) => r.address);
}

/**
 * Validates a target URL against the SSRF policy. Resolves the hostname and
 * checks every returned address, so a DNS name that points at a private IP is
 * still blocked.
 */
export async function assertUrlAllowed(rawUrl: string, opts: SsrfCheckOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError('not a valid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError(`unsupported protocol "${url.protocol}"`);
  }

  const host = url.hostname.toLowerCase();
  if (opts.allowPrivateNetwork) return;

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new SsrfBlockedError(`hostname "${host}" is internal`);
  }

  const literal = isIP(host);
  const addresses = literal
    ? [host]
    : await (opts.resolve ?? defaultResolve)(host).catch(() => {
        throw new SsrfBlockedError(`could not resolve "${host}"`);
      });

  if (addresses.length === 0) throw new SsrfBlockedError(`"${host}" resolved to no addresses`);

  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new SsrfBlockedError(`resolves to blocked address ${addr}`);
    }
  }
}
