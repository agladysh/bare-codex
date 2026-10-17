/**
 * The probe's pure parts, kept apart so that `bun test` can check them
 * without native Codex, a sandbox or a listener: the outer sandbox profile,
 * the isolation judgement, the loopback stand-in for the Responses API, and
 * what the probe concludes from process-group and pid readings.
 */

import { createHash } from 'node:crypto';
import type { ProcessGroupReading, ProcessGroupState } from '../src/lifecycle.ts';
import { isJsonObject, type JsonObject, type JsonValue } from '../src/types.ts';

// ------------------------------------------------------------ outer sandbox

/**
 * The outer macOS sandbox profile for every native run and for the sandboxed
 * preflight:
 * - outbound network only to the provider's loopback port;
 * - file writes only under the probe root and a few devices;
 * - reads denied for the real native homes and the synthetic decoy home.
 * Everything else is allowed, so native can start at all. It contains a
 * probe run; it is not a security boundary for anything else. Mach and XPC
 * services are not covered: a native call that delegates to a system
 * service is outside what socket rules can show.
 */
export function sandboxProfile(root: string, port: number, deniedReads: readonly string[]): string {
  return [
    '(version 1)',
    '(allow default)',
    '(deny network-outbound)',
    `(allow network-outbound (remote ip "localhost:${port}"))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(root)})`,
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    ...deniedReads.map(path => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
    '',
  ].join(String.fromCharCode(10));
}

// ------------------------------------------------------------ process readings

/** What the probe concludes about one owned process group from its readings. */
export interface GroupCustody {
  /** The last state read: after the probe's own SIGKILL when it sent one, else after the run. */
  state: ProcessGroupState,

  /**
   * Whether later scenarios are skipped: always, unless the group was shown
   * `empty`. `occupied` survived the probe's SIGKILL, and `not-permitted`
   * (EPERM through the whole recheck) shows neither that nothing is left that
   * could still reach the stand-in nor whose it would be.
   */
  stopsLaterRuns: boolean,
}

/**
 * The probe's conclusion about one owned group. `afterKill` is the reading
 * after the probe's own SIGKILL, sent only when `afterRun` read `occupied`.
 * No reading is turned into another state.
 */
export function groupCustody(afterRun: ProcessGroupReading, afterKill: ProcessGroupReading | null): GroupCustody {
  const state = (afterKill ?? afterRun).state;
  return { state, stopsLaterRuns: state !== 'empty' };
}

/** Sends signal 0, which delivers nothing, to one pid. */
export type SignalZero = (pid: number) => void;

const signalZero: SignalZero = pid => {
  process.kill(pid, 0);
};

/**
 * Whether one pid exists, by signal 0: true when the call succeeds, false on
 * ESRCH, null on EPERM, which shows neither that the process is running nor
 * whose it is. Any other error is thrown. Pids with broadcast meanings to
 * `kill(2)` are refused before anything is sent.
 */
export function pidExists(pid: number, send: SignalZero = signalZero): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`refusing to check pid ${pid}: not a single process this probe could have read`);
  }
  try {
    send(pid);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return null;
    }
    throw error;
  }
}

/** What the `cancel` rule reads once the run has ended. */
export interface CancelEnd {
  /** bare-codex's own custody state for native's group. */
  custodyGroupState: string | null,

  /** The probe's own reading of the same group; null when the probe read none. */
  probeGroup: ProcessGroupReading | null,

  /** The verified tool process was still running. */
  toolSurvived: boolean,

  /** Whether an unverified tool pid still exists: false also when there was none, null when EPERM left it unknown. */
  toolAliveUnverified: boolean | null,
}

/**
 * Whether a cancellation run is shown to have left nothing behind: both
 * readings of native's group are `empty`, the verified tool did not survive,
 * and no unverified tool pid exists or is of unknown existence.
 */
export function cancelLeftNothing(end: CancelEnd): boolean {
  return end.custodyGroupState === 'empty' && end.probeGroup?.state === 'empty' && !end.toolSurvived && end.toolAliveUnverified === false;
}

// ------------------------------------------------------------ isolation judgement

const denied = new Set([ 'EPERM', 'EACCES' ]);

