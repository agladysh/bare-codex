/**
 * What is about to be spawned: located on the child's PATH, read by its first
 * bytes, hashed, and asked its version. Nothing is refused for being a
 * script: a managed launcher that execs native Codex is a supported route.
 * The class is recorded, and used only to refuse a real conflict (a named
 * home that an account-switching launcher would replace).
 */

import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type { ExecutableClass } from './types.ts';

/** An executable as found and read. */
export interface ExecutableFacts {
  /** The path as located (absolute). */
  path: string,

  /** Its real path, symlinks resolved. */
  realpath: string,

  class: ExecutableClass,

  /** The `#!` line without `#!`, for a script. */
  shebang: string | null,

  size: number,

  /** SHA-256 of the real file, or null when hashing was declined. */
  sha256: string | null,
}

/** What a version probe saw. */
export interface VersionFacts {
  command: string[],
  exitCode: number | null,
  timedOut: boolean,
  output: string,
  /** The first `x.y.z` in the output, or null. */
  version: string | null,
}

const headLength = 64 * 1024;
const lineFeed = 0x0a;

const nativeMagic: readonly (readonly number[])[] = [
  [ 0xcf, 0xfa, 0xed, 0xfe ], // Mach-O 64-bit, little-endian
  [ 0xce, 0xfa, 0xed, 0xfe ], // Mach-O 32-bit, little-endian
  [ 0xca, 0xfe, 0xba, 0xbe ], // Mach-O universal
  [ 0xca, 0xfe, 0xba, 0xbf ], // Mach-O universal, 64-bit offsets
  [ 0x7f, 0x45, 0x4c, 0x46 ], // ELF
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

/**
 * Classifies an executable by its first bytes:
 * - `native-binary`: Mach-O or ELF;
 * - `switch-launcher`: a script that mentions `CODEX_SWITCH_OFF`, the escape
 *   variable of an account-switching launcher that replaces `CODEX_HOME`;
 * - `npm-wrapper`: a Node or Bun script that mentions codex;
 * - `script`: any other `#!` script;
 * - `unknown`: anything else.
 */
export function classifyExecutableHead(head: Uint8Array): { class: ExecutableClass, shebang: string | null } {
  if (nativeMagic.some(magic => startsWith(head, magic))) {
    return { class: 'native-binary', shebang: null };
  }
  if (head[0] !== 0x23 || head[1] !== 0x21) {
    return { class: 'unknown', shebang: null };
  }
  const end = head.indexOf(lineFeed);
  const decoder = new TextDecoder();
  const shebang = decoder.decode(head.subarray(2, end === -1 ? head.length : end)).trim();
  const text = decoder.decode(head);
  if (text.includes('CODEX_SWITCH_OFF')) {
    return { class: 'switch-launcher', shebang };
  }
  const words = shebang.split(' ').flatMap(word => word.split('/'));
  if ((words.includes('node') || words.includes('bun')) && text.includes('codex')) {
    return { class: 'npm-wrapper', shebang };
  }
  return { class: 'script', shebang };
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Locates `command` the way the child's exec would: a path containing `/` as
 * given (relative to `cwd`), anything else on `pathValue`, the child's PATH.
 * Returns an absolute path, or null.
 */
export function findOnPath(command: string, pathValue: string | undefined, cwd: string): string | null {
  if (command.includes('/')) {
    const path = isAbsolute(command) ? command : resolve(cwd, command);
    return isExecutableFile(path) ? path : null;
  }
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (dir === '') {
      continue;
    }
    const path = resolve(cwd, dir, command);
    if (isExecutableFile(path)) {
      return path;
    }
  }
  return null;
}

function readHead(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const buffer = new Uint8Array(headLength);
    const length = readSync(fd, buffer, 0, headLength, 0);
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    hash.update(result.value);
  }
  return hash.digest('hex');
}

/** Reads what `path` is. It never executes it. */
export async function inspectExecutable(path: string, options: { hash?: boolean } = {}): Promise<ExecutableFacts> {
  const real = realpathSync(path);
  const size = statSync(real).size;
  const { class: kind, shebang } = classifyExecutableHead(readHead(real));
  return {
    path,
    realpath: real,
    class: kind,
    shebang,
    size,
    sha256: options.hash === false ? null : await sha256File(real),
  };
}

/** The first `x.y.z` (with an optional pre-release suffix) in `text`. */
export function parseVersion(text: string): string | null {
  return /([0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.]+)?)/.exec(text)?.[1] ?? null;
}

function trySpawnPiped(command: string[], env: Readonly<Record<string, string>>) {
  try {
    return Bun.spawn(command, { env: { ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Runs a short command to completion within `timeoutMs`, collecting stdout
 * and stderr. The child is this process's own and is killed at the deadline.
 */
export async function runBounded(command: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number): Promise<{ exitCode: number | null, timedOut: boolean, output: string }> {
  const [ file, ...rest ] = command;
  if (file === undefined) {
    throw new Error('empty command');
  }
  const spawned = trySpawnPiped([ file, ...rest ], env);
  if (typeof spawned === 'string') {
    return { exitCode: null, timedOut: false, output: spawned };
  }
  const child = spawned;
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [ out, err ] = await Promise.all([ new Response(child.stdout).text(), new Response(child.stderr).text() ]);
    await child.exited;
    return { exitCode: child.exitCode, timedOut: state.timedOut, output: `${out}${err}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks `command` (an executable, possibly behind an exec wrapper) for
 * `--version`. A managed launcher may hand `--version` to native as is.
 * Native's CLI parses its arguments before loading any configuration
 * (codex-rs/cli/src/main.rs:1045-1051), but the arg0 dispatch that runs
 * before that is not in the extracted 0.162.1 sources, so that `--version`
 * reads no home is not established here.
 */
export async function probeVersion(command: readonly string[], env: Readonly<Record<string, string>>, timeoutMs = 15_000): Promise<VersionFacts> {
  const run = await runBounded(command, env, timeoutMs);
  return {
    command: [ ...command ],
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    output: run.output.slice(0, 2_000),
    version: parseVersion(run.output),
  };
}
