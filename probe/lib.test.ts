import { describe, expect, test } from 'bun:test';
import { chooseShellCall, createStub, judgeIsolation, permissionTags, requestSummary, sandboxProfile, sequenceScript, sse, syntheticJwt, textScript } from './lib.ts';

const LF = String.fromCharCode(10);

const control = { provider: true, providerTcp: { result: 'connected' }, decoyTcp: { result: 'connected' }, write: 'allowed', decoyRead: 'allowed' };
const sandboxed = { provider: true, providerTcp: { result: 'connected' }, decoyTcp: { result: 'EPERM' }, egress: { result: 'EPERM' }, write: 'EPERM', decoyRead: 'EPERM' };

describe('judgeIsolation', () => {
  test('permission errors with held controls show isolation by errno', () => {
    expect(judgeIsolation(control, sandboxed, control)).toEqual({ failures: [], networkDenial: 'EPERM', networkDenialBasis: 'errno' });
  });

  test('ECONNREFUSED counts only through the paired controls', () => {
    const refused = { ...sandboxed, decoyTcp: { result: 'ECONNREFUSED' }, egress: { result: 'ECONNREFUSED' } };
    expect(judgeIsolation(control, refused, control)).toEqual({ failures: [], networkDenial: 'ECONNREFUSED', networkDenialBasis: 'contrast' });
    const brokenAfter = { ...control, decoyTcp: { result: 'ECONNREFUSED' } };
    expect(judgeIsolation(control, refused, brokenAfter).failures.length).toBeGreaterThan(0);
  });

  test('an allowed write, an allowed decoy read or an undenied egress is a failure', () => {
    expect(judgeIsolation(control, { ...sandboxed, write: 'allowed' }, control).failures.join(' ')).toContain('write');
    expect(judgeIsolation(control, { ...sandboxed, decoyRead: 'allowed' }, control).failures.join(' ')).toContain('decoy read');
    expect(judgeIsolation(control, { ...sandboxed, egress: { result: 'timeout' } }, control).failures.join(' ')).toContain('TEST-NET-1');
    expect(judgeIsolation(null, sandboxed, control).failures).toContain('control before: no report');
  });
});

test('the sandbox profile allows only the provider port and the root for writes, and denies the named reads', () => {
  const profile = sandboxProfile('/tmp/root', 4321, [ '/Users/x/.codex', '/tmp/decoy' ]);
  expect(profile).toContain('(deny network-outbound)');
  expect(profile).toContain('(allow network-outbound (remote ip "localhost:4321"))');
  expect(profile).toContain('(allow file-write* (subpath "/tmp/root")');
  expect(profile).toContain('(deny file-read* (subpath "/Users/x/.codex"))');
  expect(profile).toContain('(deny file-read* (subpath "/tmp/decoy"))');
});

describe('chooseShellCall', () => {
  test('shapes the call by the offered tool schema, flat or nested', () => {
    const flatArray = { tools: [ { type: 'function', name: 'shell', parameters: { properties: { command: { type: 'array' } } } } ] };
    expect(chooseShellCall(flatArray, 'sleep 1')).toEqual({ name: 'shell', arguments: JSON.stringify({ command: [ '/bin/sh', '-c', 'sleep 1' ] }), form: 'command-array' });
    const nestedString = { tools: [ { type: 'function', function: { name: 'shell_command', parameters: { properties: { command: { type: 'string' } } } } } ] };
    expect(chooseShellCall(nestedString, 'sleep 1')?.form).toBe('command-string');
    const cmd = { tools: [ { type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: [ 'string', 'null' ] } } } } ] };
    expect(chooseShellCall(cmd, 'sleep 1')?.form).toBe('cmd-string');
    expect(chooseShellCall({ tools: [ { type: 'function', name: 'apply_patch' } ] }, 'x')).toBeNull();
    expect(chooseShellCall(null, 'x')).toBeNull();
  });
});

test('SSE framing is event and data lines separated by a blank line', () => {
  const text = sse([ { type: 'response.created', response: { id: 'r' } } ]);
  expect(text).toBe(`event: response.created${LF}data: {"type":"response.created","response":{"id":"r"}}${LF}${LF}`);
});

describe('createStub', () => {
  test('routes responses by path, logs them, and follows each script', async () => {
    const stub = createStub();
    stub.scripts.set('p1', textScript('HELLO'));
    stub.scripts.set('p7', sequenceScript([ { kind: 'truncated' } ], { kind: 'text', text: 'AFTER' }));
    const post = (route: string, body: object) => stub.handle(new Request(`http://127.0.0.1/s/${route}/v1/responses`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer synthetic' } }));
    const first = await (await post('p1', { model: 'probe-model', input: [ 1, 2 ], text: { format: { type: 'json_schema' } } })).text();
    expect(first).toContain('HELLO');
    expect(first).toContain('response.completed');
    const truncated = await (await post('p7', {})).text();
    expect(truncated).toContain('response.created');
    expect(truncated).not.toContain('response.completed');
    expect(await (await post('p7', {})).text()).toContain('AFTER');
    expect(stub.requests.map(request => [ request.route, request.index, request.reply ])).toEqual([ [ 'p1', 0, 'text' ], [ 'p7', 0, 'truncated' ], [ 'p7', 1, 'text' ] ]);
    const view = requestSummary(stub.requests[0] ?? stub.requests[1]!, [ 'probe-model', 'absent' ]);
    expect(view).toMatchObject({ model: 'probe-model', inputItems: 2, textFormat: { type: 'json_schema' }, markers: [ 'probe-model' ] });
    expect(view.authorizationSha256).not.toContain('synthetic');
  });

  test('answers health, and a refresh token is good once and reused after', async () => {
    const stub = createStub();
    expect(await (await stub.handle(new Request('http://127.0.0.1/health'))).text()).toBe('ok');
    const refresh = () => stub.handle(new Request('http://127.0.0.1/oauth/token', { method: 'POST', body: JSON.stringify({ refresh_token: 'SYNTH-RT-1' }) }));
    const first = await refresh();
    expect(first.status).toBe(200);
    const second = await refresh();
    expect(second.status).toBe(400);
    expect(await second.text()).toContain('refresh_token_reused');
    expect(stub.refreshRequests.map(request => request.status)).toEqual([ 200, 400 ]);
  });
});

test('permission tags are read from request text', () => {
  expect(permissionTags('<sandbox_mode>read-only</sandbox_mode> <approval_policy>never</approval_policy>')).toEqual({ sandbox_mode: [ 'read-only' ], approval_policy: [ 'never' ] });
});

test('synthetic JWTs carry their payload and no signature', () => {
  const token = syntheticJwt({ exp: 1 });
  const parts = token.split('.');
  expect(parts.length).toBe(3);
  expect(JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))).toEqual({ exp: 1 });
});
