import { describe, expect, test } from 'bun:test';
import { planInvocation, planRecord, tomlString, type PlanOptions } from './plan.ts';

const THREAD = '0199a000-0000-7000-8000-000000000001';
const SECRET = 'plan-test-secret-4410';

const base: PlanOptions = {
  codexPath: '/opt/codex',
  cwd: '/work',
  lastMessageFile: '/out/last-message.txt',
  baseEnv: { PATH: '/usr/bin', CODEX_HOME: '/homes/a', BARE_SECRET: SECRET },
  prompt: 'do the thing',
};

const head = [ 'exec', '--json', '--color', 'never', '--output-last-message', '/out/last-message.txt', '--cd', '/work' ];

describe('planInvocation', () => {
  test('a default plan passes no permission, config or home option and reads the prompt from stdin', () => {
    const plan = planInvocation(base);
    expect(plan.refusals).toEqual([]);
    expect(plan.command).toBe('/opt/codex');
    expect(plan.args).toEqual([ ...head, '-' ]);
    expect(new TextDecoder().decode(plan.stdin)).toBe('do the thing');
    expect(plan.env['CODEX_HOME']).toBe('/homes/a');
    expect(plan.env['BARE_SECRET']).toBe(SECRET);
  });

  test('exec options precede resume, which takes a UUID and then stdin', () => {
    const plan = planInvocation({ ...base, model: 'm1', permissions: { kind: 'sandbox', mode: 'read-only' }, session: { kind: 'resume', threadId: THREAD } });
    expect(plan.args).toEqual([ ...head, '--model', 'm1', '--sandbox', 'read-only', 'resume', THREAD, '-' ]);
  });

  test('fork is planned like resume', () => {
    const plan = planInvocation({ ...base, session: { kind: 'fork', threadId: THREAD }, ephemeral: true });
    expect(plan.args).toEqual([ ...head, '--ephemeral', 'fork', THREAD, '-' ]);
  });

  test('each permission kind maps to its exact native option, and inherit to none', () => {
    expect(planInvocation({ ...base, permissions: { kind: 'approve-for-me' } }).args).toContain('--approve-for-me');
    expect(planInvocation({ ...base, permissions: { kind: 'bypass' } }).args).toContain('--dangerously-bypass-approvals-and-sandbox');
    const profile = planInvocation({ ...base, permissions: { kind: 'profile', name: 'team-routine' } });
    expect(profile.args).toEqual([ ...head, '-c', 'default_permissions="team-routine"', '-' ]);
    const inherit = planInvocation({ ...base, permissions: { kind: 'inherit' } });
    expect(inherit.args.some(arg => arg.includes('sandbox') || arg.includes('approve') || arg.includes('permissions'))).toBe(false);
    expect(inherit.notes.find(note => note.what === 'permissions')?.detail).toContain('loaded configuration decides');
  });

  test('isolated config adds exactly --ignore-user-config and --ignore-rules', () => {
    expect(planInvocation({ ...base, config: { kind: 'isolated' } }).args).toEqual([ ...head, '--ignore-user-config', '--ignore-rules', '-' ]);
  });

  test('images come first, so --json ends their value list', () => {
    const plan = planInvocation({ ...base, images: [ '/a.png', '/b.png' ] });
    expect(plan.args.slice(0, 6)).toEqual([ 'exec', '--image', '/a.png', '--image', '/b.png', '--json' ]);
  });

  test('effort becomes a -c override; a caller override of a planned key is refused', () => {
    const plan = planInvocation({ ...base, effort: 'high', overrides: [ { key: 'model_providers.p.name', value: '"p"' } ] });
    expect(plan.args).toEqual([ ...head, '-c', 'model_reasoning_effort="high"', '-c', 'model_providers.p.name="p"', '-' ]);
    const conflict = planInvocation({ ...base, permissions: { kind: 'profile', name: 'x' }, overrides: [ { key: 'default_permissions', value: '"y"' } ] });
    expect(conflict.refusals.map(refusal => refusal.code)).toEqual([ 'override-conflict' ]);
  });

  test('refuses empty and non-UTF-8 prompts, relative paths, bad thread ids and odd options', () => {
    const codes = (options: Partial<PlanOptions>) => planInvocation({ ...base, ...options }).refusals.map(refusal => refusal.code);
    expect(codes({ prompt: '  ' })).toEqual([ 'prompt-empty' ]);
    expect(codes({ prompt: new Uint8Array([ 0xff, 0xfe, 0x00 ]) })).toEqual([ 'prompt-not-utf8' ]);
    expect(codes({ cwd: 'relative' })).toEqual([ 'path-not-absolute' ]);
    expect(codes({ session: { kind: 'resume', threadId: 'my-thread' } })).toEqual([ 'thread-id-invalid' ]);
    expect(codes({ model: '-x' })).toEqual([ 'option-invalid' ]);
    expect(codes({ effort: 'very high' })).toEqual([ 'option-invalid' ]);
    expect(codes({ overrides: [ { key: 'a=b', value: '1' } ] })).toEqual([ 'override-invalid' ]);
  });

  test('a named home with an account-switching launcher is refused unless CODEX_SWITCH_OFF is set', () => {
    const named = { ...base, executableClass: 'switch-launcher' as const, home: { kind: 'path' as const, codexHome: '/homes/b' } };
    expect(planInvocation(named).refusals.map(refusal => refusal.code)).toEqual([ 'launcher-replaces-home' ]);
    expect(planInvocation({ ...named, baseEnv: { ...base.baseEnv, CODEX_SWITCH_OFF: '1' } }).refusals).toEqual([]);
    expect(planInvocation({ ...base, executableClass: 'switch-launcher' }).refusals).toEqual([]);
  });

  test('an image path with a comma is refused, because native splits it', () => {
    expect(planInvocation({ ...base, images: [ '/a,b.png' ] }).refusals.map(refusal => refusal.code)).toEqual([ 'option-invalid' ]);
  });

  test('the prompt never appears in argv', () => {
    const plan = planInvocation({ ...base, prompt: 'PROMPT-MARKER-7' });
    expect(plan.args.join(' ')).not.toContain('PROMPT-MARKER-7');
    expect(plan.args.at(-1)).toBe('-');
  });
});

