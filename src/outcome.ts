/**
 * The conclusion: a pure function from what a run produced to what can be
 * said about it, and no more.
 *
 * - `completed` means native reported `turn.completed` and exited 0. It says
 *   nothing about whether the task was done.
 * - A subprocess exit alone never makes a run `completed`.
 * - Failure classes come from native's own channels only: the `turn.failed`
 *   error, top-level `error` events and stderr, matched against exact native
 *   strings. Agent messages (model text) are never read for auth, refusal or
 *   protocol outcomes.
 * - Failures are attributed by executable class: a launcher's or wrapper's
 *   refusal is not blamed on native.
 * - A final message that differs from the last streamed agent message, an
 *   unknown event type or a torn line is a diagnostic, not a failure.
 */

import { createHash } from 'node:crypto';
import { initialStreamState, type StreamState, type Usage } from './events.ts';
import { MEASURED_NATIVE_VERSION } from './plan.ts';
import type { ExecutableClass, Refusal, SessionPolicy } from './types.ts';

/** The refresh-failure messages of codex 0.162.1, verbatim (codex-rs/login/src/auth/manager.rs:206-211). Matched whole. */
export const AUTH_FAILURE_MESSAGES = {
  'refresh-token-expired': 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.',
  'refresh-token-reused': 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
  'refresh-token-revoked': 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.',
  'account-mismatch': 'Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.',
  'refresh-failed': 'Your access token could not be refreshed. Please log out and sign in again.',
} as const;

export type AuthFailure = keyof typeof AUTH_FAILURE_MESSAGES;

const authFailures: readonly AuthFailure[] = [ 'refresh-token-expired', 'refresh-token-reused', 'refresh-token-revoked', 'account-mismatch', 'refresh-failed' ];

export type NativeFailureClass = 'config' | 'config-override' | 'rules' | 'untrusted-directory' | 'prompt' | 'output-schema' | 'home';

/** Lines codex exec 0.162.1 writes to stderr before exiting 1, by prefix (sources in codex-rs/exec/src/lib.rs). */
export const NATIVE_STDERR_FAILURES: readonly { prefix: string, class: NativeFailureClass, source: string }[] = [
  { prefix: 'Error loading config.toml', class: 'config', source: 'exec/src/lib.rs:836-849' },
  { prefix: 'Error parsing -c overrides', class: 'config-override', source: 'exec/src/lib.rs:350-357' },
  { prefix: 'Error loading rules:', class: 'rules', source: 'exec/src/lib.rs:643-652' },
  { prefix: 'Not inside a trusted directory and --skip-git-repo-check was not specified.', class: 'untrusted-directory', source: 'exec/src/lib.rs:1013-1019' },
  { prefix: 'No prompt provided via stdin.', class: 'prompt', source: 'exec/src/lib.rs:2346-2352' },
  { prefix: 'Failed to read prompt from stdin', class: 'prompt', source: 'exec/src/lib.rs:2333-2343' },
  { prefix: 'Failed to read output schema file', class: 'output-schema', source: 'exec/src/lib.rs:2216-2224' },
  { prefix: 'Output schema file ', class: 'output-schema', source: 'exec/src/lib.rs:2227-2234' },
  { prefix: 'Error finding codex home', class: 'home', source: 'exec/src/lib.rs:369-375' },
];

/**
 * The stderr prefix of an account-switching launcher's own messages (its
 * program name). It is one launcher's convention, so it is read only when
 * the executable is not a native binary and native produced no event.
 */
export const LAUNCHER_LINE_PREFIX = 'codex: ';

export type OutcomeStatus =
  /** Native reported turn.completed and exited 0. */
  | 'completed'
  /** A failure: turn.failed, an error native did not recover from, or a non-zero exit. */
  | 'failed'
  /** bare-codex stopped the run, before native reported the turn's end or before spawning it. */
  | 'stopped'
  /** Not started: a preflight refusal, or an account-switching launcher's refusal. */
  | 'refused'
  /** The process could not be spawned. */
  | 'spawn-failed'
  /** Nothing conclusive: no terminal event and nothing that says why. */
  | 'unknown';

export interface FailureFacts {
  source: 'turn.failed' | 'error' | 'stderr' | 'exit' | 'launcher' | 'spawn',
  message: string,
  /** An exact native auth message found in this failure or in stderr. */
  auth: AuthFailure | null,
  /** A native stderr failure prefix found. */
  native: NativeFailureClass | null,
}