/** Why isolation is not shown (empty when it is), and how the network denial was established. */
export interface IsolationVerdict {
  failures: string[],
  networkDenial: string | null,
  /** `errno`: a permission error code; `contrast`: ECONNREFUSED made meaningful only by the paired controls. */
  networkDenialBasis: 'errno' | 'contrast' | null,
}

function connectResult(report: JsonObject, key: string): string | null {
  const value = report[key];
  const result = isJsonObject(value) ? value['result'] : undefined;
  return typeof result === 'string' ? result : null;
}

function text(report: JsonObject, key: string): string {
  const value = report[key];
  return typeof value === 'string' ? value : String(value);
}

/**
 * Judges the three preflight reports (`probe/preflight-check.ts`).
 *
 * The unsandboxed controls, before and after, must reach the provider over
 * HTTP and a raw connect, reach the live decoy listener, write in the
 * write-check directory and read the decoy file. Otherwise the harness is
 * broken and no sandboxed failure can be attributed to the sandbox.
 *
 * Sandboxed, the provider must answer over HTTP and the raw connect, and the
 * write and the decoy read must fail with EPERM or EACCES. The decoy listener
 * must fail to connect with EPERM or EACCES, or with ECONNREFUSED; the latter
 * only through the contrast: the same listener accepted the same connect just
 * before and just after, unsandboxed, and the allowed port connected from
 * inside. ECONNREFUSED alone is never taken as a denial. TEST-NET-1 (never
 * routed, tried only sandboxed) must fail with EPERM or EACCES, or with the
 * very code the decoy listener got.
 */
export function judgeIsolation(before: unknown, sandboxed: unknown, after: unknown): IsolationVerdict {
  const failures: string[] = [];
  for (const [ label, control ] of [ [ 'control before', before ], [ 'control after', after ] ] as const) {
    if (!isJsonObject(control)) {
      failures.push(`${label}: no report`);
      continue;
    }
    if (control['provider'] !== true) {
      failures.push(`${label}: the provider did not answer over HTTP`);
    }
    if (connectResult(control, 'providerTcp') !== 'connected') {
      failures.push(`${label}: the provider port did not connect`);
    }
    if (connectResult(control, 'decoyTcp') !== 'connected') {
      failures.push(`${label}: the decoy listener did not connect`);
    }
    if (control['write'] !== 'allowed') {
      failures.push(`${label}: could not write in the write-check directory (${text(control, 'write')})`);
    }
    if (control['decoyRead'] !== 'allowed') {
      failures.push(`${label}: could not read the decoy file (${text(control, 'decoyRead')})`);
    }
  }
  if (!isJsonObject(sandboxed)) {
    return { failures: [ ...failures, 'sandboxed: no report' ], networkDenial: null, networkDenialBasis: null };
  }
  if (sandboxed['provider'] !== true) {
    failures.push('sandboxed: the provider did not answer over HTTP');
  }
  if (connectResult(sandboxed, 'providerTcp') !== 'connected') {
    failures.push('sandboxed: the provider port did not connect');
  }
  if (!denied.has(text(sandboxed, 'write'))) {
    failures.push(`sandboxed: the write outside the root gave ${text(sandboxed, 'write')}`);
  }
  if (!denied.has(text(sandboxed, 'decoyRead'))) {
    failures.push(`sandboxed: the decoy read gave ${text(sandboxed, 'decoyRead')}`);
  }
  const controlsHeld = failures.length === 0;
  const decoy = connectResult(sandboxed, 'decoyTcp');
  let networkDenial: string | null = null;
  let networkDenialBasis: 'errno' | 'contrast' | null = null;
  if (decoy !== null && denied.has(decoy)) {
    networkDenial = decoy;
    networkDenialBasis = 'errno';
  } else if (decoy === 'ECONNREFUSED' && controlsHeld) {
    networkDenial = decoy;
    networkDenialBasis = 'contrast';
  } else {
    failures.push(`sandboxed: the decoy listener gave ${String(decoy)}, which is not shown to be a sandbox denial`);
  }
  const egress = connectResult(sandboxed, 'egress');
  if (egress === null || !(denied.has(egress) || (networkDenial !== null && egress === networkDenial))) {
    failures.push(`sandboxed: TEST-NET-1 gave ${String(egress)}, not the denial the decoy showed`);
  }
  return { failures, networkDenial, networkDenialBasis };
}

