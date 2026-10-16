#!/usr/bin/env bun
/**
 * Native loopback probe for bare-codex: what does an installed, stock `codex`
 * (measured version 0.162.1) actually do with the invocations bare-codex
 * plans? Answered with synthetic homes only, no credentials and no model
 * provider: a loopback stand-in answers the Responses API, and every native
 * run happens inside an outer macOS sandbox that paired controls show to
 * hold before native starts. Not part of `bun test`; run it deliberately from
 * an unsandboxed shell (sandbox-exec cannot start inside another sandbox):
 *
 *   bun probe/native-loopback.ts --codex /path/to/native/codex
 *   bun probe/native-loopback.ts --codex /path/to/native/codex --experiment refresh-race
 *
 * The executable must be named; PATH is not searched, and a launcher or
 * wrapper is refused, because the probe measures native, not a route to it.
 * docs/PROBE.md describes every control, scenario and finding.
 *
 * Exit codes: 0 when the basic protocol finding held, 1 when it did not or the
 * probe failed, 2 when it refused before starting native, 128+n when
 * interrupted. Its directories are left for inspection and named on every
 * exit. The report names the real native homes it denied by path; keep it
 * private.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ParsedEvent } from '../src/events.ts';
import { inspectExecutable, probeVersion, type ExecutableFacts, type VersionFacts } from '../src/executable.ts';
import type { CodexOutcome } from '../src/outcome.ts';
import { MEASURED_NATIVE_VERSION, NATIVE_SOURCE_REVISION, type ConfigOverride } from '../src/plan.ts';
import { runCodex, type SpawnInfo } from '../src/run.ts';
import { isJsonObject, type ConfigPolicy, type JsonValue, type PermissionsPolicy, type SessionPolicy } from '../src/types.ts';
import {
  createStub,
  fingerprint,
  judgeIsolation,
  requestSummary,
  sandboxProfile,
  sequenceScript,
  syntheticClaims,
  syntheticJwt,
  textScript,
  type IsolationVerdict,
  type RequestView,
  type ScenarioScript,
  type Stub,
} from './lib.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PREFLIGHT = resolve(import.meta.dir, 'preflight-check.ts');
const RUN_DEADLINE_MS = 120_000;
const PREFLIGHT_DEADLINE_MS = 30_000;
const GRACE_MS = 5_000;
const EXPERIMENTS = [ 'refresh-race' ];
const LF = String.fromCharCode(10);

/** The probe cannot run safely here; nothing native was started. */
class Refusal extends Error {}

type ProbeSignal = 'SIGHUP' | 'SIGINT' | 'SIGTERM';
const signalNumbers: Record<ProbeSignal, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

/** Directories this probe created, named on every exit. */
const created: string[] = [];
/** Process groups this probe started and still owns. */
const ownedGroups = new Map<number, string>();
const activeAborts = new Set<AbortController>();
const probeState: { interrupted: ProbeSignal | null, nativeRuns: number } = { interrupted: null, nativeRuns: 0 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pgid: number): void {
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    // already gone
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ promise, new Promise<T>(done => { timer = setTimeout(() => done(fallback), ms); }) ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) {
      return true;
    }
    await Bun.sleep(100);
  }
  return check();
}

function installInterruptHandlers(): void {
  for (const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] as const) {
    process.on(signal, () => {
      if (probeState.interrupted === null) {
        probeState.interrupted = signal;
        process.stderr.write(`native-loopback: received ${signal}; interrupting the current run with SIGINT and skipping the rest${LF}`);
        for (const abort of activeAborts) {
          abort.abort();
        }
        return;
      }
      process.stderr.write(`native-loopback: received ${signal} again; SIGKILL to every owned process group${LF}`);
      for (const pgid of ownedGroups.keys()) {
        killGroup(pgid);
      }
      if (created.length > 0) {
        process.stderr.write(`native-loopback: left for inspection: ${created.join(', ')}${LF}`);
      }
      process.exit(128 + signalNumbers[signal]);
    });
  }
}

// ------------------------------------------------------------ owned helper processes (preflight)

interface Owned {
  code: number | null,
  signal: string | null,
  timedOut: boolean,
  stdout: string,
  stderr: string,
  groupRemained: boolean,
  spawnError: string | null,
}

async function runOwned(command: readonly string[], env: Record<string, string>, cwd: string, deadlineMs: number, label: string): Promise<Owned> {
  const [ file, ...args ] = command;
  if (file === undefined) {
    throw new Error('empty command');
  }
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const child = spawn(file, args, { cwd, env, detached: true, stdio: [ 'ignore', 'pipe', 'pipe' ] });
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const exited = new Promise<{ code: number | null, signal: string | null }>(done => child.once('exit', (code, signal) => done({ code, signal })));
  const failed = new Promise<string>(done => child.once('error', error => done(String(error))));
  const pid = child.pid;
  if (pid === undefined) {
    return { code: null, signal: null, timedOut: false, stdout: '', stderr: '', groupRemained: false, spawnError: await failed };
  }
  ownedGroups.set(pid, label);
  const first = await within(exited, deadlineMs, null);
  const timedOut = first === null;
  if (timedOut) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
    await waitUntil(() => !groupAlive(pid), GRACE_MS);
  }
  if (groupAlive(pid)) {
    killGroup(pid);
    await waitUntil(() => !groupAlive(pid), 2_000);
  }
  const exit = first ?? await within(exited, GRACE_MS, null);
  const groupRemained = groupAlive(pid);
  if (!groupRemained) {
    ownedGroups.delete(pid);
  }
  return {
    code: exit?.code ?? null,
    signal: exit?.signal ?? null,
    timedOut,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
    groupRemained,
    spawnError: null,
  };
}

// ------------------------------------------------------------ isolation setup

/**
 * The real native homes of the user running the probe, computed here and
 * never named in source: `~/.codex` under both HOME and the account home, and
 * the CODEX_HOME this shell selects. Only existing paths outside the probe
 * root are listed. The probe never reads them; it only denies them.
 */
