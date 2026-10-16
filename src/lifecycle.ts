/**
 * Stopping a Codex run, on bare-claude's public lifecycle module
 * (`@agladysh/bare-claude/lifecycle`, pinned by commit in package.json) rather
 * than a copy of it.
 *
 * Why an adapter: `codex exec` 0.162.1 turns only SIGINT into a native turn
 * interruption. It waits for `tokio::signal::ctrl_c()` once and then sends
 * `turn/interrupt` (codex-rs/exec/src/lib.rs:1190-1196, 1305-1327); SIGTERM
 * and SIGHUP keep their default action and end the process without one. A
 * second SIGINT is absorbed by the same handler, so escalation has to be
 * SIGKILL, which is what lifecycle's escalation sends.
 *
 * `superviseSignals` sends a stopped run the signal that stopped it. Its
 * `SignalSource` seam decides what that is: the source here listens for
 * SIGHUP, SIGINT and SIGTERM (or for nothing, for a library caller with its
 * own signal policy) and reports every one of them to the supervisor as
 * SIGINT, while recording which one actually arrived. A caller's abort and an
 * internal stop take the same path. Everything else is lifecycle's own: only
 * the spawned process and the group it leads are ever signalled, a stop that
 * arrives before the spawn is held, a second stop request escalates, and
 * custody waits for the stop to end.
 *
 * One residual: `Supervisor.finish()` stops a run it finds still going with
 * SIGTERM. `runCodex` never relies on that: it asks this source for an
 * internal SIGINT stop first, so `finish()` only waits.
 */

import {
  processGroupState,
  signalExitStatus,
  stopSignals,
  superviseSignals,
  type ProcessGroupState,
  type SignalSource,
  type StopReport,
  type StopSignal,
  type StoppableRun,
  type Supervisor,
  type SupervisorEvent,
} from '@agladysh/bare-claude/lifecycle';

export { processGroupState, signalExitStatus, stopSignals };
export type { ProcessGroupState, SignalSource, StopReport, StopSignal, StoppableRun, Supervisor };

/** The one signal native Codex turns into a turn interruption. */
export const NATIVE_INTERRUPT_SIGNAL = 'SIGINT' satisfies StopSignal;

/** What started a stop: a received signal, the caller's abort, or bare-codex itself. */
export type StopCause = StopSignal | 'abort' | 'internal';

/** A stop cause that is a signal, and so has a shell exit status. */
export function isSignalCause(cause: StopCause): cause is StopSignal {
  return cause !== 'abort' && cause !== 'internal';
}

/** Reads a stop cause back from a record. */
export function asStopCause(value: string): StopCause | null {
  if (value === 'abort' || value === 'internal') {
    return value;
  }
  return stopSignals.find(signal => signal === value) ?? null;
}

/** 128 plus the signal number for a signal cause; null for an abort or an internal stop. */
export function exitStatusForCause(cause: StopCause): number | null {
  return isSignalCause(cause) ? signalExitStatus(cause) : null;
}

/** A signal source that reports every stop as SIGINT and remembers what really arrived. */
export interface CodexStopSource extends SignalSource {
  /** Every stop cause, in arrival order. */
  readonly causes: readonly StopCause[],

  /** Requests a stop that did not come from a signal. */
  request(cause: 'abort' | 'internal'): void,
}

const processSignals: SignalSource = {
  on: (signal, listener) => {
    process.on(signal, listener);
  },
  off: (signal, listener) => {
    process.off(signal, listener);
  },
};

/**
 * The adapter. `listen` names the real signals to take over (none for a
 * library caller with its own signal policy); `base` is where they come from,
 * this process by default.
 */
export function codexStopSource(options: { listen: readonly StopSignal[], base?: SignalSource }): CodexStopSource {
  const base = options.base ?? processSignals;
  const causes: StopCause[] = [];
  const installed = new Map<StopSignal, () => void>();
  let listener: (() => void) | null = null;
  return {
    causes,
    on(signal, onSignal) {
      if (signal !== NATIVE_INTERRUPT_SIGNAL) {
        throw new Error(`a Codex stop source reports every stop as ${NATIVE_INTERRUPT_SIGNAL}; supervise ${NATIVE_INTERRUPT_SIGNAL} only, not ${signal}`);
      }
      if (listener !== null) {
        throw new Error('a Codex stop source serves one supervisor');
      }
      listener = onSignal;
      for (const received of new Set(options.listen)) {
        const handler = () => {
          causes.push(received);
          onSignal();
        };
        installed.set(received, handler);
        base.on(received, handler);
      }
    },
    off(signal, onSignal) {
      if (signal !== NATIVE_INTERRUPT_SIGNAL || listener !== onSignal) {
        return;
      }
      for (const [ received, handler ] of installed) {
        base.off(received, handler);
      }
      installed.clear();
      listener = null;
    },
    request(cause) {
      causes.push(cause);
      listener?.();
    },
  };
}

