/**
 * `runCodex`: one supervised native run with complete custody.
 *
 * Order, so that nothing is lost and nothing is invented:
 * 1. The output directory must not exist; it is created, never reused.
 * 2. The executable is located on the child's PATH, read and hashed, and the
 *    plan is made. A refused plan ends here: `run.json` and `outcome.json`
 *    say why.
 * 3. Supervision starts. The executable is asked for `--version`; `run.json`
 *    records the executable, the version and the plan (no environment values,
 *    no prompt, no non-public `-c` values); the prompt is kept as
 *    `prompt.txt` unless declined.
 * 4. A stop requested by then (an aborted signal, or a stop signal to this
 *    process) ends the run here, and nothing is spawned.
 * 5. Otherwise native is spawned in a process group of its own and the prompt
 *    goes to its stdin. stdout bytes are written to `events.jsonl` before
 *    they are parsed; stderr bytes go to `stderr.log`. Native writes
 *    `last-message.txt` itself.
 * 6. After native exits, a custody guard keeps stop signals from ending this
 *    process. Supervision is finished (waiting out any stop), the pipes are
 *    drained within a bound, the group is read with lifecycle's
 *    `readProcessGroup` (every reading is kept), `outcome.json`
 *    is concluded, and only then is the guard released.
 *
 * Nothing is deleted. Processes native leaves in its group after exiting on
 * its own are reported, not signalled. Descendants that left the group (a new
 * group or session) are outside what the group state shows.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { finishStream, initialStreamState, JsonlSplitter, parseLine, reduceParsed, type ParsedEvent } from './events.ts';
import { findOnPath, inspectExecutable, probeVersion, type ExecutableFacts, type VersionFacts } from './executable.ts';
import { guardCustody, readProcessGroup, stopSignals, superviseCodex, type CodexSupervisorEvent, type CustodyGuard } from './lifecycle.ts';
import { conclude, refusedOutcome, spawnFailedOutcome, stoppedBeforeSpawnOutcome, type CodexOutcome, type CustodyFacts, type Diagnostic } from './outcome.ts';
import { planInvocation, planRecord, type PlanOptions, type PlanRecord } from './plan.ts';
import type { EnvPolicy, Refusal } from './types.ts';
import { BARE_CODEX_VERSION } from './version.ts';

/** The files of a run's output directory. */
export const RUN_FILES = {
  run: 'run.json',
  prompt: 'prompt.txt',
  events: 'events.jsonl',
  stderr: 'stderr.log',
  lastMessage: 'last-message.txt',
  outcome: 'outcome.json',
} as const;

export type RunFiles = { [name in keyof typeof RUN_FILES]: string };

/**
 * How long native gets after SIGINT before SIGKILL, unless the caller says
 * otherwise. Chosen, not measured; the native probe is built to record how
 * long an interruption actually takes.
 */
export const DEFAULT_STOP_GRACE_MS = 10_000;

const drainMs = 2_000;
const stderrTailBytes = 64 * 1024;

/** The output directory exists; nothing was written. */
export class OutputExistsError extends Error {
  constructor(readonly path: string) {
    super(`${path} already exists; bare-codex writes each run into a new directory and never reuses or clears one`);
    this.name = 'OutputExistsError';
  }
}

export interface SpawnInfo {
  pid: number,
  processGroup: number | null,
  outDir: string,
}

export interface RunOptions extends Omit<PlanOptions, 'codexPath' | 'executableClass' | 'lastMessageFile' | 'baseEnv' | 'cwd'> {
  /** The executable: a path, or a name looked up on the child's PATH. Default `codex`. */
  codexPath?: string,

  /** Default: this process's working directory. */
  cwd?: string,

  /** The environment to inherit from. Default `process.env`. */
  baseEnv?: Readonly<Record<string, string | undefined>>,

  /** A new directory for this run's custody; its parent must exist. */
  outDir: string,

  /**
   * An exec-style wrapper put before the executable, such as
   * `['/usr/bin/sandbox-exec', '-p', profile]`. It must exec the executable,
   * so that signals sent to the spawned process reach native.
   */
  wrapper?: readonly string[],

  /** Default {@link DEFAULT_STOP_GRACE_MS}. */
  stopGraceMs?: number,

  /** Aborting it interrupts the run (SIGINT to native, SIGKILL after the grace); aborted before the spawn, nothing is spawned. */
  signal?: AbortSignal,

  /**
   * `process` (default): while the run lasts and until its outcome is written,
   * SIGHUP, SIGINT and SIGTERM to this process interrupt the run instead of
   * ending this process, so the detached native is never orphaned and custody
   * is never cut short. `none`: install nothing; the caller's own policy uses
   * `signal`.
   */
  signals?: 'process' | 'none',