function nativeHomes(root: string): string[] {
  const candidates = [ join(homedir(), '.codex'), join(userInfo().homedir, '.codex'), process.env['CODEX_HOME'] ];
  const found = new Set<string>();
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === '') {
      continue;
    }
    const path = resolve(candidate);
    if (!existsSync(path)) {
      continue;
    }
    const real = realpathSync(path);
    const inside = relative(root, real);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      continue;
    }
    found.add(real);
  }
  return [ ...found ];
}

function makeDecoy(): { dir: string, file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bare-codex-probe-decoy-home-')));
  const file = join(dir, 'decoy.txt');
  writeFileSync(file, `bare-codex probe decoy: not a credential${LF}`, { mode: 0o600 });
  return { dir, file };
}

/** Native would load instruction files or a repository above the probe's working roots. */
function assertNoAmbientInstructions(dir: string): void {
  for (let current = dir; ; current = dirname(current)) {
    for (const name of [ 'AGENTS.md', 'AGENTS.override.md', '.git', '.codex' ]) {
      if (existsSync(join(current, name))) {
        throw new Refusal(`${join(current, name)} exists above the probe root; native would pick it up`);
      }
    }
    if (dirname(current) === current) {
      return;
    }
  }
}

// ------------------------------------------------------------ scenario plumbing

/** Connections to the decoy listener; any while native runs means containment failed. */
interface DecoyCounter {
  connections: number,
  duringNative: number,
}

interface Ctx {
  root: string,
  port: number,
  profile: string,
  native: string,
  baseEnv: Record<string, string>,
  stub: Stub,
  homes: Map<string, HomeSpec>,
  decoy: DecoyCounter,
}

interface HomeSpec {
  top?: string[],
  provider?: string[],
  tables?: string[],
  auth?: string,
}

const defaultProvider = [ 'request_max_retries = 1', 'stream_max_retries = 1', 'stream_idle_timeout_ms = 20000' ];

/**
 * The stand-in provider as `-c` overrides, on every run. With
 * `--ignore-user-config` the home's config.toml is skipped (exec/src/cli.rs:44-46),
 * and without these an isolated run would fall back to the built-in provider
 * and never reach the stand-in. Declared public: loopback URL and probe names.
 */
function providerOverrides(ctx: Ctx, route: string): ConfigOverride[] {
  const provider = ctx.homes.get(route)?.provider ?? defaultProvider;
  const lines = [ 'name = "probe"', `base_url = "http://127.0.0.1:${ctx.port}/s/${route}/v1"`, 'wire_api = "responses"', 'supports_websockets = false', ...provider ];
  return [
    { key: 'model', value: '"probe-model"', public: true },
    { key: 'model_provider', value: '"probe"', public: true },
    { key: 'cli_auth_credentials_store', value: '"file"', public: true },
    ...lines.map(line => {
      const at = line.indexOf('=');
      return { key: `model_providers.probe.${line.slice(0, at).trim()}`, value: line.slice(at + 1).trim(), public: true };
    }),
  ];
}

/** A synthetic home whose provider is the stand-in under the route named like the home. */
function writeHome(ctx: Ctx, name: string, spec: HomeSpec = {}): string {
  const dir = join(ctx.root, 'homes', name);
  if (existsSync(dir)) {
    return dir;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ctx.homes.set(name, spec);
  const toml = [
    'model = "probe-model"',
    'model_provider = "probe"',
    'cli_auth_credentials_store = "file"',
    ...(spec.top ?? []),
    '',
    '[model_providers.probe]',
    'name = "probe"',
    `base_url = "http://127.0.0.1:${ctx.port}/s/${name}/v1"`,
    'wire_api = "responses"',
    'supports_websockets = false',
    ...(spec.provider ?? defaultProvider),
    '',
    ...(spec.tables ?? []),
    '',
  ].join(LF);
  writeFileSync(join(dir, 'config.toml'), toml, { mode: 0o600 });
  if (spec.auth !== undefined) {
    writeFileSync(join(dir, 'auth.json'), spec.auth, { mode: 0o600 });
  }
  return dir;
}

function workDir(ctx: Ctx, name: string, files: Record<string, string> = {}): string {
  const dir = join(ctx.root, 'work', name);
  mkdirSync(dir, { recursive: true });
  for (const [ path, content ] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [ join(dir, entry.name) ]);
}

function listSqlite(dir: string): string[] {
  try {
    return readdirSync(dir).filter(name => name.endsWith('.sqlite'));
  } catch {
    return [];
  }
}

function clipJson(value: JsonValue): unknown {
  const text = JSON.stringify(value);
  return text.length <= 4_000 ? value : { truncated: true, text: text.slice(0, 4_000) };
}

interface RolloutView {
  files: string[],
  sessionMeta: unknown,
  turnContexts: unknown[],
  lines: number,
  unparsed: number,
}

/** The probe's own synthetic rollouts: session meta and turn contexts, as native recorded them. */
function readRollouts(home: string, threadId: string | null): RolloutView {
  const files = walk(join(home, 'sessions')).filter(path => basename(path).startsWith('rollout-') && path.endsWith('.jsonl') && (threadId === null || path.includes(threadId)));
  const view: RolloutView = { files, sessionMeta: null, turnContexts: [], lines: 0, unparsed: 0 };
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split(LF)) {
      if (line.trim() === '') {
        continue;
      }
      view.lines += 1;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        view.unparsed += 1;
        continue;
      }
      if (!isJsonObject(value)) {
        continue;
      }
      const payload = value['payload'] ?? null;
      if (value['type'] === 'turn_context') {
        view.turnContexts.push(clipJson(payload));
      } else if (value['type'] === 'session_meta') {
        view.sessionMeta = clipJson(payload);
      }
    }
  }
  return view;
}

/** The permission-describing fields of a turn context. */
function permissionFields(context: unknown): unknown {
  if (!isJsonObject(context)) {
    return context;
  }
  return Object.fromEntries(Object.entries(context).filter(([ key ]) => /approval|sandbox|permission|network/.test(key)));
}

interface ScenarioSpec {
  name: string,
  home: string,
  cwd: string,
  prompt: string,
  permissions: PermissionsPolicy,
  config?: ConfigPolicy,
  session?: SessionPolicy,
  overrides?: ConfigOverride[],
  env?: Record<string, string>,
  strictConfig?: boolean,
  outputSchemaFile?: string,
  script: ScenarioScript,
  markers?: readonly string[],
  onEvent?: (event: ParsedEvent) => void,
  onSpawn?: (info: SpawnInfo) => void,
  abort?: AbortController,
}