export interface StopFacts {
  /** What started the stop: a received signal, the caller's abort, or bare-codex itself. */
  cause: string,
  /** The signal native was sent first; null when nothing had been spawned. */
  nativeSignal: string | null,
  /** Whether SIGKILL followed. */
  escalated: boolean,
  /** The process group's state when the stop ended. */
  groupState: string | null,
}

export interface CustodyFacts {
  processGroup: number | null,
  /** The group's state after supervision ended. Empty does not show that descendants in other groups ended. */
  groupState: string | null,
  stdoutDrained: boolean,
  stderrDrained: boolean,
  writeError: string | null,
  stdinError: string | null,
  /** Stop signals received after native had exited, while custody was closed; recorded, not acted on. */
  signalsDuringCustody: string[],
}

export interface Diagnostic {
  code: string,
  detail: string,
}

export interface FinalMessage {
  /** The native last-message file, which native writes only when the turn completed. */
  text: string | null,
  sha256: string | null,
  /** SHA-256 of the last streamed agent_message. */
  streamSha256: string | null,
  /** Null when either side is absent. */
  matchesStream: boolean | null,
}

export interface CodexOutcome {
  schema: 'bare-codex.outcome/v1',
  status: OutcomeStatus,
  /** A short machine-readable reason. */
  reason: string,
  detail: string,
  threadId: string | null,
  threadIds: string[],
  turn: { terminal: 'completed' | 'failed' | null, terminalEvents: number, turnsStarted: number },
  failure: FailureFacts | null,
  /** `error` events before a completed turn with exit 0: native's own judgement that it recovered. */
  recoveredErrors: { count: number, messages: string[] },
  finalMessage: FinalMessage,
  usage: Usage | null,
  /** As observed; a numeric signal is kept as a number. */
  exit: { code: number | null, signal: number | string | null } | null,
  stop: StopFacts | null,
  custody: CustodyFacts | null,
  refusals: Refusal[],
  /** The class of the executable that was run, when known. */
  executableClass: ExecutableClass | null,
  stream: {
    lines: number,
    events: number,
    malformed: number,
    shapeAnomalies: number,
    errors: number,
    warnings: number,
    eventTypes: Record<string, number>,
    unknownEventTypes: Record<string, number>,
    unknownItemTypes: Record<string, number>,
  },
  /** Native warning items (item.completed of type error), the most recent ones. */
  warnings: string[],
  diagnostics: Diagnostic[],
  nativeVersion: string | null,
}

export interface ConcludeInput {
  stream: StreamState,
  exit: { code: number | null, signal: number | string | null },
  /** The last part of the executable's stderr. */
  stderrTail?: string,
  /** The native last-message file's contents; null when it does not exist. */
  lastMessage?: string | null,
  session?: SessionPolicy,
  stop?: StopFacts | null,
  /** What native's `--version` reported, when it was asked. */
  nativeVersion?: string | null,
  /** The class of the executable that was spawned; without it, failures are attributed to "the executable". */
  executableClass?: ExecutableClass | null,
}

const lineFeed = String.fromCharCode(10);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function splitLines(text: string): string[] {
  return text.split(lineFeed).map(line => line.trimEnd()).filter(line => line !== '');
}

/** The exact native auth message `text` contains, if any. */
export function authFailureIn(text: string): AuthFailure | null {
  for (const failure of authFailures) {
    if (text.includes(AUTH_FAILURE_MESSAGES[failure])) {
      return failure;
    }
  }
  return null;
}

/** The first stderr line that starts with a known native failure prefix. */
export function nativeFailureIn(lines: readonly string[]): { class: NativeFailureClass, line: string } | null {
  for (const line of lines) {
    for (const known of NATIVE_STDERR_FAILURES) {
      if (line.startsWith(known.prefix)) {
        return { class: known.class, line };
      }
    }
  }
  return null;
}

function launcherLine(lines: readonly string[]): string | null {
  return lines.find(line => line.startsWith(LAUNCHER_LINE_PREFIX)) ?? null;
}

function failureFacts(source: FailureFacts['source'], message: string, stderrLines: readonly string[]): FailureFacts {
  return {
    source,
    message,
    auth: authFailureIn(message) ?? authFailureIn(stderrLines.join(lineFeed)),
    native: nativeFailureIn(stderrLines)?.class ?? null,
  };
}

function subject(executableClass: ExecutableClass | null): string {
  if (executableClass === 'native-binary') {
    return 'native';
  }
  return executableClass === null ? 'the executable' : `the executable (${executableClass})`;
}