// ------------------------------------------------------------ Responses stand-in

/** What the stand-in answers to one `POST .../responses`. */
export type Reply =
  /** A complete response carrying one assistant message. */
  | { kind: 'text', text: string }
  /** A complete response carrying one call to the shell tool the request offers, running `script`. */
  | { kind: 'shell', script: string }
  /** `response.created`, then the stream ends without `response.completed`. */
  | { kind: 'truncated' }
  /** An HTTP error status with a JSON body. */
  | { kind: 'status', status: number };

export interface ScenarioScript {
  reply(index: number, body: JsonValue | null): Reply;
}

/** Always the same text. */
export function textScript(text: string): ScenarioScript {
  return { reply: () => ({ kind: 'text', text }) };
}

/** `replies` in order, then `then` for every further request; it counts its own calls. */
export function sequenceScript(replies: readonly Reply[], then: Reply): ScenarioScript {
  const state = { calls: 0 };
  return {
    reply: () => {
      const reply = replies[state.calls] ?? then;
      state.calls += 1;
      return reply;
    },
  };
}

export interface LoggedRequest {
  route: string,
  method: string,
  path: string,
  /** Per-route index of `POST .../responses`; -1 for anything else. */
  index: number,
  body: JsonValue | null,
  bodyText: string,
  reply: string,
  /** A fingerprint of the Authorization header, never its value. */
  authorizationSha256: string | null,
  shellTool: string | null,
}

export interface RefreshRequest {
  refreshTokenSha256: string | null,
  status: number,
  at: number,
}

export interface Stub {
  scripts: Map<string, ScenarioScript>,
  requests: LoggedRequest[],
  refreshRequests: RefreshRequest[],
  handle(request: Request): Promise<Response>,
}

/** The synthetic ChatGPT claims of the refresh experiment. Not an account. */
export const syntheticClaims = {
  email: 'probe@example.invalid',
  'https://api.openai.com/auth': { chatgpt_account_id: 'probe-account', chatgpt_plan_type: 'pro', chatgpt_user_id: 'probe-user' },
};

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** A JWT-shaped synthetic token with `payload`; its signature is not a signature. */
export function syntheticJwt(payload: Record<string, unknown>): string {
  return [ base64url(JSON.stringify({ alg: 'none', typ: 'JWT' })), base64url(JSON.stringify(payload)), base64url('synthetic-probe-signature') ].join('.');
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function parseJson(text: string): JsonValue | null {
  if (text === '') {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return isJsonValue(value) ? value : null;
  } catch {
    return null;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string' || Array.isArray(value) || isJsonObject(value);
}

/** Server-sent events in the framing the 0.163.0 parser reads (codex-api/src/sse/responses.rs:722-734). */
export function sse(events: readonly JsonObject[]): string {
  const lf = String.fromCharCode(10);
  return events.map(event => `event: ${String(event['type'])}${lf}data: ${JSON.stringify(event)}${lf}${lf}`).join('');
}

const usage = { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 12 };

/** One assistant message, then `response.completed` with usage (responses.rs:354-361, 419-480). */
export function textEvents(id: string, text: string): JsonObject[] {
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [ { type: 'output_text', text } ] } },
    { type: 'response.completed', response: { id, usage } },
  ];
}

export interface ShellCall {
  name: string,
  arguments: string,
  form: 'command-array' | 'command-string' | 'cmd-string',
}

/** One function call, then `response.completed`. */
export function shellEvents(id: string, call: ShellCall): JsonObject[] {
  return [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item: { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name: call.name, arguments: call.arguments } },
    { type: 'response.completed', response: { id, usage } },
  ];
}

interface ToolShape {
  name: string,
  properties: Record<string, string>,
}