/** A supervisor event with the stop cause that really arrived. */
export type CodexSupervisorEvent =
  /** A stop arrived before the run existed; native is interrupted as soon as it does. */
  | { kind: 'held', cause: StopCause }
  /** A stop began; `nativeSignal` went to native first. `finish` is lifecycle's own SIGTERM fallback. */
  | { kind: 'stopping', cause: StopCause | 'finish', nativeSignal: StopSignal, pid: number, processGroup: number | null, graceMs: number }
  /** A further stop request during a stop: SIGKILL now. */
  | { kind: 'escalating', cause: StopCause }
  /** A stop request after native had exited on its own. */
  | { kind: 'after-exit', cause: StopCause };

export interface CodexSupervision {
  supervisor: Supervisor,
  source: CodexStopSource,
  /** The first stop cause that arrived; null when none did. */
  firstCause(): StopCause | null,
}

/**
 * Supervision for one Codex run: lifecycle's `superviseSignals` over a
 * {@link codexStopSource}. Create it before spawning, attach the run as soon
 * as it exists, and finish it before closing custody.
 */
export function superviseCodex(options: {
  graceMs: number,
  listen: readonly StopSignal[],
  base?: SignalSource,
  onEvent?: (event: CodexSupervisorEvent) => void,
}): CodexSupervision {
  const source = codexStopSource({ listen: options.listen, base: options.base });
  const latest = (): StopCause => source.causes.at(-1) ?? NATIVE_INTERRUPT_SIGNAL;
  const translate = (event: SupervisorEvent): CodexSupervisorEvent => {
    switch (event.kind) {
      case 'held':
        return { kind: 'held', cause: latest() };
      case 'stopping':
        return event.cause === 'finish'
          ? { kind: 'stopping', cause: 'finish', nativeSignal: 'SIGTERM', pid: event.pid, processGroup: event.processGroup, graceMs: event.graceMs }
          : { kind: 'stopping', cause: source.causes[0] ?? latest(), nativeSignal: NATIVE_INTERRUPT_SIGNAL, pid: event.pid, processGroup: event.processGroup, graceMs: event.graceMs };
      case 'escalating':
        return { kind: 'escalating', cause: latest() };
      case 'after-exit':
        return { kind: 'after-exit', cause: latest() };
    }
  };
  const onEvent = options.onEvent;
  const supervisor = superviseSignals({
    graceMs: options.graceMs,
    signals: [ NATIVE_INTERRUPT_SIGNAL ],
    source,
    onEvent: onEvent === undefined ? undefined : event => onEvent(translate(event)),
  });
  return { supervisor, source, firstCause: () => source.causes[0] ?? null };
}

/** Signals that arrived while custody was being closed, after native had exited. */
export interface CustodyGuard {
  readonly received: readonly StopSignal[],
  release(): void,
}

/**
 * Keeps `listen` signals from ending this process while custody is closed
 * after native has exited: they are recorded and nothing is signalled. Install
 * it before `Supervisor.finish()` removes the supervisor's handlers, and
 * release it once the outcome is written, so a late Ctrl-C cannot lose
 * `outcome.json`.
 */
export function guardCustody(listen: readonly StopSignal[], base: SignalSource = processSignals): CustodyGuard {
  const received: StopSignal[] = [];
  const handlers = new Map<StopSignal, () => void>();
  for (const signal of new Set(listen)) {
    const handler = () => {
      received.push(signal);
    };
    handlers.set(signal, handler);
    base.on(signal, handler);
  }
  const state = { released: false };
  return {
    received,
    release() {
      if (state.released) {
        return;
      }
      state.released = true;
      for (const [ signal, handler ] of handlers) {
        base.off(signal, handler);
      }
    },
  };
}
