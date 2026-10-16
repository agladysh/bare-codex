import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isJsonObject } from '../src/types.ts';

export const LF = String.fromCharCode(10);
export const FAKE_CODEX = resolve(import.meta.dir, 'fake-codex.ts');
export const CLI = resolve(import.meta.dir, '..', 'bin', 'bare-codex.ts');

/** A value that must never appear in any custody file. */
export const SECRET_SENTINEL = 'bare-codex-test-sentinel-6b1f0e';

export const NEW_THREAD = '0199a000-0000-7000-8000-000000000001';
export const FORKED_THREAD = '0199a000-0000-7000-8000-0000000000f0';

export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/** An executable in `dir` that execs the fake under this Bun; the exec keeps its pid, so signals reach the fake. */
export function makeFakeCodex(dir: string, name = 'codex'): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh${LF}exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CODEX)} "$@"${LF}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A stand-in for an account-switching launcher: it mentions CODEX_SWITCH_OFF and execs the fake. */
export function makeFakeLauncher(dir: string): string {
  const path = join(dir, 'launcher');
  writeFileSync(path, `#!/bin/sh${LF}# honours CODEX_SWITCH_OFF like an account-switching launcher${LF}exec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CODEX)} "$@"${LF}`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

export interface FakeLog {
  argv: string[],
  cwd: string,
  envNames: string[],
  values: Record<string, string | null>,
  present: Record<string, boolean>,
  stdin: string,
}

function isFakeLog(value: unknown): value is FakeLog {
  return isJsonObject(value) && Array.isArray(value['argv']) && typeof value['stdin'] === 'string' && isJsonObject(value['present']) && isJsonObject(value['values']);
}

export function fakeLogPath(dir: string): string {
  return join(dir, 'fake-log.json');
}

export function readFakeLog(dir: string): FakeLog | null {
  const path = fakeLogPath(dir);
  if (!existsSync(path)) {
    return null;
  }
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return isFakeLog(value) ? value : null;
}

export function readSignals(dir: string): string[] {
  const path = `${fakeLogPath(dir)}.signals`;
  return existsSync(path) ? readFileSync(path, 'utf8').split(LF).filter(line => line !== '') : [];
}

export function readGrandchild(dir: string): number | null {
  const path = `${fakeLogPath(dir)}.grandchild`;
  return existsSync(path) ? Number(readFileSync(path, 'utf8')) : null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) {
      return true;
    }
    await Bun.sleep(25);
  }
  return check();
}

/** Every file under `dir` whose bytes contain `needle`. */
export function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      found.push(...filesContaining(path, needle));
    } else if (readFileSync(path).includes(needle)) {
      found.push(path);
    }
  }
  return found;
}

/** A fixed, small environment for the fake: nothing from the machine running the tests. */
export function fakeEnv(dir: string, mode: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: dir,
    CODEX_HOME: join(dir, 'codex-home'),
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_LOG: fakeLogPath(dir),
    BARE_CODEX_TEST_SECRET: SECRET_SENTINEL,
    ...extra,
  };
}
