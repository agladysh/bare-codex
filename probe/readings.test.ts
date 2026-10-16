import { describe, expect, test } from 'bun:test';
import type { ProcessGroupReading, ProcessGroupState } from '../src/lifecycle.ts';
import { cancelLeftNothing, groupCustody, pidExists, type CancelEnd } from './lib.ts';

function reading(first: ProcessGroupState, ...rest: ProcessGroupState[]): ProcessGroupReading {
  const states = [ first, ...rest ];
  return { state: states.at(-1) ?? first, observations: states.map((state, index) => ({ elapsedMs: index * 50, state })) };
}

function errno(code: string): Error {
  return Object.assign(new Error(`kill ${code}`), { code });
}

describe('groupCustody', () => {
  test('an EPERM that cleared within the recheck is empty only because a later reading was', () => {
    expect(groupCustody(reading('not-permitted', 'not-permitted', 'empty'), null)).toEqual({ state: 'empty', stopsLaterRuns: false });
  });

  test('an EPERM through the whole recheck is not empty, and stops later scenarios', () => {
    expect(groupCustody(reading('not-permitted', 'not-permitted'), null)).toEqual({ state: 'not-permitted', stopsLaterRuns: true });
  });

  test('after its own SIGKILL, the probe decides by the reading that followed', () => {
    expect(groupCustody(reading('occupied'), reading('empty'))).toEqual({ state: 'empty', stopsLaterRuns: false });
    expect(groupCustody(reading('occupied'), reading('occupied'))).toEqual({ state: 'occupied', stopsLaterRuns: true });
    expect(groupCustody(reading('occupied'), reading('not-permitted', 'not-permitted'))).toEqual({ state: 'not-permitted', stopsLaterRuns: true });
  });
});

describe('pidExists', () => {
  test('ESRCH is gone, EPERM is unknown, and any other error is not read at all', () => {
    expect(pidExists(4_190_002, () => undefined)).toBe(true);
    expect(pidExists(4_190_002, () => {
      throw errno('ESRCH');
    })).toBe(false);
    expect(pidExists(4_190_002, () => {
      throw errno('EPERM');
    })).toBeNull();
    expect(() => pidExists(4_190_002, () => {
      throw errno('EINVAL');
    })).toThrow('EINVAL');
  });

  test('refuses pids with broadcast meanings before anything is sent', () => {
    const sent: number[] = [];
    for (const pid of [ 0, 1, -1, 1.5 ]) {
      expect(() => pidExists(pid, target => {
        sent.push(target);
      })).toThrow();
    }
    expect(sent).toEqual([]);
  });

  test.if(process.platform === 'darwin' || process.platform === 'linux')('reads a process it spawned as present, and as absent once it has been reaped', async () => {
    const child = Bun.spawn({ cmd: [ '/bin/sleep', '30' ], stdout: 'ignore', stderr: 'ignore' });
    try {
      expect(pidExists(child.pid)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
    await child.exited;
    expect(pidExists(child.pid)).toBe(false);
  });
});

describe('cancelLeftNothing', () => {
  const clean: CancelEnd = { custodyGroupState: 'empty', probeGroup: reading('empty'), toolSurvived: false, toolAliveUnverified: false };

  test('holds when both readings are empty and no tool pid is left or unknown', () => {
    expect(cancelLeftNothing(clean)).toBe(true);
  });

  test('an unverified tool pid of unknown existence is not taken as gone', () => {
    expect(cancelLeftNothing({ ...clean, toolAliveUnverified: null })).toBe(false);
    expect(cancelLeftNothing({ ...clean, toolAliveUnverified: true })).toBe(false);
  });

  test('a group not shown empty by either reading, or not read by the probe, is not clean', () => {
    expect(cancelLeftNothing({ ...clean, custodyGroupState: 'not-permitted' })).toBe(false);
    expect(cancelLeftNothing({ ...clean, probeGroup: reading('not-permitted', 'not-permitted') })).toBe(false);
    expect(cancelLeftNothing({ ...clean, probeGroup: null })).toBe(false);
    expect(cancelLeftNothing({ ...clean, toolSurvived: true })).toBe(false);
  });
});