/** The function tools a request offers, flat (`{type, name, parameters}`) or nested (`{function: {...}}`). */
export function toolsOf(body: JsonValue | null): ToolShape[] {
  const tools = isJsonObject(body) ? body['tools'] : undefined;
  if (!Array.isArray(tools)) {
    return [];
  }
  const out: ToolShape[] = [];
  for (const tool of tools) {
    if (!isJsonObject(tool)) {
      continue;
    }
    const nested = tool['function'];
    const holder = isJsonObject(nested) ? nested : tool;
    const name = holder['name'];
    if (typeof name !== 'string') {
      continue;
    }
    const parameters = holder['parameters'];
    const props = isJsonObject(parameters) ? parameters['properties'] : undefined;
    const properties: Record<string, string> = {};
    if (isJsonObject(props)) {
      for (const [ key, schema ] of Object.entries(props)) {
        const type = isJsonObject(schema) ? schema['type'] : undefined;
        if (typeof type === 'string') {
          properties[key] = type;
        } else if (Array.isArray(type)) {
          const first = type.find(entry => typeof entry === 'string');
          if (typeof first === 'string') {
            properties[key] = first;
          }
        }
      }
    }
    out.push({ name, properties });
  }
  return out;
}

/**
 * A call to whichever shell tool the request offers, shaped by that tool's
 * own parameter schema, so the stand-in does not presume a fixed tool set.
 */
export function chooseShellCall(body: JsonValue | null, script: string): ShellCall | null {
  const tools = toolsOf(body);
  for (const preferred of [ 'shell_command', 'exec_command', 'shell' ]) {
    const tool = tools.find(candidate => candidate.name === preferred);
    if (tool === undefined) {
      continue;
    }
    if (tool.properties['command'] === 'array') {
      return { name: tool.name, arguments: JSON.stringify({ command: [ '/bin/sh', '-c', script ] }), form: 'command-array' };
    }
    if (tool.properties['command'] === 'string') {
      return { name: tool.name, arguments: JSON.stringify({ command: script }), form: 'command-string' };
    }
    if (tool.properties['cmd'] === 'string') {
      return { name: tool.name, arguments: JSON.stringify({ cmd: script }), form: 'cmd-string' };
    }
  }
  return null;
}

const routePattern = /^[/]s[/]([A-Za-z0-9_-]+)[/]v1[/](.*)$/;
const sseHeaders = { 'content-type': 'text/event-stream' };

/**
 * The loopback stand-in. Each synthetic home's provider lives under its own
 * route, `/s/<route>/v1`, so a request is attributed by where native sent it.
 * It also answers `/health` for the preflight and `/oauth/token` for the
 * refresh experiment: the first use of a refresh token succeeds and issues the
 * next one, any reuse is answered 400 with code `refresh_token_reused`.
 */