function streamSummary(stream: StreamState): CodexOutcome['stream'] {
  return {
    lines: stream.lines,
    events: stream.events,
    malformed: stream.malformed,
    shapeAnomalies: stream.shapeAnomalies,
    errors: stream.errorCount,
    warnings: stream.warningCount,
    eventTypes: stream.eventTypes,
    unknownEventTypes: stream.unknownEventTypes,
    unknownItemTypes: stream.unknownItemTypes,
  };
}

function streamDiagnostics(stream: StreamState, session: SessionPolicy): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (stream.events > 0 && stream.threadIds.length === 0) {
    out.push({ code: 'no-thread-started', detail: 'events arrived but none was a thread.started with a thread id' });
  }
  if (stream.threadIds.length > 1) {
    out.push({ code: 'multiple-thread-ids', detail: `thread.started named ${stream.threadIds.length} different threads: ${stream.threadIds.join(', ')}` });
  }
  const first = stream.threadIds[0];
  if (session.kind === 'resume' && first !== undefined && first !== session.threadId) {
    out.push({ code: 'thread-id-mismatch', detail: `resumed ${session.threadId}, but native reported thread ${first}` });
  }
  if (session.kind === 'fork' && first !== undefined && first === session.threadId) {
    out.push({ code: 'fork-kept-source-thread', detail: `forked ${session.threadId}, but native reported the same thread id` });
  }
  if (stream.malformed > 0) {
    out.push({ code: 'malformed-lines', detail: `${stream.malformed} line(s) were not JSON events; the raw bytes are in events.jsonl` });
  }
  if (stream.shapeAnomalies > 0) {
    out.push({ code: 'shape-anomalies', detail: `${stream.shapeAnomalies} known event(s) lacked fields 0.162.1 always sends: possible protocol drift` });
  }
  const unknownEvents = Object.keys(stream.unknownEventTypes);
  if (unknownEvents.length > 0) {
    out.push({ code: 'unknown-event-types', detail: `event types not in the 0.162.1 vocabulary: ${unknownEvents.join(', ')}` });
  }
  const unknownItems = Object.keys(stream.unknownItemTypes);
  if (unknownItems.length > 0) {
    out.push({ code: 'unknown-item-types', detail: `item types not in the 0.162.1 vocabulary: ${unknownItems.join(', ')}` });
  }
  if (stream.tornTail !== null) {
    out.push({ code: 'torn-tail', detail: `the stream ended with ${stream.tornTail.bytes} byte(s) after the last newline${stream.tornTail.parses ? ` (parseable as ${stream.tornTail.type ?? 'an event'}, not counted)` : ''}` });
  }
  if (stream.terminalEvents > 1) {
    out.push({ code: 'multiple-terminal-events', detail: `${stream.terminalEvents} terminal events; the first one is used` });
  }
  if (stream.eventsAfterTerminal > 0) {
    out.push({ code: 'events-after-terminal', detail: `${stream.eventsAfterTerminal} event(s) arrived after the first terminal event` });
  }
  if (stream.errorsAfterTerminal > 0) {
    out.push({ code: 'errors-after-terminal', detail: `${stream.errorsAfterTerminal} error event(s) arrived after the first terminal event` });
  }
  return out;
}

function finalMessageFacts(lastMessage: string | null, stream: StreamState, completedTurn: boolean, diagnostics: Diagnostic[]): FinalMessage {
  const streamed = stream.lastAgentMessage;
  const matchesStream = lastMessage === null || streamed === null ? null : lastMessage === streamed;
  if (completedTurn && lastMessage === null) {
    diagnostics.push({ code: 'last-message-file-missing', detail: 'native reported turn.completed but wrote no last-message file' });
  }
  if (!completedTurn && lastMessage !== null) {
    diagnostics.push({ code: 'last-message-without-completed-turn', detail: 'a last-message file exists although native did not report turn.completed' });
  }
  if (completedTurn && lastMessage === '') {
    diagnostics.push({ code: 'empty-last-message', detail: 'native wrote an empty final message: it had no agent message for this turn (exec/src/event_processor.rs:31-40)' });
  }
  if (matchesStream === false) {
    diagnostics.push({ code: 'final-message-differs-from-stream', detail: 'the last-message file differs from the last streamed agent_message; native may take the final message from a backfilled thread read, a plan item, or after dropped item events (exec/src/lib.rs:1735-1789; event_processor_with_jsonl_output.rs:387-401, 513-537)' });
  }
  if (completedTurn && lastMessage !== null && lastMessage !== '' && streamed === null) {
    diagnostics.push({ code: 'final-message-without-streamed-agent-message', detail: 'native wrote a final message that no streamed agent_message carried (backfill or plan item)' });
  }
  return {
    text: lastMessage,
    sha256: lastMessage === null ? null : sha256Hex(lastMessage),
    streamSha256: streamed === null ? null : sha256Hex(streamed),
    matchesStream,
  };
}

