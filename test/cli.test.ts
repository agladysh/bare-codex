import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, fakeEnv, filesContaining, makeFakeCodex, makeFakeLauncher, readGrandchild, readFakeLog, SECRET_SENTINEL, tempDir, waitFor } from './helpers.ts';

const SLOW = 30_000;

interface CliRun {
  code: number,
  stdout: string,
  stderr: string,
}

function setup(): { dir: string, codex: string, work: string } {
  const dir = tempDir('bare-codex-cli-');
  const work = join(dir, 'work');
  mkdirSync(work);
  return { dir, codex: makeFakeCodex(dir), work };
}

async function cli(args: string[], env: Record<string, string>): Promise<CliRun> {
  const child = Bun.spawn([ process.execPath, CLI, ...args ], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [ stdout, stderr ] = await Promise.all([ new Response(child.stdout).text(), new Response(child.stderr).text() ]);
  return { code: await child.exited, stdout, stderr };
}

function runArgs(s: { codex: string, work: string }, out: string, ...more: string[]): string[] {
  return [ 'run', '--codex', s.codex, '--cwd', s.work, '--out', out, '--allow-outside-repo', ...more, '--', 'hello', 'codex' ];
}

describe('bare-codex CLI', () => {
  test('run prints the final message on stdout and exits 0', async () => {
    const s = setup();
    const out = join(s.dir, 'out');
    const run = await cli(runArgs(s, out), fakeEnv(s.dir, 'ok'));
    expect(run.code).toBe(0);
    expect(run.stdout).toBe('fake final');
    expect(run.stderr).toContain('process group');
    expect(run.stderr).toContain('outcome completed');
    expect(filesContaining(out, SECRET_SENTINEL)).toEqual([]);
  }, SLOW);

  test('public metadata declarations preserve interleaved override precedence', async () => {
    const s = setup();
    const run = await cli(runArgs(s, join(s.dir, 'ordered'), '-c', 'choice=1', '--public-override', 'choice=2', '-c', 'choice=3'), fakeEnv(s.dir, 'ok'));
    expect(run.code).toBe(0);
    const argv = readFakeLog(s.dir)!.argv;
    expect(argv.filter(value => value.startsWith('choice='))).toEqual(['choice=1', 'choice=2', 'choice=3']);
  }, SLOW);

  test('usage errors exit 64', async () => {
    const s = setup();
    expect((await cli([ 'run', '--no-such-flag' ], fakeEnv(s.dir, 'ok'))).code).toBe(64);
    expect((await cli([ 'run', '--codex', s.codex, '--', 'x' ], fakeEnv(s.dir, 'ok'))).code).toBe(64);
    expect((await cli([ 'frobnicate' ], fakeEnv(s.dir, 'ok'))).code).toBe(64);
  }, SLOW);

  test('an existing output directory exits 73', async () => {
    const s = setup();
    const out = join(s.dir, 'out');
    mkdirSync(out);
    expect((await cli(runArgs(s, out), fakeEnv(s.dir, 'ok'))).code).toBe(73);
  }, SLOW);

  test('an ambient credential exits 78; a failed turn 1; a launcher refusal 3', async () => {
    const s = setup();
    expect((await cli(runArgs(s, join(s.dir, 'a')), { ...fakeEnv(s.dir, 'ok'), CODEX_API_KEY: SECRET_SENTINEL })).code).toBe(78);
    expect((await cli(runArgs(s, join(s.dir, 'b')), fakeEnv(s.dir, 'turn-failed'))).code).toBe(1);
    expect((await cli(runArgs({ codex: makeFakeLauncher(s.dir), work: s.work }, join(s.dir, 'c')), fakeEnv(s.dir, 'launcher-refuse-1'))).code).toBe(3);
  }, SLOW);

  test('plan prints the invocation without environment values', async () => {
    const s = setup();
    const run = await cli([ 'plan', '--codex', s.codex, '--cwd', s.work, '--permissions', 'approve-for-me', '--', 'x' ], fakeEnv(s.dir, 'ok'));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('--approve-for-me');
    expect(run.stdout).toContain('bare-codex.plan/v1');
    expect(run.stdout).not.toContain(SECRET_SENTINEL);
  }, SLOW);

  test('doctor passes with a fake that lists every option, and fails when one is missing', async () => {
    const s = setup();
    const good = await cli([ 'doctor', '--codex', s.codex, '--cwd', s.work, '--allow-outside-repo' ], fakeEnv(s.dir, 'ok'));
    expect(good.code).toBe(0);
    expect(good.stdout).toContain('ok   version');
    const bad = await cli([ 'doctor', '--codex', s.codex, '--cwd', s.work, '--permissions', 'approve-for-me' ], fakeEnv(s.dir, 'help-missing'));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('--approve-for-me');
  }, SLOW);

  test('SIGINT to the CLI interrupts native with SIGINT and exits 130', async () => {
    const s = setup();
    const child = Bun.spawn([ process.execPath, CLI, ...runArgs(s, join(s.dir, 'out')) ], { env: fakeEnv(s.dir, 'hang'), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    expect(await waitFor(() => readGrandchild(s.dir) !== null, 10_000)).toBe(true);
    child.kill('SIGINT');
    const [ stdout, stderr ] = await Promise.all([ new Response(child.stdout).text(), new Response(child.stderr).text() ]);
    expect(await child.exited).toBe(130);
    expect(stdout).toBe('');
    expect(stderr).toContain('sent SIGINT to codex');
    expect(stderr).toContain('outcome stopped');
  }, SLOW);
});
