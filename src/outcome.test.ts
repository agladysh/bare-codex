import { describe, expect, test } from 'bun:test';
import { reduceEvents } from './events.ts';
import { AUTH_FAILURE_MESSAGES, conclude, refusedOutcome, spawnFailedOutcome, stoppedBeforeSpawnOutcome } from './outcome.ts';

const LF = String.fromCharCode(10);
const THREAD = '0199a000-0000-7000-8000-000000000001';
const OTHER = '0199a000-0000-7000-8000-0000000000aa';
const usage = { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };

function stream(...events: object[]) {
  return reduceEvents(events.map(event => JSON.stringify(event)).join(LF) + LF);
}

const started = { type: 'thread.started', thread_id: THREAD };
const agent = (text: string) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });
const completed = { type: 'turn.completed', usage };
const exit0 = { code: 0, signal: null };
const exit1 = { code: 1, signal: null };

describe('conclude', () => {
  test('completed only with turn.completed and exit 0', () => {
    const outcome = conclude({ stream: stream(started, agent('hi'), completed), exit: exit0, lastMessage: 'hi' });
    expect(outcome.status).toBe('completed');
    expect(outcome.threadId).toBe(THREAD);
    expect(outcome.finalMessage).toMatchObject({ text: 'hi', matchesStream: true });
    expect(outcome.usage).toEqual(usage);
    expect(outcome.detail).toContain('not a judgement of the task');
  });

  test('exit 0 without a terminal event is unknown, not completed', () => {
    expect(conclude({ stream: stream(started), exit: exit0 })).toMatchObject({ status: 'unknown', reason: 'exit-0-without-terminal-event' });
  });

  test('turn.failed is a failure with its message, and an exact auth message is classified', () => {
    const plain = conclude({ stream: stream(started, { type: 'turn.failed', error: { message: 'boom' } }), exit: exit1 });
    expect(plain).toMatchObject({ status: 'failed', reason: 'turn-failed', failure: { source: 'turn.failed', message: 'boom', auth: null } });
    const reused = conclude({ stream: stream(started, { type: 'turn.failed', error: { message: AUTH_FAILURE_MESSAGES['refresh-token-reused'] } }), exit: exit1 });
    expect(reused.failure?.auth).toBe('refresh-token-reused');
  });

  test('an agent message that quotes an auth message classifies nothing', () => {
    const outcome = conclude({ stream: stream(started, agent(AUTH_FAILURE_MESSAGES['refresh-token-expired']), completed), exit: exit0, lastMessage: AUTH_FAILURE_MESSAGES['refresh-token-expired'] });
    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();
  });

  test('errors before a completed turn with exit 0 are recovered errors', () => {
    const outcome = conclude({ stream: stream(started, { type: 'error', message: 'Reconnecting... 1/5' }, agent('ok'), completed), exit: exit0, lastMessage: 'ok' });
    expect(outcome.status).toBe('completed');
    expect(outcome.recoveredErrors).toEqual({ count: 1, messages: [ 'Reconnecting... 1/5' ] });
  });

  test('a completed turn with a non-zero exit is a failure native judged unrecovered', () => {
    const outcome = conclude({ stream: stream(started, { type: 'error', message: 'fatal' }, completed), exit: exit1, lastMessage: '' });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'error-with-completed-turn', failure: { source: 'error', message: 'fatal' } });
  });

  test('a launcher refusal is told by executable class and line prefix, at any non-zero exit', () => {
    const tail = `codex: no account is selected for this run${LF}hint${LF}`;
    for (const code of [ 1, 3 ]) {
      expect(conclude({ stream: stream(), exit: { code, signal: null }, stderrTail: tail, executableClass: 'switch-launcher' })).toMatchObject({ status: 'refused', reason: 'launcher-refused', failure: { source: 'launcher' }, executableClass: 'switch-launcher' });
    }
    expect(conclude({ stream: stream(), exit: exit1, stderrTail: tail, executableClass: 'script' })).toMatchObject({ status: 'failed', reason: 'wrapper-error', failure: { source: 'launcher' } });
    const native = conclude({ stream: stream(), exit: { code: 3, signal: null }, stderrTail: tail, executableClass: 'native-binary' });
    expect(native).toMatchObject({ status: 'failed', reason: 'exit-without-turn' });
    expect(native.detail).toContain('native exited 3');
    expect(conclude({ stream: stream(), exit: exit1, stderrTail: tail }).detail).toContain('the executable exited 1');
  });

  test('a launcher note does not hide a native configuration or authentication failure', () => {
    for (const message of ['Error loading config.toml: unknown field', AUTH_FAILURE_MESSAGES['refresh-token-expired']]) {
      const outcome = conclude({ stream: stream(), exit: exit1, stderrTail: `codex: using selected account${LF}${message}${LF}`, executableClass: 'switch-launcher' });
      expect(outcome).toMatchObject({ status: 'failed', reason: 'native-error', failure: { source: 'stderr' } });
    }
  });

  test('a numeric signal is kept as observed', () => {
    expect(conclude({ stream: stream(started), exit: { code: null, signal: 31 } })).toMatchObject({ status: 'unknown', reason: 'killed-by-signal', exit: { signal: 31 } });
  });

  test('a native stderr failure is classified by its exact prefix', () => {
    const outcome = conclude({ stream: stream(), exit: exit1, stderrTail: `Error loading config.toml:${LF}unknown field${LF}` });
    expect(outcome).toMatchObject({ status: 'failed', reason: 'native-error', failure: { native: 'config' } });
  });

  test('a stop before the terminal event is stopped; a stop after it is only a diagnostic', () => {
    const stop = { cause: 'SIGTERM', nativeSignal: 'SIGINT', escalated: false, groupState: 'empty', groupObservations: [ { elapsedMs: 0, state: 'empty' } ] };
    expect(conclude({ stream: stream(started), exit: exit1, stop })).toMatchObject({ status: 'stopped', reason: 'stopped-by-SIGTERM', stop });
    const late = conclude({ stream: stream(started, agent('x'), completed), exit: exit0, lastMessage: 'x', stop });
    expect(late.status).toBe('completed');
    expect(late.diagnostics.map(diagnostic => diagnostic.code)).toContain('stop-after-terminal-event');
  });

  test('a final message that differs from the stream is a diagnostic, not a failure', () => {
    const outcome = conclude({ stream: stream(started, agent('streamed'), completed), exit: exit0, lastMessage: 'backfilled' });
    expect(outcome.status).toBe('completed');
    expect(outcome.finalMessage).toMatchObject({ text: 'backfilled', matchesStream: false });
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain('final-message-differs-from-stream');
  });

  test('thread identity after resume and fork is checked, as a diagnostic', () => {
    const resumed = conclude({ stream: stream({ type: 'thread.started', thread_id: OTHER }, completed), exit: exit0, lastMessage: '', session: { kind: 'resume', threadId: THREAD } });
    expect(resumed.diagnostics.map(diagnostic => diagnostic.code)).toContain('thread-id-mismatch');
    const forked = conclude({ stream: stream(started, completed), exit: exit0, lastMessage: '', session: { kind: 'fork', threadId: THREAD } });
    expect(forked.diagnostics.map(diagnostic => diagnostic.code)).toContain('fork-kept-source-thread');
  });

  test('an unmeasured native version is surfaced', () => {
    const outcome = conclude({ stream: stream(started, completed), exit: exit0, lastMessage: '', nativeVersion: '0.170.0' });
    expect(outcome.diagnostics.map(diagnostic => diagnostic.code)).toContain('native-version-unmeasured');
  });

  test('an end by a signal bare-codex did not send is unknown', () => {
    expect(conclude({ stream: stream(started), exit: { code: null, signal: 'SIGKILL' } })).toMatchObject({ status: 'unknown', reason: 'killed-by-signal' });
  });
});

test('refused and spawn-failed outcomes have the same shape', () => {
  expect(refusedOutcome([ { code: 'prompt-empty', message: 'empty' } ])).toMatchObject({ status: 'refused', reason: 'preflight-refused', refusals: [ { code: 'prompt-empty' } ] });
  expect(spawnFailedOutcome('ENOENT')).toMatchObject({ status: 'spawn-failed', failure: { source: 'spawn' } });
  expect(stoppedBeforeSpawnOutcome('abort')).toMatchObject({ status: 'stopped', reason: 'stopped-before-spawn', stop: { cause: 'abort', nativeSignal: null }, exit: null });
});