interface Fields {
  status: OutcomeStatus,
  reason: string,
  detail: string,
  failure?: FailureFacts | null,
  recoveredErrors?: { count: number, messages: string[] },
  finalMessage?: FinalMessage,
  exit?: { code: number | null, signal: number | string | null } | null,
  stop?: StopFacts | null,
  refusals?: Refusal[],
  diagnostics?: Diagnostic[],
  nativeVersion?: string | null,
  executableClass?: ExecutableClass | null,
}

function assemble(fields: Fields, stream: StreamState): CodexOutcome {
  return {
    schema: 'bare-codex.outcome/v1',
    status: fields.status,
    reason: fields.reason,
    detail: fields.detail,
    threadId: stream.threadIds[0] ?? null,
    threadIds: [ ...stream.threadIds ],
    turn: { terminal: stream.terminal?.kind ?? null, terminalEvents: stream.terminalEvents, turnsStarted: stream.turnsStarted },
    failure: fields.failure ?? null,
    recoveredErrors: fields.recoveredErrors ?? { count: 0, messages: [] },
    finalMessage: fields.finalMessage ?? { text: null, sha256: null, streamSha256: null, matchesStream: null },
    usage: stream.terminal?.kind === 'completed' ? stream.terminal.usage : null,
    exit: fields.exit ?? null,
    stop: fields.stop ?? null,
    custody: null,
    refusals: fields.refusals ?? [],
    executableClass: fields.executableClass ?? null,
    stream: streamSummary(stream),
    warnings: stream.warnings.map(warning => warning.message),
    diagnostics: fields.diagnostics ?? [],
    nativeVersion: fields.nativeVersion ?? null,
  };
}