  /** Keep the delivered prompt bytes as `prompt.txt`. Default true. */
  retainPrompt?: boolean,

  /** Hash the executable. Default true. */
  hashExecutable?: boolean,

  /** Ask the executable for `--version` before the run. Default true. */
  checkVersion?: boolean,

  /** Every parsed event, as it arrives. Errors it throws are ignored. */
  onEvent?: (event: ParsedEvent) => void,

  /** Called once native has been spawned. Errors it throws are ignored. */
  onSpawn?: (info: SpawnInfo) => void,

  /** Every supervision event, just before its effect. */
  onSupervisor?: (event: CodexSupervisorEvent) => void,
}

export interface RunResult {
  outcome: CodexOutcome,
  outDir: string,
  files: RunFiles,
  plan: PlanRecord,
  executable: ExecutableFacts | null,
  nativeVersion: VersionFacts | null,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

function safely(callback: () => void): void {
  try {
    callback();
  } catch {
    // A caller's callback never breaks custody.
  }
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>(resolveTimer => {
        timer = setTimeout(() => resolveTimer(fallback), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The last `limit` bytes of a stream. */
class TailBuffer {
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  constructor(readonly limit: number) {}

  push(chunk: Uint8Array): void {
    this.#chunks.push(chunk.slice());
    this.#bytes += chunk.length;
    while (this.#chunks.length > 1 && this.#bytes - (this.#chunks[0]?.length ?? 0) >= this.limit) {
      this.#bytes -= this.#chunks.shift()?.length ?? 0;
    }
  }

  text(): string {
    const all = Buffer.concat(this.#chunks);
    return new TextDecoder().decode(all.subarray(Math.max(0, all.length - this.limit)));
  }
}

interface Pump {
  /** Resolves true once the stream ended, or false after `ms`, when reading is cancelled. */
  drain(ms: number): Promise<boolean>,
}

function pump(stream: ReadableStream<Uint8Array>, onChunk: (chunk: Uint8Array) => void, onError: (message: string) => void): Pump {
  const reader = stream.getReader();
  const state = { finished: false };
  const done = (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          return;
        }
        try {
          onChunk(result.value);
        } catch (error) {
          onError(`handling native output: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      onError(`reading native output: ${errorMessage(error)}`);
    } finally {
      state.finished = true;
    }
  })();
  return {
    async drain(ms) {
      if (state.finished) {
        return true;
      }
      const drained = await within(done.then(() => true), ms, false);
      if (!drained) {
        await reader.cancel().catch(() => undefined);
      }
      return drained;
    },
  };
}

async function deliver(sink: { write(chunk: Uint8Array): unknown, end(): unknown }, bytes: Uint8Array): Promise<string | null> {
  try {
    sink.write(bytes);
    await sink.end();
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function trySpawn(command: string[], cwd: string, env: Record<string, string>) {
  try {
    return {
      ok: true as const,
      subprocess: Bun.spawn(command, {
        cwd,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: process.platform !== 'win32',
      }),
    };
  } catch (error) {
    return { ok: false as const, error: errorMessage(error) };
  }
}

function custodyDiagnostics(custody: CustodyFacts, stopped: boolean): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!custody.stdoutDrained || !custody.stderrDrained) {
    out.push({ code: 'output-not-drained', detail: 'native exited, but something still held its output open past the drain bound; what arrived before then is kept' });
  }
  if (custody.groupState === 'occupied') {
    out.push(stopped
      ? { code: 'group-survived-stop', detail: `process group ${custody.processGroup} still has processes after SIGKILL` }
      : { code: 'leftover-processes', detail: `native exited, but process group ${custody.processGroup} still has processes; they were not signalled and may still be running` });
  }
  if (custody.groupState === 'not-permitted') {
    out.push({ code: 'group-not-permitted', detail: `signal 0 to process group ${custody.processGroup} failed with EPERM through every reading; that shows neither that anything there is still running nor whose it is, so the group is not shown empty` });
  }
  if (custody.writeError !== null) {
    out.push({ code: 'custody-write-failed', detail: custody.writeError });
  }
  if (custody.stdinError !== null) {
    out.push({ code: 'stdin-delivery-failed', detail: custody.stdinError });
  }
  if (custody.signalsDuringCustody.length > 0) {
    out.push({ code: 'signal-during-custody', detail: `received ${custody.signalsDuringCustody.join(', ')} after native had exited; recorded, nothing left to stop` });
  }
  return out;
}

/** The PATH the child will have, which is where its executable is looked up. */
export function childPathOf(options: { env?: EnvPolicy }, baseEnv: Readonly<Record<string, string | undefined>>): string | undefined {
  const set = options.env?.set?.['PATH'];
  if (set !== undefined) {
    return set;
  }
  if (options.env?.unset?.includes('PATH') === true || options.env?.inherit === false) {
    return undefined;
  }
  return baseEnv['PATH'];
}

/**
 * Runs one native turn. Resolves with the outcome for every run that got an
 * output directory, refused and stopped-before-spawn ones included; throws
 * {@link OutputExistsError} before writing anything when the directory exists.
 */
export async function runCodex(options: RunOptions): Promise<RunResult> {
  const outDir = resolve(options.outDir);
  if (pathExists(outDir)) {
    throw new OutputExistsError(outDir);
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const baseEnv = options.baseEnv ?? process.env;
  mkdirSync(outDir, { mode: 0o700 });
  const files: RunFiles = {
    run: join(outDir, RUN_FILES.run),
    prompt: join(outDir, RUN_FILES.prompt),
    events: join(outDir, RUN_FILES.events),
    stderr: join(outDir, RUN_FILES.stderr),
    lastMessage: join(outDir, RUN_FILES.lastMessage),
    outcome: join(outDir, RUN_FILES.outcome),
  };
  const startedAt = new Date().toISOString();

  const requested = options.codexPath ?? 'codex';
  const located = findOnPath(requested, childPathOf(options, baseEnv), cwd);
  const preflight: Refusal[] = [];
  let executable: ExecutableFacts | null = null;
  if (located === null) {
    preflight.push({ code: 'executable-not-found', message: `${requested} was not found ${requested.includes('/') ? 'or is not executable' : 'on the child PATH'}` });
  } else {
    try {
      executable = await inspectExecutable(located, { hash: options.hashExecutable ?? true });
    } catch (error) {
      preflight.push({ code: 'executable-not-runnable', message: `${located}: ${errorMessage(error)}` });
    }
  }
  const executableClass = executable?.class ?? null;

  const plan = planInvocation({
    ...options,
    codexPath: located ?? requested,
    executableClass: executable?.class,
    cwd,
    lastMessageFile: files.lastMessage,
    baseEnv,
  });
  const record = planRecord(plan);
  const refusals = [ ...preflight, ...plan.refusals ];
  const wrapper = options.wrapper ?? [];
  const runRecord = (nativeVersion: VersionFacts | null) => ({
    schema: 'bare-codex.run/v1',
    tool: { name: 'bare-codex', version: BARE_CODEX_VERSION },
    startedAt,
    cwd,
    outDir,
    wrapper,
    executable,
    nativeVersion,
    plan: record,
  });

  if (refusals.length > 0) {
    writeJson(files.run, runRecord(null));
    const outcome = refusedOutcome(refusals, executableClass);
    writeJson(files.outcome, outcome);
    return { outcome, outDir, files, plan: record, executable, nativeVersion: null };
  }

  // Installed before anything else is started, so a stop that arrives
  // meanwhile is held rather than ending this process.
  const listen = (options.signals ?? 'process') === 'process' ? stopSignals : [];
  const supervision = superviseCodex({
    graceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    listen,
    onEvent: options.onSupervisor,
  });
  const onAbort = () => supervision.source.request('abort');
  if (options.signal?.aborted === true) {
    onAbort();
  } else {
    options.signal?.addEventListener('abort', onAbort, { once: true });
  }
  const endUnspawned = () => {
    options.signal?.removeEventListener('abort', onAbort);
    supervision.supervisor.release();
  };

  let nativeVersion: VersionFacts | null = null;
  try {
    if (supervision.firstCause() === null && executable !== null && (options.checkVersion ?? true)) {
      nativeVersion = await probeVersion([ ...wrapper, executable.path, '--version' ], plan.env);
    }
    writeJson(files.run, runRecord(nativeVersion));
    if (options.retainPrompt ?? true) {
      writeFileSync(files.prompt, plan.stdin, { mode: 0o600, flag: 'wx' });
    }
  } catch (error) {
    endUnspawned();
    throw error;
  }

  const held = supervision.firstCause();
  if (held !== null) {
    try {
      const outcome = stoppedBeforeSpawnOutcome(held, executableClass, nativeVersion?.version ?? null);
      writeJson(files.outcome, outcome);
      return { outcome, outDir, files, plan: record, executable, nativeVersion };
    } finally {
      endUnspawned();
    }
  }

  const spawned = trySpawn([ ...wrapper, plan.command, ...plan.args ], cwd, plan.env);
  if (!spawned.ok) {
    try {
      const outcome = spawnFailedOutcome(`could not spawn ${plan.command}: ${spawned.error}`, executableClass);
      writeJson(files.outcome, outcome);
      return { outcome, outDir, files, plan: record, executable, nativeVersion };
    } finally {
      endUnspawned();
    }
  }
  const subprocess = spawned.subprocess;
  const processGroup = process.platform === 'win32' ? null : subprocess.pid;
  // Attached before anything else can throw: a detached child is never left
  // running with nobody to stop it.
  supervision.supervisor.attach({ subprocess, processGroup });

  const held2: { fds: { events: number | null, stderr: number | null }, guard: CustodyGuard | null } = { fds: { events: null, stderr: null }, guard: null };
  try {
    const eventsFd = openSync(files.events, 'wx', 0o600);
    held2.fds.events = eventsFd;
    const stderrFd = openSync(files.stderr, 'wx', 0o600);
    held2.fds.stderr = stderrFd;
    safely(() => options.onSpawn?.({ pid: subprocess.pid, processGroup, outDir }));

    const stdinDelivered = deliver(subprocess.stdin, plan.stdin);
    const errors: { write: string | null } = { write: null };
    const noteError = (message: string) => {
      errors.write ??= message;
    };
    const splitter = new JsonlSplitter();
    const reduced = { stream: initialStreamState() };
    const stdout = pump(subprocess.stdout, chunk => {
      // Raw bytes first: they are custody, whatever parsing makes of them.
      try {
        writeAll(eventsFd, chunk);
      } catch (error) {
        noteError(`${RUN_FILES.events}: ${errorMessage(error)}`);
      }
      for (const line of splitter.push(chunk)) {
        const parsed = parseLine(line);
        reduced.stream = reduceParsed(reduced.stream, parsed);
        if (parsed.kind === 'event') {
          safely(() => options.onEvent?.(parsed));
        }
      }
    }, noteError);
    const tail = new TailBuffer(stderrTailBytes);
    const stderr = pump(subprocess.stderr, chunk => {
      try {
        writeAll(stderrFd, chunk);
      } catch (error) {
        noteError(`${RUN_FILES.stderr}: ${errorMessage(error)}`);
      }
      tail.push(chunk);
    }, noteError);

    await subprocess.exited;
    // Installed before finish() removes the supervisor's handlers, so a late
    // signal cannot end this process before the outcome is written.
    const guard = guardCustody(listen);
    held2.guard = guard;
    // What native left in its group, when a stop is under way.
    const report = await supervision.supervisor.finish();
    const [ stdoutDrained, stderrDrained ] = await Promise.all([ stdout.drain(drainMs), stderr.drain(drainMs) ]);
    const stream = finishStream(reduced.stream, splitter.end());
    const stdinError = await stdinDelivered;
    const group = processGroup === null ? null : await readProcessGroup(processGroup);
    const lastMessage = existsSync(files.lastMessage) ? readFileSync(files.lastMessage, 'utf8') : null;
    const outcome = conclude({
      stream,
      exit: { code: subprocess.exitCode, signal: subprocess.signalCode },
      stderrTail: tail.text(),
      lastMessage,
      session: options.session,
      stop: report === null ? null : {
        cause: supervision.firstCause() ?? 'internal',
        nativeSignal: report.signal,
        escalated: report.escalated,
        groupState: report.groupState,
        groupObservations: report.groupObservations,
      },
      nativeVersion: nativeVersion?.version ?? null,
      executableClass,
    });
    const custody: CustodyFacts = {
      processGroup,
      groupState: group?.state ?? null,
      groupObservations: group?.observations ?? [],
      stdoutDrained,
      stderrDrained,
      writeError: errors.write,
      stdinError,
      signalsDuringCustody: [ ...guard.received ],
    };
    outcome.custody = custody;
    outcome.diagnostics.push(...custodyDiagnostics(custody, report !== null));
    writeJson(files.outcome, outcome);
    return { outcome, outDir, files, plan: record, executable, nativeVersion };
  } finally {
    // A failure above still ends the run in order, with SIGINT first.
    if (subprocess.exitCode === null && subprocess.signalCode === null && supervision.firstCause() === null) {
      supervision.source.request('internal');
    }
    await supervision.supervisor.finish();
    held2.guard?.release();
    options.signal?.removeEventListener('abort', onAbort);
    if (held2.fds.events !== null) {
      closeSync(held2.fds.events);
    }
    if (held2.fds.stderr !== null) {
      closeSync(held2.fds.stderr);
    }
  }
}