describe('planRecord', () => {
  test('holds no environment values and no prompt, and hashes every override value not declared public', () => {
    const plan = planInvocation({ ...base, prompt: 'PROMPT-MARKER-8', effort: 'high', overrides: [
      { key: 'model_providers.x.experimental_bearer_token', value: '"s3cret-bearer"' },
      { key: 'model_providers.x.http_headers.Authorization', value: '"Bearer s3cret-header"' },
      { key: 'model_providers.y', value: '{ name = "y", experimental_bearer_token = "s3cret-inline" }' },
      { key: 'model_providers.z.base_url', value: '"http://127.0.0.1:9/v1"', public: true },
    ] });
    const record = planRecord(plan);
    const text = JSON.stringify(record);
    for (const secret of [ SECRET, 'PROMPT-MARKER-8', 's3cret-bearer', 's3cret-header', 's3cret-inline' ]) {
      expect(text).not.toContain(secret);
    }
    expect(record.args.filter(arg => arg.includes('=<sha256:')).length).toBe(3);
    expect(record.args).toContain('model_providers.z.base_url="http://127.0.0.1:9/v1"');
    expect(record.args).toContain('model_reasoning_effort="high"');
    expect(plan.args).toContain('model_providers.x.http_headers.Authorization="Bearer s3cret-header"');
    expect(record.promptBytes).toBe(15);
    expect(record.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

test('tomlString escapes quotes, backslashes and control characters, and refuses lone surrogates', () => {
  const samples = [ 'plain', 'quote " inside', `back${String.fromCharCode(92)}slash`, `tab${String.fromCharCode(9)}and${String.fromCharCode(1)}` ];
  for (const sample of samples) {
    const encoded = tomlString(sample);
    expect(encoded).not.toBeNull();
    expect(JSON.parse(encoded ?? '')).toBe(sample);
  }
  expect(tomlString(String.fromCharCode(0xd800))).toBeNull();
});