interface Observation {
  name: string,
  home: string,
  cwd: string,
  outDir: string,
  permissions: PermissionsPolicy,
  config: ConfigPolicy,
  outcome: CodexOutcome,
  requests: RequestView[],
  rollout: RolloutView,
  deadlineHit: boolean,
  /** Native's group still had processes when bare-codex returned. */
  groupAliveAfterRun: boolean,
  /** ...and still had them after the probe's own SIGKILL: only this stops later scenarios. */
  groupSurvivedProbeKill: boolean,
  /** Decoy connections while this run (and any concurrent one) was active. */
  decoyConnections: number,
  /** Stand-in requests during the run whose path named no route. */
  unattributedRequests: number,
}

async function runScenario(ctx: Ctx, spec: ScenarioSpec): Promise<Observation> {
  const route = basename(spec.home);
  ctx.stub.scripts.set(route, spec.script);
  const before = ctx.stub.requests.length;
  const abort = spec.abort ?? new AbortController();
  activeAborts.add(abort);
  if (probeState.interrupted !== null) {
    abort.abort();
  }
  const timing = { deadlineHit: false };
  const deadline = setTimeout(() => {
    timing.deadlineHit = true;
    abort.abort();
  }, RUN_DEADLINE_MS);
  const spawned: { pgid: number | null } = { pgid: null };
  const outDir = join(ctx.root, 'runs', spec.name);
  const config = spec.config ?? { kind: 'inherit' };
  const decoyBefore = ctx.decoy.duringNative;
  probeState.nativeRuns += 1;
  try {
    const result = await runCodex({
      codexPath: ctx.native,
      cwd: spec.cwd,
      home: { kind: 'path', codexHome: spec.home },
      config,
      permissions: spec.permissions,
      session: spec.session,
      overrides: [ ...providerOverrides(ctx, route), ...(spec.overrides ?? []) ],
      strictConfig: spec.strictConfig,
      outputSchemaFile: spec.outputSchemaFile,
      allowOutsideRepo: true,
      env: { inherit: false, set: { ...ctx.baseEnv, ...spec.env } },
      baseEnv: {},
      prompt: spec.prompt,
      outDir,
      wrapper: [ SANDBOX_EXEC, '-p', ctx.profile ],
      signals: 'none',
      signal: abort.signal,
      stopGraceMs: GRACE_MS,
      hashExecutable: false,
      onSpawn: info => {
        spawned.pgid = info.processGroup ?? info.pid;
        ownedGroups.set(spawned.pgid, spec.name);
        spec.onSpawn?.(info);
      },
      onEvent: spec.onEvent,
    });
    // Only a group this run spawned and still owns is ever signalled.
    let groupAliveAfterRun = false;
    let groupSurvivedProbeKill = false;
    const pgid = spawned.pgid;
    if (pgid !== null && ownedGroups.get(pgid) === spec.name) {
      groupAliveAfterRun = groupAlive(pgid);
      if (groupAliveAfterRun) {
        killGroup(pgid);
        await waitUntil(() => !groupAlive(pgid), 2_000);
        groupSurvivedProbeKill = groupAlive(pgid);
      }
      if (!groupSurvivedProbeKill) {
        ownedGroups.delete(pgid);
      }
    }
    const fresh = ctx.stub.requests.slice(before);
    const markers = spec.markers ?? [];
    const observation: Observation = {
      name: spec.name,
      home: spec.home,
      cwd: spec.cwd,
      outDir,
      permissions: spec.permissions,
      config,
      outcome: result.outcome,
      requests: fresh.filter(request => request.route === route).map(request => requestSummary(request, markers)),
      rollout: readRollouts(spec.home, result.outcome.threadId),
      deadlineHit: timing.deadlineHit,
      groupAliveAfterRun,
      groupSurvivedProbeKill,
      decoyConnections: ctx.decoy.duringNative - decoyBefore,
      unattributedRequests: fresh.filter(request => request.route === '(unattributed)').length,
    };
    writeFileSync(join(outDir, 'probe-observation.json'), `${JSON.stringify(observation, null, 2)}${LF}`);
    return observation;
  } finally {
    probeState.nativeRuns -= 1;
    clearTimeout(deadline);
    activeAborts.delete(abort);
  }
}

interface ToolIdentity {
  pid: number,
  pgid: number | null,
  args: string | null,
  /** Whether the tool was still in native's process group; null when unknown. */
  inRunGroup: boolean | null,
  /** The pid is alive and its arguments match this probe's uniquely marked sleep. */
  verified: boolean,
}

/** Identifies the process behind a pid read from a file before the probe acts on it. */
function toolIdentity(pid: number, runGroup: number | null, expectedArgs: string): ToolIdentity {
  const result = Bun.spawnSync([ '/bin/ps', '-o', 'pgid=', '-o', 'args=', '-p', String(pid) ], { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'ignore' });
  const line = result.stdout.toString('utf8').trim();
  const match = /^([0-9]+)[ ]+(.*)$/.exec(line);
  const pgid = match?.[1] === undefined ? null : Number(match[1]);
  const args = match?.[2]?.trim() ?? null;
  return {
    pid,
    pgid,
    args,
    inRunGroup: pgid === null || runGroup === null ? null : pgid === runGroup,
    verified: result.exitCode === 0 && args === expectedArgs,
  };
}

type FindingStatus = 'held' | 'not-held' | 'observed' | 'inconclusive';

interface Finding {
  status: FindingStatus,
  evidence: unknown,
}

function brief(observation: Observation): unknown {
  const { outcome } = observation;
  return {
    run: observation.name,
    status: outcome.status,
    reason: outcome.reason,
    detail: outcome.detail,
    threadId: outcome.threadId,
    exit: outcome.exit,
    failure: outcome.failure,
    diagnostics: outcome.diagnostics.map(diagnostic => diagnostic.code),
    requests: observation.requests.length,
    deadlineHit: observation.deadlineHit,
  };
}

function anyMarker(observation: Observation): string[] {
  return [ ...new Set(observation.requests.flatMap(request => request.markers)) ];
}

