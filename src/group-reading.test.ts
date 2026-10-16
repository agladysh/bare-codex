import { describe, expect, test } from 'bun:test';
import { readProcessGroup } from './lifecycle.ts';

describe.if(process.platform === 'darwin' || process.platform === 'linux')('readProcessGroup, from the pinned lifecycle', () => {
  test('reads a group it spawned as occupied at once, and as empty once it has ended, never the other way round', async () => {
    const live = Bun.spawn({ cmd: [ '/bin/sleep', '30' ], stdout: 'ignore', stderr: 'ignore', detached: true });
    try {
      expect(await readProcessGroup(live.pid)).toEqual({ state: 'occupied', observations: [ { elapsedMs: 0, state: 'occupied' } ] });
    } finally {
      live.kill('SIGKILL');
    }
    await live.exited;
    const ended = await readProcessGroup(live.pid);
    expect(ended.state).toBe('empty');
    expect(ended.observations.at(-1)).toMatchObject({ state: 'empty' });
    expect(ended.observations.some(observation => observation.state === 'occupied')).toBe(false);
  });
});