export function createStub(): Stub {
  const scripts = new Map<string, ScenarioScript>();
  const requests: LoggedRequest[] = [];
  const refreshRequests: RefreshRequest[] = [];
  const counters = new Map<string, number>();
  const refreshUses = new Map<string, number>();
  const serial = { response: 0, refresh: 1 };

  const answer = (reply: Reply, body: JsonValue | null): { response: Response, label: string, shellTool: string | null } => {
    serial.response += 1;
    const id = `resp_probe_${serial.response}`;
    switch (reply.kind) {
      case 'text':
        return { response: new Response(sse(textEvents(id, reply.text)), { headers: sseHeaders }), label: 'text', shellTool: null };
      case 'shell': {
        const call = chooseShellCall(body, reply.script);
        if (call === null) {
          return { response: new Response(sse(textEvents(id, 'PROBE-NO-SHELL-TOOL')), { headers: sseHeaders }), label: 'no-shell-tool', shellTool: null };
        }
        return { response: new Response(sse(shellEvents(id, call)), { headers: sseHeaders }), label: `shell:${call.form}`, shellTool: call.name };
      }
      case 'truncated':
        return { response: new Response(sse([ { type: 'response.created', response: { id } } ]), { headers: sseHeaders }), label: 'truncated', shellTool: null };
      case 'status':
        return { response: Response.json({ error: { message: `probe stand-in status ${reply.status}`, type: 'server_error' } }, { status: reply.status }), label: `status:${reply.status}`, shellTool: null };
    }
  };

  const refresh = (body: JsonValue | null): Response => {
    const candidate = isJsonObject(body) ? body['refresh_token'] : undefined;
    const token = typeof candidate === 'string' ? candidate : null;
    const uses = token === null ? 0 : refreshUses.get(token) ?? 0;
    if (token !== null) {
      refreshUses.set(token, uses + 1);
    }
    if (token === null || uses > 0) {
      refreshRequests.push({ refreshTokenSha256: token === null ? null : fingerprint(token), status: 400, at: Date.now() });
      return Response.json({ error: { code: token === null ? 'invalid_request' : 'refresh_token_reused', message: 'probe stand-in: this synthetic refresh token was already used' } }, { status: 400 });
    }
    refreshRequests.push({ refreshTokenSha256: fingerprint(token), status: 200, at: Date.now() });
    serial.refresh += 1;
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      id_token: syntheticJwt({ ...syntheticClaims, iat: now, exp: now + 3600 }),
      access_token: syntheticJwt({ ...syntheticClaims, iat: now, exp: now + 3600 }),
      refresh_token: `SYNTH-RT-${serial.refresh}`,
    });
  };

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const bodyText = request.method === 'POST' ? await request.text() : '';
    const body = parseJson(bodyText);
    const authorization = request.headers.get('authorization');
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    if (url.pathname === '/oauth/token' && request.method === 'POST') {
      return refresh(body);
    }
    const match = routePattern.exec(url.pathname);
    const route = match?.[1] ?? '(unattributed)';
    const rest = match?.[2] ?? url.pathname;
    const authorizationSha256 = authorization === null ? null : fingerprint(authorization);
    if (request.method === 'POST' && rest === 'responses') {
      const index = counters.get(route) ?? 0;
      counters.set(route, index + 1);
      const script = scripts.get(route);
      const reply: Reply = script === undefined ? { kind: 'text', text: 'PROBE-UNSCRIPTED' } : script.reply(index, body);
      const answered = answer(reply, body);
      requests.push({ route, method: request.method, path: url.pathname, index, body, bodyText, reply: answered.label, authorizationSha256, shellTool: answered.shellTool });
      return answered.response;
    }
    requests.push({ route, method: request.method, path: url.pathname, index: -1, body, bodyText, reply: 'not-found', authorizationSha256, shellTool: null });
    return Response.json({ error: { message: 'not served by the probe stand-in' } }, { status: 404 });
  };

  return { scripts, requests, refreshRequests, handle };
}

// ------------------------------------------------------------ reading requests

/** Which of `markers` occur in `text`. */
export function findMarkers(text: string, markers: readonly string[]): string[] {
  return markers.filter(marker => text.includes(marker));
}

const permissionTagNames = [ 'approval_policy', 'sandbox_mode', 'network_access', 'permission_profile', 'writable_roots' ];

/** Values of permission-describing tags (`<sandbox_mode>…</sandbox_mode>` and the like) in a request body. */
export function permissionTags(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const tag of permissionTagNames) {
    const values = [ ...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g')) ].map(match => match[1] ?? '');
    if (values.length > 0) {
      out[tag] = [ ...new Set(values) ];
    }
  }
  return out;
}

export interface RequestView {
  route: string,
  method: string,
  path: string,
  index: number,
  reply: string,
  bodyBytes: number,
  model: string | null,
  toolNames: string[],
  textFormat: JsonValue | null,
  inputItems: number | null,
  markers: string[],
  permissionTags: Record<string, string[]>,
  shellTool: string | null,
  authorizationSha256: string | null,
}

/** A request as the report shows it: shape and markers, not the whole body. */
export function requestSummary(request: LoggedRequest, markers: readonly string[]): RequestView {
  const body = request.body;
  const model = isJsonObject(body) ? body['model'] : undefined;
  const textField = isJsonObject(body) ? body['text'] : undefined;
  const format = isJsonObject(textField) ? textField['format'] : undefined;
  const input = isJsonObject(body) ? body['input'] : undefined;
  return {
    route: request.route,
    method: request.method,
    path: request.path,
    index: request.index,
    reply: request.reply,
    bodyBytes: request.bodyText.length,
    model: typeof model === 'string' ? model : null,
    toolNames: toolsOf(body).map(tool => tool.name),
    textFormat: format ?? null,
    inputItems: Array.isArray(input) ? input.length : null,
    markers: findMarkers(request.bodyText, markers),
    permissionTags: permissionTags(request.bodyText),
    shellTool: request.shellTool,
    authorizationSha256: request.authorizationSha256,
  };
}
