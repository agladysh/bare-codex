import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reduceEvents } from '../src/events.ts';
import { OutputExistsError, runCodex, type RunOptions } from '../src/run.ts';
import { isJsonObject } from '../src/types.ts';
import {
  fakeEnv,
  fakeLogPath,
  filesContaining,
  isAlive,
  makeFakeCodex,
  makeFakeLauncher,
  NEW_THREAD,
  readFakeLog,
  readGrandchild,
  readSignals,
  SECRET_SENTINEL,
  tempDir,
  waitFor,
} from './helpers.ts';

const SLOW = 30_000;

interface Setup {
  dir: string,
  codex: string,
  work: string,
  out: string,
}

function setup(): Setup {
  const dir = tempDir('bare-codex-run-');
  const work = join(dir, 'work');
  mkdirSync(work);
  return { dir, codex: makeFakeCodex(dir), work, out: join(dir, 'out') };
}

function options(s: Setup, mode: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    codexPath: s.codex,
    cwd: s.work,
    outDir: s.out,
    prompt: 'fake prompt',
    signals: 'none',
    allowOutsideRepo: true,
    baseEnv: fakeEnv(s.dir, mode),
    ...extra,
  };
}

function abortOnCommand(controller: AbortController): RunOptions['onEvent'] {
  return event => {
    const item = event.event['item'];
    if (event.type === 'item.started' && isJsonObject(item) && item['type'] === 'command_execution') {
      controller.abort();
    }
  };
}