const prompt = (tag: string) => `bare-codex probe ${tag}: answer with the scripted text`;

// ------------------------------------------------------------ scenarios

interface Scenarios {
  observations: Observation[],
  findings: Record<string, Finding>,
  stoppedAfter: string | null,
}

async function runScenarios(ctx: Ctx, experiments: ReadonlySet<string>): Promise<Scenarios> {
  const observations: Observation[] = [];
  const findings: Record<string, Finding> = {};
  const stop: { after: string | null } = { after: null };
  const proceed = () => probeState.interrupted === null && stop.after === null;
  const record = (observation: Observation): Observation => {
    observations.push(observation);
    if (observation.groupSurvivedProbeKill) {
      stop.after = observation.name;
    }
    return observation;
  };
  const done = (): Scenarios => ({ observations, findings, stoppedAfter: stop.after });
  const readOnly: PermissionsPolicy = { kind: 'sandbox', mode: 'read-only' };

  // P1: one turn, end to end.
  const p1Home = writeHome(ctx, 'p1');
  const p1 = record(await runScenario(ctx, { name: 'p1-basic', home: p1Home, cwd: workDir(ctx, 'p1'), prompt: prompt('p1'), permissions: readOnly, script: textScript('PROBE-FINAL-P1') }));
  const p1Held = p1.outcome.status === 'completed' && p1.outcome.finalMessage.text === 'PROBE-FINAL-P1' && p1.outcome.threadId !== null && p1.requests.length > 0;
  findings['protocol'] = { status: p1Held ? 'held' : 'not-held', evidence: { ...Object(brief(p1)), finalText: p1.outcome.finalMessage.text, eventTypes: p1.outcome.stream.eventTypes, rollouts: p1.rollout.files.length } };
  findings['final-message'] = { status: 'observed', evidence: { matchesStream: p1.outcome.finalMessage.matchesStream } };
  findings['databases'] = { status: 'observed', evidence: { inNamedHome: listSqlite(p1Home) } };
  if (!proceed()) {
    return done();
  }

  // P2: which instruction and config layers reach the request, inherited versus isolated.
  const p2Work = workDir(ctx, 'p2', { 'AGENTS.md': `MARK-AGENTS-MD: the probe instruction file.${LF}`, '.codex/config.toml': `developer_instructions = "MARK-PROJECT-DEV"${LF}` });
  const p2Home = writeHome(ctx, 'p2', { top: [ 'developer_instructions = "MARK-USER-DEV"' ], tables: [ `[projects.${JSON.stringify(p2Work)}]`, 'trust_level = "trusted"' ] });
  const p2Markers = [ 'MARK-USER-DEV', 'MARK-PROJECT-DEV', 'MARK-AGENTS-MD', 'MARK-CLI-DEV' ];
  const p2Runs: { name: string, config: ConfigPolicy, overrides?: ConfigOverride[] }[] = [
    { name: 'p2-inherit', config: { kind: 'inherit' } },
    { name: 'p2-isolated', config: { kind: 'isolated' } },
    { name: 'p2-cli-override', config: { kind: 'inherit' }, overrides: [ { key: 'developer_instructions', value: '"MARK-CLI-DEV"' } ] },
  ];
  const p2Evidence: unknown[] = [];
  for (const run of p2Runs) {
    if (!proceed()) {
      return done();
    }
    const observation = record(await runScenario(ctx, { name: run.name, home: p2Home, cwd: p2Work, prompt: prompt(run.name), permissions: readOnly, config: run.config, overrides: run.overrides, script: textScript('PROBE-FINAL-P2'), markers: p2Markers }));
    p2Evidence.push({ ...Object(brief(observation)), markersSeen: anyMarker(observation) });
  }
  findings['config-precedence'] = { status: 'observed', evidence: p2Evidence };

  // P3: named profile, legacy sandbox and approve-for-me, as native records them.
  const grant = workDir(ctx, 'p3-granted');
  const profileTable = [ '[permissions.probe-profile.filesystem]', `${JSON.stringify(grant)} = "write"` ];
  const p3Home = writeHome(ctx, 'p3', { top: [ 'default_permissions = "probe-profile"' ], tables: profileTable });
  const p3Plain = writeHome(ctx, 'p3-plain', { tables: profileTable });
  const p3Runs: { name: string, home: string, permissions: PermissionsPolicy }[] = [
    { name: 'p3-inherit', home: p3Home, permissions: { kind: 'inherit' } },
    { name: 'p3-sandbox-read-only', home: p3Home, permissions: { kind: 'sandbox', mode: 'read-only' } },
    { name: 'p3-sandbox-workspace-write', home: p3Home, permissions: { kind: 'sandbox', mode: 'workspace-write' } },
    { name: 'p3-approve-for-me', home: p3Home, permissions: { kind: 'approve-for-me' } },
    { name: 'p3-profile-override', home: p3Plain, permissions: { kind: 'profile', name: 'probe-profile' } },
  ];
  const p3Evidence: unknown[] = [];
  for (const run of p3Runs) {
    if (!proceed()) {
      return done();
    }
    const observation = record(await runScenario(ctx, { name: run.name, home: run.home, cwd: workDir(ctx, 'p3'), prompt: prompt(run.name), permissions: run.permissions, script: textScript('PROBE-FINAL-P3') }));
    p3Evidence.push({
      ...Object(brief(observation)),
      permissions: run.permissions,
      turnContexts: observation.rollout.turnContexts.map(permissionFields),
      requestTags: observation.requests.map(request => request.permissionTags),
    });
  }
  findings['permissions'] = { status: 'observed', evidence: p3Evidence };
  if (!proceed()) {
    return done();
  }

  // P4: an output schema reaches the request.
  const schemaFile = join(ctx.root, 'work', 'p4-schema.json');
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: { answer: { type: 'string' } }, required: [ 'answer' ], additionalProperties: false }));
  const p4 = record(await runScenario(ctx, { name: 'p4-output-schema', home: writeHome(ctx, 'p4'), cwd: workDir(ctx, 'p4'), prompt: prompt('p4'), permissions: readOnly, outputSchemaFile: schemaFile, script: textScript('{"answer":"probe"}') }));
  const p4Format = p4.requests.find(request => request.textFormat !== null)?.textFormat ?? null;
  findings['output-schema'] = { status: p4.outcome.status === 'completed' && p4Format !== null ? 'held' : 'not-held', evidence: { ...Object(brief(p4)), textFormat: p4Format, finalText: p4.outcome.finalMessage.text } };
  if (!proceed()) {
    return done();
  }

  // P5: resume and fork in the same home; resume from another home.
  const p5Home = writeHome(ctx, 'p5');
  const p5Work = workDir(ctx, 'p5');
  const p5Markers = [ 'MARK-FIRST-TURN', 'MARK-SECOND-TURN', 'MARK-FORK-TURN' ];
  const first = record(await runScenario(ctx, { name: 'p5-first', home: p5Home, cwd: p5Work, prompt: 'MARK-FIRST-TURN answer with the scripted text', permissions: readOnly, script: textScript('PROBE-FIRST'), markers: p5Markers }));
  const firstThread = first.outcome.threadId;
  if (firstThread === null || !proceed()) {
    findings['resume-fork'] = { status: 'inconclusive', evidence: { reason: 'the first turn produced no thread id', first: brief(first) } };
    return done();
  }
  const resumed = record(await runScenario(ctx, { name: 'p5-resume', home: p5Home, cwd: p5Work, prompt: 'MARK-SECOND-TURN answer again', permissions: readOnly, session: { kind: 'resume', threadId: firstThread }, script: textScript('PROBE-SECOND'), markers: p5Markers }));
  const resumeHeld = resumed.outcome.status === 'completed' && resumed.outcome.threadId === firstThread && anyMarker(resumed).includes('MARK-FIRST-TURN');
  findings['resume'] = { status: resumeHeld ? 'held' : 'not-held', evidence: { ...Object(brief(resumed)), sourceThread: firstThread, markersSeen: anyMarker(resumed) } };
  if (!proceed()) {
    return done();
  }
  const forked = record(await runScenario(ctx, { name: 'p5-fork', home: p5Home, cwd: p5Work, prompt: 'MARK-FORK-TURN answer in the fork', permissions: readOnly, session: { kind: 'fork', threadId: firstThread }, script: textScript('PROBE-FORK'), markers: p5Markers }));
  const forkHeld = forked.outcome.status === 'completed' && forked.outcome.threadId !== null && forked.outcome.threadId !== firstThread && anyMarker(forked).includes('MARK-FIRST-TURN');
  findings['fork'] = { status: forkHeld ? 'held' : 'not-held', evidence: { ...Object(brief(forked)), sourceThread: firstThread, markersSeen: anyMarker(forked) } };
  if (!proceed()) {
    return done();
  }
  const cross = record(await runScenario(ctx, { name: 'p5-resume-other-home', home: writeHome(ctx, 'p5-other'), cwd: p5Work, prompt: 'MARK-SECOND-TURN from another home', permissions: readOnly, session: { kind: 'resume', threadId: firstThread }, script: textScript('PROBE-CROSS'), markers: p5Markers }));
  findings['resume-other-home'] = { status: 'observed', evidence: { ...Object(brief(cross)), markersSeen: anyMarker(cross) } };
  if (!proceed()) {
    return done();
  }

  // P6: interruption of a running tool through bare-codex (SIGINT), and the raw SIGTERM contrast.
  const cancel = async (name: string, mode: 'abort' | 'sigterm'): Promise<{ observation: Observation, tool: ToolIdentity | null, toolSurvived: boolean, toolAliveUnverified: boolean, probeKilledTool: boolean, triggered: boolean }> => {
    const work = workDir(ctx, name);
    const pidFile = join(work, 'tool.pid');
    const toolDuration = `600.${Number.parseInt(Buffer.from(basename(ctx.root)).toString('hex').slice(-12), 16)}`;
    const expectedToolArgs = `/bin/sleep ${toolDuration}`;
    const abort = new AbortController();
    const trigger: { fired: boolean, nativePid: number | null, group: number | null } = { fired: false, nativePid: null, group: null };
    const script = sequenceScript([ { kind: 'shell', script: `echo $$ > '${pidFile}'; exec ${expectedToolArgs}` } ], { kind: 'text', text: 'PROBE-AFTER-TOOL' });
    const observation = record(await runScenario(ctx, {
      name,
      home: writeHome(ctx, name),
      cwd: work,
      prompt: prompt(name),
      permissions: { kind: 'sandbox', mode: 'danger-full-access' },
      script,
      abort,
      onSpawn: info => {
        trigger.nativePid = info.pid;
        trigger.group = info.processGroup;
      },
      onEvent: event => {
        const item = event.event['item'];
        if (trigger.fired || event.type !== 'item.started' || !isJsonObject(item) || item['type'] !== 'command_execution') {
          return;
        }
        trigger.fired = true;
        void waitUntil(() => existsSync(pidFile), 10_000).then(() => {
          if (mode === 'abort') {
            abort.abort();
          } else if (trigger.nativePid !== null) {
            try {
              process.kill(trigger.nativePid, 'SIGTERM');
            } catch {
              // already gone
            }
          }
        });
      },
    }));
    const read = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) : null;
    const toolPid = read !== null && Number.isInteger(read) && read > 1 ? read : null;
    const tool = toolPid === null ? null : toolIdentity(toolPid, trigger.group, expectedToolArgs);
    const toolSurvived = tool?.verified === true;
    const toolAliveUnverified = tool !== null && !tool.verified && pidAlive(tool.pid);
    let probeKilledTool = false;
    if (tool !== null && toolSurvived) {
      // Verified as the probe's own tool process (its script wrote this pid and
      // exec'd a sleep carrying this probe's unique suffix); an unverified pid is reported, never signalled.
      try {
        process.kill(tool.pid, 'SIGKILL');
        probeKilledTool = true;
      } catch {
        // already gone
      }
    }
    return { observation, tool, toolSurvived, toolAliveUnverified, probeKilledTool, triggered: trigger.fired };
  };
  const interrupted = await cancel('p6-cancel', 'abort');
  const stopFacts = interrupted.observation.outcome.stop;
  const cancelHeld = interrupted.triggered && interrupted.observation.outcome.status === 'stopped' && stopFacts?.cause === 'abort' && stopFacts.nativeSignal === 'SIGINT'
    && interrupted.observation.outcome.custody?.groupState === 'empty' && !interrupted.toolSurvived && !interrupted.toolAliveUnverified && !interrupted.observation.groupAliveAfterRun;
  findings['cancel'] = {
    status: !interrupted.triggered ? 'inconclusive' : cancelHeld ? 'held' : 'not-held',
    evidence: {
      ...Object(brief(interrupted.observation)),
      stop: stopFacts,
      custody: interrupted.observation.outcome.custody,
      tool: interrupted.tool,
      toolSurvived: interrupted.toolSurvived,
      toolAliveUnverified: interrupted.toolAliveUnverified,
      probeKilledTool: interrupted.probeKilledTool,
      shellTool: interrupted.observation.requests.find(request => request.shellTool !== null)?.shellTool ?? null,
    },
  };
  if (!proceed()) {
    return done();
  }
  const contrast = await cancel('p6-sigterm-contrast', 'sigterm');
  findings['sigterm-contrast'] = {
    status: contrast.triggered ? 'observed' : 'inconclusive',
    evidence: {
      ...Object(brief(contrast.observation)),
      custody: contrast.observation.outcome.custody,
      tool: contrast.tool,
      toolSurvived: contrast.toolSurvived,
      toolAliveUnverified: contrast.toolAliveUnverified,
      probeKilledTool: contrast.probeKilledTool,
      groupAliveAfterRun: contrast.observation.groupAliveAfterRun,
      groupSurvivedProbeKill: contrast.observation.groupSurvivedProbeKill,
    },
  };
  if (!proceed()) {
    return done();
  }

  // P7: native retries: a truncated stream once, always, and an HTTP 500 once.
  const p7Home = writeHome(ctx, 'p7', { provider: [ 'request_max_retries = 2', 'stream_max_retries = 2', 'stream_idle_timeout_ms = 10000' ] });
  const p7Work = workDir(ctx, 'p7');
  const recovered = record(await runScenario(ctx, { name: 'p7-recovered', home: p7Home, cwd: p7Work, prompt: prompt('p7-recovered'), permissions: readOnly, script: sequenceScript([ { kind: 'truncated' } ], { kind: 'text', text: 'PROBE-FINAL-P7' }) }));
  findings['retry-recovered'] = { status: recovered.outcome.status === 'completed' && recovered.outcome.recoveredErrors.count > 0 ? 'held' : 'not-held', evidence: { ...Object(brief(recovered)), recoveredErrors: recovered.outcome.recoveredErrors, replies: recovered.requests.map(request => request.reply) } };
  if (!proceed()) {
    return done();
  }
  const exhausted = record(await runScenario(ctx, { name: 'p7-exhausted', home: p7Home, cwd: p7Work, prompt: prompt('p7-exhausted'), permissions: readOnly, script: { reply: () => ({ kind: 'truncated' }) } }));
  findings['retry-exhausted'] = { status: exhausted.outcome.status === 'failed' ? 'held' : 'not-held', evidence: { ...Object(brief(exhausted)), replies: exhausted.requests.map(request => request.reply) } };
  if (!proceed()) {
    return done();
  }
  const http500 = record(await runScenario(ctx, { name: 'p7-http-500', home: p7Home, cwd: p7Work, prompt: prompt('p7-http-500'), permissions: readOnly, script: sequenceScript([ { kind: 'status', status: 500 } ], { kind: 'text', text: 'PROBE-FINAL-P7' }) }));
  findings['retry-http-500'] = { status: 'observed', evidence: { ...Object(brief(http500)), errors: http500.outcome.stream.errors, replies: http500.requests.map(request => request.reply) } };
  if (!proceed()) {
    return done();
  }

  // P8: --strict-config and -c overrides.
  const p8Home = writeHome(ctx, 'p8');
  const p8Work = workDir(ctx, 'p8');
  const strictKnown = record(await runScenario(ctx, { name: 'p8-strict-known', home: p8Home, cwd: p8Work, prompt: prompt('p8'), permissions: readOnly, strictConfig: true, script: textScript('PROBE-FINAL-P8') }));
  const strictUnknown = record(await runScenario(ctx, { name: 'p8-strict-unknown', home: p8Home, cwd: p8Work, prompt: prompt('p8'), permissions: readOnly, strictConfig: true, overrides: [ { key: 'probe_unknown_key', value: '"probe"' } ], script: textScript('PROBE-FINAL-P8') }));
  findings['strict-config'] = { status: 'observed', evidence: [ brief(strictKnown), brief(strictUnknown) ] };
  if (!proceed()) {
    return done();
  }

  // P9: an inherited CODEX_SQLITE_HOME.
  const p9Home = writeHome(ctx, 'p9');
  const sqliteDir = workDir(ctx, 'p9-sqlite');
  const p9 = record(await runScenario(ctx, { name: 'p9-sqlite-home', home: p9Home, cwd: workDir(ctx, 'p9'), prompt: prompt('p9'), permissions: readOnly, env: { CODEX_SQLITE_HOME: sqliteDir }, script: textScript('PROBE-FINAL-P9') }));
  findings['sqlite-home'] = { status: 'observed', evidence: { ...Object(brief(p9)), inNamedHome: listSqlite(p9Home), inSqliteHome: listSqlite(sqliteDir) } };

  if (experiments.has('refresh-race') && proceed()) {
    findings['refresh-race'] = await refreshRace(ctx, record);
  }
  return done();
}

