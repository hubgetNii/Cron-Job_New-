import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface K6Result {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

export interface K6Handle {
  done: Promise<K6Result>;
  /** Graceful stop (SIGINT lets k6 flush), escalating to SIGKILL after `graceMs`. */
  abort(graceMs?: number): void;
}

/** Only these variables reach k6 — never the worker's DB URL, JWT secret, etc. */
function childEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { K6_NO_USAGE_REPORT: 'true' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const v = process.env[k];
    if (v) base[k] = v;
  }
  return { ...base, ...extra };
}

export async function k6Version(bin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, ['version'], { timeout: 10_000 });
    return stdout.trim().split('\n')[0] ?? 'unknown';
  } catch {
    throw new Error(
      `k6 binary not found or not runnable ("${bin}"). Install k6 on the worker host.`,
    );
  }
}

/**
 * Runs `k6 run` with its JSON metric stream piped to us line by line. Nothing is
 * written to disk: a long run cannot fill the worker's disk with raw samples.
 */
export function startK6(opts: {
  bin: string;
  scriptPath: string;
  env: Record<string, string>;
  onLine: (line: string) => void;
}): K6Handle {
  const child = spawn(opts.bin, ['run', '--quiet', '--out', 'json=-', opts.scriptPath], {
    env: childEnv(opts.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', opts.onLine);

  let stderr = '';
  child.stderr.on('data', (c: Buffer) => {
    stderr = (stderr + c.toString()).slice(-4000);
  });

  const done = new Promise<K6Result>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      rl.close();
      resolve({ exitCode, signal, stderrTail: stderr });
    });
  });

  return {
    done,
    abort(graceMs = 10_000) {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGINT');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, graceMs).unref();
    },
  };
}
