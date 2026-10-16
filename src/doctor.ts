/**
 * `doctor`: checks an invocation without a model call. It locates and reads
 * the executable, asks for its `--version` and its `exec --help`, plans the
 * run and reports every refusal and explicit override, and checks the paths
 * the run would use. It never reads anything inside a Codex home: auth is
 * the caller's.
 */

import { existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { findOnPath, inspectExecutable, probeVersion, runBounded, type ExecutableFacts, type VersionFacts } from './executable.ts';
import { MEASURED_NATIVE_VERSION, planInvocation, planRecord, type PlanRecord } from './plan.ts';
import { childPathOf, type RunOptions } from './run.ts';

export type CheckLevel = 'ok' | 'note' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string,
  level: CheckLevel,
  message: string,
}

export interface DoctorReport {
  schema: 'bare-codex.doctor/v1',
  /** No check failed. */
  ok: boolean,
  executable: ExecutableFacts | null,
  version: VersionFacts | null,
  plan: PlanRecord,
  checks: DoctorCheck[],
}

export type DoctorOptions = Omit<RunOptions, 'outDir' | 'prompt' | 'signal' | 'signals' | 'onEvent' | 'onSpawn' | 'onSupervisor' | 'retainPrompt' | 'checkVersion'> & {
  /** The output directory a run would use; checked, never created. */
  outDir?: string,
  /** Only planned, never sent. */
  prompt?: string | Uint8Array,
};

const helpTimeoutMs = 15_000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function findGitRoot(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return null;
    }
  }
}

/** The long options a plan passes; `-c` is listed by native as `--config`. */
function requiredFlags(args: readonly string[]): string[] {
  const flags = new Set<string>();
  for (const arg of args) {
    if (arg === '-c') {
      flags.add('--config');
    } else if (arg.startsWith('--')) {
      flags.add(arg);
    }
  }
  return [ ...flags ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Checks an invocation; see the module comment. */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, level: CheckLevel, message: string) => {
    checks.push({ id, level, message });
  };
  const cwd = resolve(options.cwd ?? process.cwd());
  const baseEnv = options.baseEnv ?? process.env;
  const requested = options.codexPath ?? 'codex';
  const located = findOnPath(requested, childPathOf(options, baseEnv), cwd);
  let executable: ExecutableFacts | null = null;
  if (located === null) {
    add('executable', 'fail', `${requested} was not found ${requested.includes('/') ? 'or is not executable' : 'on the child PATH'}`);
  } else {
    try {
      executable = await inspectExecutable(located, { hash: options.hashExecutable ?? true });
      add('executable', 'ok', `${executable.path} (real path ${executable.realpath}): ${executable.class}${executable.sha256 === null ? '' : `, sha256 ${executable.sha256}`}`);
      if (executable.class !== 'native-binary') {
        add('executable-route', 'note', `${executable.class}: argv, stdio, signals and the exit status reach native Codex only if this executable execs it; bare-codex records the class and does not refuse a launcher`);
      }
    } catch (error) {
      add('executable', 'fail', `${located}: ${errorMessage(error)}`);
    }
  }

  const outDir = options.outDir === undefined ? null : resolve(options.outDir);
  const plan = planInvocation({
    ...options,
    codexPath: located ?? requested,
    executableClass: executable?.class,
    cwd,
    lastMessageFile: join(outDir ?? cwd, 'last-message.txt'),
    baseEnv,
    prompt: options.prompt ?? 'bare-codex doctor: no model call is made',
  });
  for (const refusal of plan.refusals) {
    add(`refusal:${refusal.code}`, 'fail', refusal.message);
  }
  for (const note of plan.notes) {
    add(`plan:${note.what}`, 'note', note.detail);
  }

  let version: VersionFacts | null = null;
  if (executable !== null) {
    const wrapper = options.wrapper ?? [];
    version = await probeVersion([ ...wrapper, executable.path, '--version' ], plan.env);
    if (version.version === null) {
      add('version', 'fail', `no version in the output of --version (exit ${String(version.exitCode)}${version.timedOut ? ', timed out' : ''})`);
    } else if (version.version === MEASURED_NATIVE_VERSION) {
      add('version', 'ok', `native ${version.version}, the version bare-codex was measured against`);
    } else {
      add('version', 'warn', `native ${version.version}; bare-codex was measured against ${MEASURED_NATIVE_VERSION}. Re-run the native probe before relying on protocol details`);
    }
    const launcher = executable.class === 'switch-launcher';
    if (launcher) {
      add('help-route', 'note', 'exec --help is asked with CODEX_SWITCH_OFF=1, so the launcher hands it straight to native; help is answered during argument parsing and reads no home');
    }
    const help = await runBounded([ ...wrapper, executable.path, 'exec', '--help' ], launcher ? { ...plan.env, CODEX_SWITCH_OFF: '1' } : plan.env, helpTimeoutMs);
    const missing = requiredFlags(plan.args).filter(flag => !help.output.includes(flag));
    if (help.exitCode !== 0) {
      add('help', 'fail', `exec --help exited ${String(help.exitCode)}${help.timedOut ? ' (timed out)' : ''}`);
    } else if (missing.length > 0) {
      add('help', 'fail', `exec --help does not list ${missing.join(', ')}: the native options drifted, and this plan would fail`);
    } else {
      add('help', 'ok', 'exec --help lists every option this plan passes');
    }
  }

  if (options.home?.kind === 'path') {
    const named = options.home.codexHome;
    if (isDirectory(named)) {
      add('home', 'ok', `named home ${named} is a directory; its contents are not inspected`);
    } else {
      add('home', 'fail', `named home ${named} is not an existing directory`);
    }
  } else {
    const inherited = plan.env['CODEX_HOME'];
    add('home', 'note', inherited === undefined
      ? 'CODEX_HOME is not set for the child: native uses its default home, whose contents are not inspected'
      : `CODEX_HOME is inherited: ${inherited}; its contents are not inspected`);
  }

  if (!isDirectory(cwd)) {
    add('cwd', 'fail', `${cwd} is not an existing directory`);
  } else {
    add('cwd', 'ok', `working root ${cwd}`);
    const outsideAllowed = options.allowOutsideRepo === true || options.permissions?.kind === 'bypass';
    if (!outsideAllowed && findGitRoot(cwd) === null) {
      add('git', 'warn', 'no .git in the working root or above it: native refuses to run outside a Git repository unless --skip-git-repo-check (allowOutsideRepo) is given (exec/src/lib.rs:1011-1019)');
    }
  }

  if (outDir !== null) {
    if (pathExists(outDir)) {
      add('out', 'fail', `${outDir} already exists; a run writes into a new directory`);
    } else if (!isDirectory(dirname(outDir))) {
      add('out', 'fail', `${dirname(outDir)} does not exist; the output directory is created without parents`);
    } else {
      add('out', 'ok', `${outDir} can be created`);
    }
  }

  add('auth', 'note', 'authentication is caller-owned: bare-codex does not inspect, copy or link anything inside a Codex home, and makes no auth isolation claim');

  return {
    schema: 'bare-codex.doctor/v1',
    ok: checks.every(check => check.level !== 'fail'),
    executable,
    version,
    plan: planRecord(plan),
    checks,
  };
}