/**
 * Experiment: two fresh processes share one synthetic ChatGPT-mode home whose
 * access token has expired, so each refreshes on its own. The stand-in counts
 * refresh requests per refresh token and answers any reuse with
 * `refresh_token_reused`. Characterization only: the synthetic auth.json
 * follows storage.rs:49-73, and the token fields not in the extracted blobs
 * (token_data.rs) are inferred, so native may reject the file; that is then
 * the finding.
 */
async function refreshRace(ctx: Ctx, record: (observation: Observation) => Observation): Promise<Finding> {
  const now = Math.floor(Date.now() / 1000);
  const auth = JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: syntheticJwt({ ...syntheticClaims, iat: now - 7_200, exp: now + 3_600 }),
      access_token: syntheticJwt({ ...syntheticClaims, iat: now - 7_200, exp: now - 60 }),
      refresh_token: 'SYNTH-RT-1',
      account_id: 'probe-account',
    },
    last_refresh: new Date((now - 7_200) * 1000).toISOString(),
  }, null, 2);
  const home = writeHome(ctx, 'p10', { provider: [ 'requires_openai_auth = true', 'request_max_retries = 1', 'stream_max_retries = 1', 'stream_idle_timeout_ms = 20000' ], auth });
  const authPath = join(home, 'auth.json');
  const before = statSync(authPath);
  const env = { CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${ctx.port}/oauth/token` };
  const refreshBefore = ctx.stub.refreshRequests.length;
  const [ a, b ] = await Promise.all([
    runScenario(ctx, { name: 'p10-a', home, cwd: workDir(ctx, 'p10-a'), prompt: prompt('p10-a'), permissions: { kind: 'sandbox', mode: 'read-only' }, env, script: textScript('PROBE-FINAL-P10') }),
    runScenario(ctx, { name: 'p10-b', home, cwd: workDir(ctx, 'p10-b'), prompt: prompt('p10-b'), permissions: { kind: 'sandbox', mode: 'read-only' }, env, script: textScript('PROBE-FINAL-P10') }),
  ]);
  record(a);
  record(b);
  const after = statSync(authPath);
  let storedRefresh: string | null = null;
  try {
    const stored: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
    const tokens = isJsonObject(stored) ? stored['tokens'] : undefined;
    const refresh = isJsonObject(tokens) ? tokens['refresh_token'] : undefined;
    storedRefresh = typeof refresh === 'string' ? fingerprint(refresh) : null;
  } catch (error) {
    storedRefresh = `unreadable: ${errorMessage(error)}`;
  }
  return {
    status: 'observed',
    evidence: {
      runs: [ { ...Object(brief(a)), auth: a.outcome.failure?.auth ?? null }, { ...Object(brief(b)), auth: b.outcome.failure?.auth ?? null } ],
      refreshRequests: ctx.stub.refreshRequests.slice(refreshBefore),
      authFile: { inodeSame: before.ino === after.ino, modeBefore: (before.mode & 0o777).toString(8), modeAfter: (after.mode & 0o777).toString(8), refreshTokenFingerprint: storedRefresh, initialFingerprint: fingerprint('SYNTH-RT-1') },
    },
  };
}

// ------------------------------------------------------------ main

async function listenerClosed(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    const timer = setTimeout(() => {
      socket.destroy();
      done(false);
    }, 2_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      done(false);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(true);
    });
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      codex: { type: 'string' },
      experiment: { type: 'string', multiple: true },
      'allow-version-drift': { type: 'boolean' },
    },
  });
  if (process.platform !== 'darwin') {
    throw new Refusal('the outer sandbox is implemented with macOS sandbox-exec only');
  }
  try {
    accessSync(SANDBOX_EXEC, constants.X_OK);
  } catch {
    throw new Refusal(`${SANDBOX_EXEC} is not available`);
  }
  const named = values.codex ?? process.env['BARE_CODEX_PROBE_NATIVE'];
  if (named === undefined || named === '') {
    throw new Refusal('name the native codex executable with --codex or BARE_CODEX_PROBE_NATIVE; PATH is not searched');
  }
  let native: ExecutableFacts;
  try {
    native = await inspectExecutable(resolve(named));
  } catch (error) {
    throw new Refusal(`${named}: ${errorMessage(error)}`);
  }
  if (native.class !== 'native-binary') {
    throw new Refusal(`${native.realpath} is ${native.class}, not a native binary; name the native executable itself, not a launcher or wrapper`);
  }
  const experiments = new Set(values.experiment ?? []);
  for (const experiment of experiments) {
    if (!EXPERIMENTS.includes(experiment)) {
      throw new Refusal(`unknown experiment ${experiment}; known: ${EXPERIMENTS.join(', ')}`);
    }
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bare-codex-probe-')));
  created.push(root);
  for (const sub of [ 'home', 'tmp', 'homes', 'work', 'runs' ]) {
    mkdirSync(join(root, sub));
  }
  assertNoAmbientInstructions(root);
  const decoy = makeDecoy();
  created.push(decoy.dir);
  const writeCheck = realpathSync(mkdtempSync(join(tmpdir(), 'bare-codex-probe-write-check-')));
  created.push(writeCheck);
  const deniedReads = [ ...nativeHomes(root), decoy.dir ];
  for (const path of deniedReads) {
    const inside = relative(path, writeCheck);
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      throw new Refusal('the write-check directory lies inside a denied-read path');
    }
  }
  installInterruptHandlers();

  const stub = createStub();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: stub.handle });
  const decoyCounter: DecoyCounter = { connections: 0, duringNative: 0 };
  const decoyServer = createServer(socket => {
    decoyCounter.connections += 1;
    if (probeState.nativeRuns > 0) {
      decoyCounter.duringNative += 1;
    }
    socket.on('error', () => undefined);
    socket.end('decoy');
  });
  await new Promise<void>((done, fail) => {
    decoyServer.once('error', fail);
    decoyServer.listen(0, '127.0.0.1', () => done());
  });
  const decoyAddress = decoyServer.address();
  const port = server.port ?? 0;
  const decoyPort = typeof decoyAddress === 'object' && decoyAddress !== null ? decoyAddress.port : 0;
  const profile = sandboxProfile(root, port, deniedReads);
  writeFileSync(join(root, 'sandbox.sb'), profile);
  const baseEnv: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    LANG: 'en_US.UTF-8',
    USER: userInfo().username,
  };
  const ctx: Ctx = { root, port, profile, native: native.path, baseEnv, stub, homes: new Map(), decoy: decoyCounter };

  let report: Record<string, unknown> = {};
  let exitCode = 1;
  try {
    if (port === 0 || decoyPort === 0) {
      throw new Refusal('a loopback listener has no port');
    }
    const preflightEnv = { ...baseEnv, PROBE_PORT: String(port), PROBE_DECOY_PORT: String(decoyPort), PROBE_WRITE_TARGET: join(writeCheck, 'write-check'), PROBE_DECOY_FILE: decoy.file };
    const check = async (label: string, sandboxed: boolean): Promise<unknown> => {
      const command = sandboxed ? [ SANDBOX_EXEC, '-p', profile, process.execPath, PREFLIGHT ] : [ process.execPath, PREFLIGHT ];
      const run = await runOwned(command, { ...preflightEnv, PROBE_MODE: sandboxed ? 'sandboxed' : 'control' }, root, PREFLIGHT_DEADLINE_MS, `preflight ${label}`);
      writeFileSync(join(root, `preflight-${label}.stdout.txt`), run.stdout);
      writeFileSync(join(root, `preflight-${label}.stderr.txt`), run.stderr);
      if (run.spawnError !== null) {
        throw new Refusal(`preflight ${label} could not start: ${run.spawnError}`);
      }
      if (run.groupRemained) {
        throw new Refusal(`preflight ${label} left processes in its group`);
      }
      try {
        const last = run.stdout.trim().split(LF).at(-1) ?? '';
        const value: unknown = JSON.parse(last);
        return value;
      } catch {
        return null;
      }
    };
    const preflight = async (stage: string): Promise<{ before: unknown, sandboxed: unknown, after: unknown, verdict: IsolationVerdict }> => {
      const before = await check(`${stage}-control-before`, false);
      const sandboxed = await check(`${stage}-sandboxed`, true);
      const after = await check(`${stage}-control-after`, false);
      return { before, sandboxed, after, verdict: judgeIsolation(before, sandboxed, after) };
    };
    const isolation = await preflight('pre');
    writeFileSync(join(root, 'preflight-verdict.json'), `${JSON.stringify(isolation, null, 2)}${LF}`);
    if (isolation.verdict.failures.length > 0) {
      throw new Refusal(`the outer sandbox was not shown to hold, so native was not started: ${isolation.verdict.failures.join('; ')}`);
    }

    const version: VersionFacts = await probeVersion([ SANDBOX_EXEC, '-p', profile, native.path, '--version' ], baseEnv);
    if (version.version !== MEASURED_NATIVE_VERSION && values['allow-version-drift'] !== true) {
      throw new Refusal(`native reports ${String(version.version)}, not the measured ${MEASURED_NATIVE_VERSION}; pass --allow-version-drift to probe it anyway as an unmeasured version`);
    }

    const scenarios = await runScenarios(ctx, experiments);
    // Native-level negative controls: no native run may reach the decoy, and
    // every stand-in request should name its route.
    const decoyHeld = scenarios.observations.length > 0 && decoyCounter.duringNative === 0;
    scenarios.findings['native-decoy-traffic'] = {
      status: scenarios.observations.length === 0 ? 'inconclusive' : decoyHeld ? 'held' : 'not-held',
      evidence: { connectionsDuringNativeRuns: decoyCounter.duringNative, connectionsTotal: decoyCounter.connections, perRun: scenarios.observations.map(observation => ({ run: observation.name, decoyConnections: observation.decoyConnections })) },
    };
    scenarios.findings['stand-in-unattributed'] = {
      status: 'observed',
      evidence: scenarios.observations.filter(observation => observation.unattributedRequests > 0).map(observation => ({ run: observation.name, unattributedRequests: observation.unattributedRequests })),
    };
    const postflight = probeState.interrupted === null ? await preflight('post') : null;
    report = {
      schema: 'bare-codex.probe/v1',
      native: { path: native.path, realpath: native.realpath, sha256: native.sha256, size: native.size, class: native.class, version, measuredVersion: MEASURED_NATIVE_VERSION, sourceRevision: NATIVE_SOURCE_REVISION },
      root,
      decoyHome: decoy.dir,
      writeCheckDir: writeCheck,
      managedConfigPresent: existsSync('/etc/codex'),
      isolation: { pre: isolation, post: postflight, deniedReads, providerPort: port, decoyPort, profile: join(root, 'sandbox.sb') },
      experiments: [ ...experiments ],
      interrupted: probeState.interrupted,
      stoppedAfter: scenarios.stoppedAfter,
      findings: scenarios.findings,
      observations: scenarios.observations,
    };
    exitCode = scenarios.findings['protocol']?.status === 'held' && decoyHeld && postflight !== null && postflight.verdict.failures.length === 0 ? 0 : 1;
    if (probeState.interrupted !== null) {
      exitCode = 128 + signalNumbers[probeState.interrupted];
    }
  } finally {
    server.stop(true);
    await within(new Promise<void>(done => decoyServer.close(() => done())), 2_000, undefined);
  }

  const groups = [ ...ownedGroups.entries() ].map(([ pgid, label ]) => ({ pgid, label, alive: groupAlive(pgid) }));
  report['custody'] = {
    ownedGroupsRemaining: groups,
    listeners: { provider: (await listenerClosed(port)) ? 'closed' : 'open', decoy: (await listenerClosed(decoyPort)) ? 'closed' : 'open' },
    directories: created,
    decoyConnections: decoyCounter,
  };
  report['requests'] = stub.requests.map(request => ({ route: request.route, method: request.method, path: request.path, index: request.index, reply: request.reply }));
  writeFileSync(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}${LF}`);
  process.stdout.write(`${JSON.stringify({ root, report: join(root, 'report.json'), findings: report['findings'] ?? null, custody: report['custody'] }, null, 2)}${LF}`);
  return exitCode;
}

let code: number;
try {
  code = await main();
} catch (error) {
  process.stderr.write(`native-loopback: ${error instanceof Refusal ? 'refused' : 'failed'}: ${errorMessage(error)}${LF}`);
  const remaining = [ ...ownedGroups.keys() ].filter(groupAlive);
  for (const pgid of remaining) {
    killGroup(pgid);
  }
  if (remaining.length > 0) {
    process.stderr.write(`native-loopback: owned process groups still alive were sent SIGKILL: ${remaining.join(', ')}${LF}`);
  }
  code = error instanceof Refusal ? 2 : 1;
}
if (created.length > 0) {
  process.stderr.write(`native-loopback: left for inspection: ${created.join(', ')}${LF}`);
}
process.exit(code);