/** Concludes a run that was spawned. See the module comment for what each status may claim. */
export function conclude(input: ConcludeInput): CodexOutcome {
  const { stream, exit } = input;
  const session = input.session ?? { kind: 'new' };
  const stop = input.stop ?? null;
  const nativeVersion = input.nativeVersion ?? null;
  const executableClass = input.executableClass ?? null;
  const stderrLines = splitLines(input.stderrTail ?? '');
  const diagnostics = streamDiagnostics(stream, session);
  const terminal = stream.terminal;
  const finalMessage = finalMessageFacts(input.lastMessage ?? null, stream, terminal?.kind === 'completed', diagnostics);
  if (nativeVersion !== null && nativeVersion !== MEASURED_NATIVE_VERSION) {
    diagnostics.push({ code: 'native-version-unmeasured', detail: `native reports ${nativeVersion}; bare-codex was built against ${MEASURED_NATIVE_VERSION}, so protocol details may have drifted: re-check the sources and run the native probe` });
  }

  let status: OutcomeStatus;
  let reason: string;
  let detail: string;
  let failure: FailureFacts | null = null;
  let recoveredErrors = { count: 0, messages: [] as string[] };
  const launcherMessage = launcherLine(stderrLines);
  const nativeLine = nativeFailureIn(stderrLines);
  const authLine = stderrLines.find(line => authFailureIn(line) !== null);

  if (terminal !== null && terminal.kind === 'failed') {
    status = 'failed';
    reason = 'turn-failed';
    failure = failureFacts('turn.failed', terminal.message, stderrLines);
    detail = `native reported turn.failed: ${terminal.message}`;
  } else if (terminal !== null) {
    if (exit.code === 0) {
      status = 'completed';
      reason = 'turn-completed';
      recoveredErrors = {
        count: stream.errorsBeforeTerminal,
        messages: stream.errors.filter(error => error.line < terminal.line).map(error => error.message),
      };
      detail = recoveredErrors.count === 0
        ? 'native reported turn.completed and exited 0; this is a completed native turn, not a judgement of the task'
        : `native reported turn.completed and exited 0 after ${recoveredErrors.count} stream error(s) it recovered from; this is a completed native turn, not a judgement of the task`;
    } else if (exit.code !== null) {
      status = 'failed';
      reason = 'error-with-completed-turn';
      const last = stream.errors.at(-1);
      failure = failureFacts(last === undefined ? 'exit' : 'error', last?.message ?? `native exited ${exit.code} after turn.completed`, stderrLines);
      detail = `native reported turn.completed but exited ${exit.code}: it judged the run failed (an error it did not recover from, or a server request exec could not serve; exec/src/lib.rs:1301-1404, 2070-2211)`;
    } else {
      status = 'unknown';
      reason = 'signal-after-completed-turn';
      detail = `native reported turn.completed, then ended by ${String(exit.signal ?? 'an unobserved exit')} instead of exiting on its own`;
    }
    if (stop !== null) {
      diagnostics.push({ code: 'stop-after-terminal-event', detail: `a stop (${stop.cause}) came after native had reported the end of the turn` });
    }
  } else if (stop !== null) {
    status = 'stopped';
    reason = `stopped-by-${stop.cause}`;
    detail = `stopped (${stop.cause}): ${stop.nativeSignal ?? 'no signal'} went to native first${stop.escalated ? ', then SIGKILL to its process group' : ''}; native reported no terminal event`;
  } else if (exit.code !== null && exit.code !== 0 && stream.events === 0 && launcherMessage !== null && nativeLine === null && authLine === undefined && executableClass !== null && executableClass !== 'native-binary') {
    failure = { source: 'launcher', message: launcherMessage, auth: null, native: null };
    if (executableClass === 'switch-launcher') {
      status = 'refused';
      reason = 'launcher-refused';
      detail = `the account-switching launcher refused to start native Codex (exit ${exit.code}): ${launcherMessage}`;
    } else {
      status = 'failed';
      reason = 'wrapper-error';
      detail = `the ${executableClass} executable exited ${exit.code} before native produced any event: ${launcherMessage}`;
    }
  } else if (exit.code === 0) {
    status = 'unknown';
    reason = 'exit-0-without-terminal-event';
    detail = `${subject(executableClass)} exited 0 without turn.completed or turn.failed, which is not a completion`;
  } else if (exit.code !== null) {
    status = 'failed';
    const last = stream.errors.at(-1);
    if (last !== undefined) {
      reason = 'stream-error';
      failure = failureFacts('error', last.message, stderrLines);
    } else if (nativeLine !== null || authLine !== undefined) {
      reason = 'native-error';
      failure = failureFacts('stderr', nativeLine?.line ?? authLine ?? '', stderrLines);
    } else {
      reason = 'exit-without-turn';
      failure = failureFacts('exit', stderrLines.at(-1) ?? `exit ${exit.code}`, stderrLines);
    }
    detail = `${subject(executableClass)} exited ${exit.code} without a terminal event: ${failure.message}`;
  } else if (exit.signal !== null) {
    status = 'unknown';
    reason = 'killed-by-signal';
    detail = `${subject(executableClass)} ended by signal ${String(exit.signal)}, not by a stop bare-codex made`;
  } else {
    status = 'unknown';
    reason = 'exit-not-observed';
    detail = 'the exit was not observed';
  }

  return assemble({ status, reason, detail, failure, recoveredErrors, finalMessage, exit, stop, diagnostics, nativeVersion, executableClass }, stream);
}

/** The outcome of a run that was not started because of `refusals`. */
export function refusedOutcome(refusals: Refusal[], executableClass: ExecutableClass | null = null): CodexOutcome {
  return assemble({
    status: 'refused',
    reason: 'preflight-refused',
    detail: `not started: ${refusals.map(refusal => refusal.message).join('; ')}`,
    refusals,
    executableClass,
  }, initialStreamState());
}

/** The outcome of a run stopped before anything was spawned: nothing was started and nothing was sent. */
export function stoppedBeforeSpawnOutcome(cause: string, executableClass: ExecutableClass | null = null, nativeVersion: string | null = null): CodexOutcome {
  return assemble({
    status: 'stopped',
    reason: 'stopped-before-spawn',
    detail: `stopped (${cause}) before native was spawned; nothing was started and nothing was sent`,
    stop: { cause, nativeSignal: null, escalated: false, groupState: null },
    executableClass,
    nativeVersion,
  }, initialStreamState());
}

/** The outcome of a run whose process could not be spawned. */
export function spawnFailedOutcome(message: string, executableClass: ExecutableClass | null = null): CodexOutcome {
  return assemble({
    status: 'spawn-failed',
    reason: 'spawn-failed',
    detail: message,
    failure: { source: 'spawn', message, auth: null, native: null },
    executableClass,
  }, initialStreamState());
}
