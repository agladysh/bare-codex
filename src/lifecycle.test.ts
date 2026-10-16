import { describe, expect, test } from 'bun:test';
import {
  asStopCause,
  codexStopSource,
  exitStatusForCause,
  guardCustody,
  superviseCodex,
  type CodexSupervisorEvent,
  type SignalSource,
  type StopSignal,
} from './lifecycle.ts';

/** Delivers signals by hand, so no test sends any to itself. */
class FakeSignals implements SignalSource {
  readonly listeners = new Map<StopSignal, Set<() => void>>();

  on(signal: StopSignal, listener: () => void): void {
    const set = this.listeners.get(signal) ?? new Set();
    set.add(listener);
    this.listeners.set(signal, set);
  }

  off(signal: StopSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  deliver(signal: StopSignal): void {
    for (const listener of [ ...(this.listeners.get(signal) ?? []) ]) {
      listener();
    }
  }

  count(): number {
    return [ ...this.listeners.values() ].reduce((sum, set) => sum + set.size, 0);
  }
}

/** A stand-in for a spawned process: records signals and exits on the ones it is told to. */
class MockProcess {
  readonly pid = 4_190_001;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: (number | NodeJS.Signals | undefined)[] = [];
  readonly exited: Promise<number>;
  #resolve: (code: number) => void = () => undefined;

  constructor(readonly exitOn: readonly NodeJS.Signals[]) {
    this.exited = new Promise(resolve => {
      this.#resolve = resolve;
    });
  }

  kill(signal?: number | NodeJS.Signals): void {
    this.sent.push(signal);
    if (typeof signal === 'string' && this.exitOn.includes(signal) && this.exitCode === null && this.signalCode === null) {
      this.signalCode = signal;
      this.#resolve(128);
    }
  }
}

describe('superviseCodex', () => {
  test('any stop signal reaches native as SIGINT, and the real cause is kept', async () => {
    const signals = new FakeSignals();
    const events: CodexSupervisorEvent[] = [];
    const supervision = superviseCodex({ graceMs: 5_000, listen: [ 'SIGHUP', 'SIGINT', 'SIGTERM' ], base: signals, onEvent: event => events.push(event) });
    expect(signals.count()).toBe(3);
    const subprocess = new MockProcess([ 'SIGINT' ]);
    supervision.supervisor.attach({ subprocess, processGroup: null });
    signals.deliver('SIGTERM');
    const report = await supervision.supervisor.finish();
    expect(subprocess.sent).toEqual([ 'SIGINT' ]);
    expect(report?.signal).toBe('SIGINT');
    expect(report?.escalated).toBe(false);
    expect(supervision.firstCause()).toBe('SIGTERM');
    expect(events[0]).toMatchObject({ kind: 'stopping', cause: 'SIGTERM', nativeSignal: 'SIGINT' });
    expect(signals.count()).toBe(0);
  });

  test('a second stop request escalates to SIGKILL at once', async () => {
    const signals = new FakeSignals();
    const supervision = superviseCodex({ graceMs: 60_000, listen: [ 'SIGINT', 'SIGHUP' ], base: signals });
    const subprocess = new MockProcess([ 'SIGKILL' ]);
    supervision.supervisor.attach({ subprocess, processGroup: null });
    signals.deliver('SIGINT');
    signals.deliver('SIGHUP');
    const report = await supervision.supervisor.finish();
    expect(subprocess.sent).toEqual([ 'SIGINT', 'SIGKILL' ]);
    expect(report?.escalated).toBe(true);
  });

  test('an abort before the run exists is held and acted on at attach', async () => {
    const events: CodexSupervisorEvent[] = [];
    const supervision = superviseCodex({ graceMs: 5_000, listen: [], base: new FakeSignals(), onEvent: event => events.push(event) });
    supervision.source.request('abort');
    expect(events).toEqual([ { kind: 'held', cause: 'abort' } ]);
    const subprocess = new MockProcess([ 'SIGINT' ]);
    supervision.supervisor.attach({ subprocess, processGroup: null });
    const report = await supervision.supervisor.finish();
    expect(subprocess.sent).toEqual([ 'SIGINT' ]);
    expect(report?.signal).toBe('SIGINT');
    expect(supervision.firstCause()).toBe('abort');
  });

  test('finish without a stop stops nothing', async () => {
    const supervision = superviseCodex({ graceMs: 5_000, listen: [], base: new FakeSignals() });
    const subprocess = new MockProcess([]);
    subprocess.exitCode = 0;
    supervision.supervisor.attach({ subprocess, processGroup: null });
    expect(await supervision.supervisor.finish()).toBeNull();
    expect(subprocess.sent).toEqual([]);
  });
});

describe('codexStopSource', () => {
  test('serves SIGINT supervision only, and installs nothing when told to listen to nothing', () => {
    const signals = new FakeSignals();
    const source = codexStopSource({ listen: [], base: signals });
    expect(() => source.on('SIGTERM', () => undefined)).toThrow();
    source.on('SIGINT', () => undefined);
    expect(signals.count()).toBe(0);
    expect(() => source.on('SIGINT', () => undefined)).toThrow();
  });
});

test('exit statuses and causes read back from records', () => {
  expect(exitStatusForCause('SIGINT')).toBe(130);
  expect(exitStatusForCause('SIGTERM')).toBe(143);
  expect(exitStatusForCause('abort')).toBeNull();
  expect(asStopCause('SIGHUP')).toBe('SIGHUP');
  expect(asStopCause('internal')).toBe('internal');
  expect(asStopCause('SIGUSR1')).toBeNull();
});

test('the custody guard records late signals, signals nothing, and releases its handlers', () => {
  const signals = new FakeSignals();
  const guard = guardCustody([ 'SIGINT', 'SIGTERM' ], signals);
  expect(signals.count()).toBe(2);
  signals.deliver('SIGINT');
  expect(guard.received).toEqual([ 'SIGINT' ]);
  guard.release();
  guard.release();
  expect(signals.count()).toBe(0);
});