describe('runCodex with a fake native', () => {
  test('a completed turn: custody files, exact raw events, the prompt on stdin only', async () => {
    const s = setup();
    const result = await runCodex(options(s, 'ok'));
    expect(result.outcome).toMatchObject({ status: 'completed', reason: 'turn-completed', threadId: NEW_THREAD, finalMessage: { text: 'fake final', matchesStream: true } });
    for (const path of Object.values(result.files)) {
      expect(existsSync(path)).toBe(true);
    }
    expect(readFileSync(result.files.events)).toEqual(readFileSync(`${fakeLogPath(s.dir)}.stdout`));
    expect(reduceEvents(readFileSync(result.files.events)).events).toBe(4);
    const log = readFakeLog(s.dir);
    expect(log?.stdin).toBe('fake prompt');
    expect(log?.argv.at(-1)).toBe('-');
    expect(log?.argv.join(' ')).not.toContain('fake prompt');
    expect(log?.values['CODEX_HOME']).toBe(join(s.dir, 'codex-home'));
    expect(log?.present['BARE_CODEX_TEST_SECRET']).toBe(true);
    expect(filesContaining(s.out, SECRET_SENTINEL)).toEqual([]);
    expect(result.outcome.custody).toMatchObject({ groupState: 'empty', stdoutDrained: true, stderrDrained: true, writeError: null });
    expect(result.outcome.custody?.groupObservations[0]?.elapsedMs).toBe(0);
    expect(result.outcome.custody?.groupObservations.at(-1)?.state).toBe('empty');
    expect(result.nativeVersion?.version).toBe('0.163.0');
  }, SLOW);

  test('an inherited CODEX_API_KEY is refused before anything is spawned', async () => {
    const s = setup();
    const result = await runCodex(options(s, 'ok', { baseEnv: { ...fakeEnv(s.dir, 'ok'), CODEX_API_KEY: SECRET_SENTINEL } }));
    expect(result.outcome).toMatchObject({ status: 'refused', reason: 'preflight-refused' });
    expect(result.outcome.refusals.map(refusal => refusal.code)).toEqual([ 'ambient-credential' ]);
    expect(readFakeLog(s.dir)).toBeNull();
    expect(existsSync(result.files.events)).toBe(false);
    expect(existsSync(result.files.outcome)).toBe(true);
    expect(filesContaining(s.out, SECRET_SENTINEL)).toEqual([]);
  }, SLOW);

  test('a credential set deliberately is passed, and recorded by presence only', async () => {
    const s = setup();
    const result = await runCodex(options(s, 'ok', { env: { set: { CODEX_API_KEY: SECRET_SENTINEL } } }));
    expect(result.outcome.status).toBe('completed');
    expect(readFakeLog(s.dir)?.present['CODEX_API_KEY']).toBe(true);
    expect(result.plan.envFacts.variables.find(fact => fact.name === 'CODEX_API_KEY')).toEqual({ name: 'CODEX_API_KEY', present: true, origin: 'set' });
    expect(filesContaining(s.out, SECRET_SENTINEL)).toEqual([]);
  }, SLOW);

  test('turn.failed, an exact auth message, and an agent message that only quotes one', async () => {
    const failed = setup();
    expect((await runCodex(options(failed, 'turn-failed'))).outcome).toMatchObject({ status: 'failed', reason: 'turn-failed', failure: { message: 'boom: upstream failed' } });
    const reused = setup();
    expect((await runCodex(options(reused, 'auth-reused'))).outcome.failure?.auth).toBe('refresh-token-reused');
    const quoted = setup();
    const outcome = (await runCodex(options(quoted, 'agent-mentions-auth'))).outcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();
  }, SLOW);

  test('recovered errors, an error with a completed turn, and exit 0 without a terminal event', async () => {
    const recovered = setup();
    expect((await runCodex(options(recovered, 'recovered'))).outcome).toMatchObject({ status: 'completed', recoveredErrors: { count: 1 } });
    const after = setup();
    expect((await runCodex(options(after, 'error-after-completed'))).outcome).toMatchObject({ status: 'failed', reason: 'error-with-completed-turn' });
    const silent = setup();
    expect((await runCodex(options(silent, 'exit0-no-terminal'))).outcome).toMatchObject({ status: 'unknown', reason: 'exit-0-without-terminal-event' });
  }, SLOW);

  test('malformed lines, unknown types and a torn tail stay inspectable and do not fail the run', async () => {
    const s = setup();
    const outcome = (await runCodex(options(s, 'malformed'))).outcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.stream.malformed).toBe(2);
    expect(outcome.stream.unknownEventTypes).toEqual({ 'mystery.event': 1 });
    expect(outcome.stream.unknownItemTypes).toEqual({ hologram: 1 });
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toEqual(expect.arrayContaining([ 'malformed-lines', 'unknown-event-types', 'unknown-item-types', 'torn-tail' ]));
  }, SLOW);

  test('a final message that differs from the stream is kept as native wrote it, with a diagnostic', async () => {
    const s = setup();
    const outcome = (await runCodex(options(s, 'mismatch'))).outcome;
    expect(outcome).toMatchObject({ status: 'completed', finalMessage: { text: 'backfilled text', matchesStream: false } });
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain('final-message-differs-from-stream');
  }, SLOW);

  test('native warnings are kept and are not failures', async () => {
    const s = setup();
    const outcome = (await runCodex(options(s, 'warning'))).outcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.warnings).toEqual([ 'config warning' ]);
  }, SLOW);

  test('launcher refusals at exit 3 and 1, a plain wrapper, and a native config error are told apart', async () => {
    for (const mode of [ 'launcher-refuse', 'launcher-refuse-1' ]) {
      const refused = setup();
      expect((await runCodex(options(refused, mode, { codexPath: makeFakeLauncher(refused.dir) }))).outcome).toMatchObject({ status: 'refused', reason: 'launcher-refused', failure: { source: 'launcher' } });
    }
    const wrapper = setup();
    expect((await runCodex(options(wrapper, 'launcher-refuse-1'))).outcome).toMatchObject({ status: 'failed', reason: 'wrapper-error', executableClass: 'script' });
    const config = setup();
    expect((await runCodex(options(config, 'config-error'))).outcome).toMatchObject({ status: 'failed', reason: 'native-error', failure: { native: 'config' } });
  }, SLOW);

  test('an abort interrupts native with SIGINT, reaps its group, and keeps custody', async () => {
    const s = setup();
    const controller = new AbortController();
    const result = await runCodex(options(s, 'hang', { signal: controller.signal, onEvent: abortOnCommand(controller) }));
    expect(result.outcome).toMatchObject({ status: 'stopped', reason: 'stopped-by-abort', stop: { cause: 'abort', nativeSignal: 'SIGINT', escalated: false, groupState: 'empty' } });
    expect(result.outcome.stop?.groupObservations.at(-1)?.state).toBe('empty');
    expect(result.outcome.custody?.groupState).toBe('empty');
    expect(readSignals(s.dir)).toContain('SIGINT');
    const grandchild = readGrandchild(s.dir);
    expect(grandchild).not.toBeNull();
    expect(await waitFor(() => grandchild === null || !isAlive(grandchild), 2_000)).toBe(true);
    expect(existsSync(result.files.events)).toBe(true);
    expect(existsSync(result.files.outcome)).toBe(true);
  }, SLOW);

  test('a native that ignores SIGINT is killed with its group after the grace', async () => {
    const s = setup();
    const controller = new AbortController();
    const result = await runCodex(options(s, 'ignore-signals', { signal: controller.signal, stopGraceMs: 300, onEvent: abortOnCommand(controller) }));
    expect(result.outcome).toMatchObject({ status: 'stopped', stop: { cause: 'abort', nativeSignal: 'SIGINT', escalated: true } });
    expect(result.outcome.custody?.groupState).toBe('empty');
  }, SLOW);

  test('an abort before the spawn is honoured without spawning native', async () => {
    const s = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await runCodex(options(s, 'hang', { signal: controller.signal }));
    expect(result.outcome).toMatchObject({ status: 'stopped', reason: 'stopped-before-spawn', stop: { cause: 'abort', nativeSignal: null } });
    expect(readFakeLog(s.dir)).toBeNull();
    expect(existsSync(result.files.events)).toBe(false);
    expect(existsSync(result.files.outcome)).toBe(true);
  }, SLOW);

  test('resume puts the thread id after the exec options; a different thread is a diagnostic', async () => {
    const s = setup();
    const outcome = (await runCodex(options(s, 'resume-other-thread', { session: { kind: 'resume', threadId: NEW_THREAD } }))).outcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain('thread-id-mismatch');
    const argv = readFakeLog(s.dir)?.argv ?? [];
    expect(argv.indexOf('--json')).toBeLessThan(argv.indexOf('resume'));
    expect(argv.slice(argv.indexOf('resume'))).toEqual([ 'resume', NEW_THREAD, '-' ]);
  }, SLOW);

  test('an existing output directory is refused before anything is written', async () => {
    const s = setup();
    mkdirSync(s.out);
    await expect(runCodex(options(s, 'ok'))).rejects.toBeInstanceOf(OutputExistsError);
    expect(readFakeLog(s.dir)).toBeNull();
  }, SLOW);

  test('a missing executable and a launcher that would replace a named home are refusals on record', async () => {
    const missing = setup();
    const result = await runCodex(options(missing, 'ok', { codexPath: join(missing.dir, 'missing') }));
    expect(result.outcome.refusals.map(refusal => refusal.code)).toEqual([ 'executable-not-found' ]);
    const launcher = setup();
    const conflict = await runCodex(options(launcher, 'ok', { codexPath: makeFakeLauncher(launcher.dir), home: { kind: 'path', codexHome: join(launcher.dir, 'named-home') } }));
    expect(conflict.outcome.refusals.map(refusal => refusal.code)).toEqual([ 'launcher-replaces-home' ]);
    expect(conflict.executable?.class).toBe('switch-launcher');
  }, SLOW);

  test('a native that exits before reading stdin is a native failure', async () => {
    const s = setup();
    const outcome = (await runCodex(options(s, 'early-exit'))).outcome;
    expect(outcome).toMatchObject({ status: 'failed', reason: 'exit-without-turn' });
    expect(outcome.detail).toContain('the executable (script) exited 2');
  }, SLOW);

  test('processes native leaves in its group after exiting on its own are reported, not signalled', async () => {
    const s = setup();
    const result = await runCodex(options(s, 'leave-child'));
    const grandchild = readGrandchild(s.dir);
    try {
      expect(result.outcome.status).toBe('completed');
      expect(result.outcome.custody?.groupState).toBe('occupied');
      expect(result.outcome.custody?.groupObservations).toEqual([ { elapsedMs: 0, state: 'occupied' } ]);
      expect(result.outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain('leftover-processes');
      expect(grandchild !== null && isAlive(grandchild)).toBe(true);
    } finally {
      if (grandchild !== null && isAlive(grandchild)) {
        process.kill(grandchild, 'SIGKILL');
      }
    }
  }, SLOW);
});
