/**
 * The planner: one pure function from what a caller wants to the exact
 * `codex exec` command line, environment and stdin, plus the refusals that
 * stop a run before anything is spawned. No filesystem, process, clock or
 * network access, so a consumer that keeps its own supervisor, stdin carrier
 * and ledger can use it alone.
 *
 * Native facts are from openai/codex revision 83086188 (rust-v0.163.0);
 * docs/NATIVE-0.163.0.md lists each with its source.
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { composeEnv, isTruthyFlag, type EnvFacts } from './env.ts';
import type {
  ConfigPolicy,
  EnvPolicy,
  ExecutableClass,
  HomePolicy,
  PermissionsPolicy,
  Refusal,
  RefusalCode,
  SandboxMode,
  SessionPolicy,
} from './types.ts';

/** The native version every native fact here was taken from, and the one the probe is built to measure. */
export const MEASURED_NATIVE_VERSION = '0.163.0';

/** The openai/codex revision of {@link MEASURED_NATIVE_VERSION}. */
export const NATIVE_SOURCE_REVISION = '83086188';

/** One `-c key=value` override. `value` is a TOML literal, passed as is. */
export interface ConfigOverride {
  key: string,
  value: string,

  /**
   * The caller declares the value non-secret, so records keep it as is.
   * Otherwise records keep only the key and a SHA-256 prefix of the value:
   * any value can carry a credential (a header, an inline table, a token),
   * and no key pattern can tell which.
   */
  public?: boolean,
}

/** Everything {@link planInvocation} needs. Paths must be absolute: the planner resolves nothing. */
export interface PlanOptions {
  /** The executable to spawn, as it will be spawned. */
  codexPath: string,

  /** What the executable is, when known; used only to refuse a real conflict. */
  executableClass?: ExecutableClass,

  /** Native's working root (`--cd`), absolute. */
  cwd: string,

  /** Extra writable roots (`--add-dir`), absolute. */
  addDirs?: readonly string[],

  /** Default: inherit. */
  home?: HomePolicy,

  /** Default: inherit. */
  config?: ConfigPolicy,

  /** `--strict-config`: unknown config fields are an error. Default false. */
  strictConfig?: boolean,

  /** Default: inherit. */
  permissions?: PermissionsPolicy,

  /** Default: a new thread. */
  session?: SessionPolicy,

  /** `--model`. */
  model?: string,

  /** `-c model_reasoning_effort="<effort>"`; native validates the value. */
  effort?: string,

  /** Further `-c` overrides, in order, after the planner's own. */
  overrides?: readonly ConfigOverride[],

  /** `--image`, absolute, without commas (native splits on them). */
  images?: readonly string[],

  /** `--output-schema`, absolute. */
  outputSchemaFile?: string,

  /** `--ephemeral`: no session files. */
  ephemeral?: boolean,

  /** `--skip-git-repo-check`: allow a working root outside a Git repository. */
  allowOutsideRepo?: boolean,

  /** Where native writes the final message (`--output-last-message`), absolute. */
  lastMessageFile: string,

  env?: EnvPolicy,

  /** The environment to inherit from: the caller passes `process.env` or its own. */
  baseEnv: Readonly<Record<string, string | undefined>>,

  /** The prompt; always delivered on stdin, never in argv. */
  prompt: string | Uint8Array,
}

/** An explicit choice a plan made, or a fact worth recording about what it inherits. */
export interface PlanNote {
  what: 'home' | 'config' | 'permissions' | 'session' | 'env',
  detail: string,
}

/** The exact invocation: spawn `[command, ...args]` with `env`, write `stdin`, close it. */
export interface InvocationPlan {
  command: string,
  args: string[],
  /** `args` as a record may keep them: override values not declared public are hashed. */
  recordArgs: string[],
  env: Record<string, string>,
  envFacts: EnvFacts,
  stdin: Uint8Array,
  promptSha256: string,
  notes: PlanNote[],
  refusals: Refusal[],
}

/** A plan as it may be written down: no environment values, no prompt, no non-public override values. */
export interface PlanRecord {
  schema: 'bare-codex.plan/v1',
  command: string,
  args: string[],
  envFacts: EnvFacts,
  promptSha256: string,
  promptBytes: number,
  notes: PlanNote[],
  refusals: Refusal[],
}

const sandboxModes: readonly SandboxMode[] = [ 'read-only', 'workspace-write', 'danger-full-access' ];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wordPattern = /^[A-Za-z0-9_.-]+$/;
const byteOrderMark = String.fromCharCode(0xfeff);

/** Keys the planner writes itself; a caller override of the same key would be ambiguous. */
const plannedKeys = { effort: 'model_reasoning_effort', profile: 'default_permissions' } as const;

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * A TOML basic string for `value`, for building `-c` overrides: quotes and
 * backslashes escaped, control characters as `\uXXXX`. Null for a string
 * that is not well-formed Unicode, which TOML cannot carry.
 */
export function tomlString(value: string): string | null {
  if (!value.isWellFormed()) {
    return null;
  }
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"' || code === 0x5c) {
      out += `${String.fromCharCode(0x5c)}${character}`;
    } else if (code < 0x20 || code === 0x7f) {
      out += `${String.fromCharCode(0x5c)}u${code.toString(16).padStart(4, '0')}`;
    } else {
      out += character;
    }
  }
  return `${out}"`;
}

function overrideProblem(override: ConfigOverride): string | null {
  const { key, value } = override;
  if (key === '' || key.includes('=') || key.startsWith('-') || hasControlCharacter(key)) {
    return `-c key ${JSON.stringify(key)} must be non-empty, without "=" or control characters, and must not start with "-"`;
  }
  if (value === '' || hasControlCharacter(value)) {
    return `-c ${key} needs a one-line TOML value without control characters`;
  }
  return null;
}

function permissionArgs(permissions: PermissionsPolicy): string[] {
  switch (permissions.kind) {
    case 'inherit':
    case 'profile':
      return [];
    case 'sandbox':
      return [ '--sandbox', permissions.mode ];
    case 'approve-for-me':
      return [ '--approve-for-me' ];
    case 'bypass':
      return [ '--dangerously-bypass-approvals-and-sandbox' ];
  }
}

function permissionNote(permissions: PermissionsPolicy): string {
  switch (permissions.kind) {
    case 'inherit':
      return 'no permission option is passed: the loaded configuration decides (default_permissions or sandbox_mode, and approvals; headless exec asks for approval policy "never" unless the configured reviewer is automatic, exec/src/lib.rs:586-592, 779-812)';
    case 'profile':
      return `default_permissions="${permissions.name}" selects that named profile for this run as a config override; the loaded configuration must define it`;
    case 'sandbox':
      return `legacy --sandbox ${permissions.mode} for this run (exec/src/lib.rs:343-347); whether it replaces an inherited default_permissions profile, and with it that profile's grants, is not established from the acquired 0.163.0 sources (open until the native probe records it)`;
    case 'approve-for-me':
      return '--approve-for-me adds approvals_reviewer="auto_review", approval_policy="on-request" and sandbox_mode="workspace-write" as config overrides for this run (utils/cli/src/shared_options.rs:80-93); whether that sandbox_mode replaces an inherited default_permissions profile, and with it that profile\'s grants, is open until the native probe records it';
    case 'bypass':
      return 'no native sandbox and no approvals for this run: only for a run sandboxed from outside (utils/cli/src/shared_options.rs:52-59); native also skips its Git repository check (exec/src/lib.rs:1011-1019)';
  }
}

function sessionArgs(session: SessionPolicy): string[] {
  switch (session.kind) {
    case 'new':
      return [];
    case 'resume':
      return [ 'resume', session.threadId ];
    case 'fork':
      return [ 'fork', session.threadId ];
  }
}

function sessionNote(session: SessionPolicy): string | null {
  switch (session.kind) {
    case 'new':
      return null;
    case 'resume':
      return `resume ${session.threadId}: native resumes the thread by id from the home it runs with, without checking the thread's recorded working directory (exec/src/lib.rs:1920-1925)`;
    case 'fork':
      return `fork ${session.threadId}: native finds the source thread in the home it runs with, across working directories, and continues in a new thread (exec/src/lib.rs:1066-1077)`;
  }
}

function homeNote(home: HomePolicy, codexHome: string | undefined): PlanNote {
  if (home.kind === 'path') {
    return { what: 'home', detail: `CODEX_HOME is the named home ${home.codexHome}; the login, config and sessions there are the caller's, and bare-codex reads none of them` };
  }
  return {
    what: 'home',
    detail: codexHome === undefined
      ? 'CODEX_HOME is not set for the child, so native uses its default home; bare-codex reads nothing there'
      : `CODEX_HOME is inherited (${codexHome}); the login, config and sessions there are the caller's, and bare-codex reads none of them`,
  };
}

function configNote(config: ConfigPolicy): PlanNote {
  return {
    what: 'config',
    detail: config.kind === 'inherit'
      ? 'native configuration layering is used unchanged'
      : 'isolated: --ignore-user-config --ignore-rules, so $CODEX_HOME/config.toml and user and project .rules files are not loaded; project config layers, managed and cloud layers and AGENTS.md discovery still apply, and auth still uses CODEX_HOME (exec/src/cli.rs:44-50)',
  };
}

/**
 * Plans one `codex exec` invocation. Option order follows the 0.163.0
 * parser: every exec option comes before a `resume` or `fork` subcommand
 * (`--sandbox`, `--cd`, `--add-dir` and `--image` are not global,
 * exec/src/cli.rs:163-170), images come first so the always-present `--json`
 * ends their multi-value list, and the prompt is always `-` on stdin
 * (exec/src/lib.rs:2371-2399). The result carries refusals instead of
 * throwing; a plan with refusals must not be run.
 */
export function planInvocation(options: PlanOptions): InvocationPlan {
  const refusals: Refusal[] = [];
  const notes: PlanNote[] = [];
  const refuse = (code: RefusalCode, message: string) => {
    refusals.push({ code, message });
  };
  const home: HomePolicy = options.home ?? { kind: 'inherit' };
  const config: ConfigPolicy = options.config ?? { kind: 'inherit' };
  const permissions: PermissionsPolicy = options.permissions ?? { kind: 'inherit' };
  const session: SessionPolicy = options.session ?? { kind: 'new' };

  const stdin = typeof options.prompt === 'string' ? new TextEncoder().encode(options.prompt) : options.prompt;
  const promptText = decodeUtf8(stdin);
  if (promptText === null) {
    refuse('prompt-not-utf8', 'the prompt is not valid UTF-8; bare-codex delivers UTF-8 on stdin, which codex exec 0.163.0 decodes as such (exec/src/lib.rs:2268-2296)');
  } else if ((promptText.startsWith(byteOrderMark) ? promptText.slice(1) : promptText).trim() === '') {
    refuse('prompt-empty', 'the prompt is empty; codex exec 0.163.0 exits 1 with "No prompt provided via stdin." (exec/src/lib.rs:2349-2356)');
  }

  const requireAbsolute = (label: string, path: string) => {
    if (!isAbsolute(path)) {
      refuse('path-not-absolute', `${label} must be an absolute path, got ${JSON.stringify(path)}`);
    }
  };
  requireAbsolute('cwd', options.cwd);
  requireAbsolute('lastMessageFile', options.lastMessageFile);
  for (const dir of options.addDirs ?? []) {
    requireAbsolute('an addDirs entry', dir);
  }
  for (const image of options.images ?? []) {
    requireAbsolute('an images entry', image);
    if (image.includes(',')) {
      refuse('option-invalid', `image path ${JSON.stringify(image)} contains a comma, which codex 0.163.0 splits into separate images (utils/cli/src/shared_options.rs:11-19)`);
    }
  }
  if (options.outputSchemaFile !== undefined) {
    requireAbsolute('outputSchemaFile', options.outputSchemaFile);
  }
  if (home.kind === 'path') {
    requireAbsolute('home.codexHome', home.codexHome);
  }

  if (session.kind !== 'new' && !uuidPattern.test(session.threadId)) {
    refuse('thread-id-invalid', `${session.kind} needs a thread id in UUID form, got ${JSON.stringify(session.threadId)}; names and --last are not used, because native resolves them by searching session history (exec/src/lib.rs:1852-1992)`);
  }
  const model = options.model;
  if (model !== undefined && (model === '' || model.startsWith('-') || hasControlCharacter(model))) {
    refuse('option-invalid', `model ${JSON.stringify(model)} must be non-empty, one line, and must not start with "-"`);
  }
  if (permissions.kind === 'sandbox' && !sandboxModes.includes(permissions.mode)) {
    refuse('option-invalid', `sandbox mode ${JSON.stringify(permissions.mode)} is not one of ${sandboxModes.join(', ')}`);
  }

  const overrideArgs: string[] = [];
  const recordedOverrideArgs: string[] = [];
  const pushOverride = (key: string, value: string, visible: boolean) => {
    overrideArgs.push('-c', `${key}=${value}`);
    recordedOverrideArgs.push('-c', visible ? `${key}=${value}` : `${key}=<sha256:${sha256Hex(value).slice(0, 16)}>`);
  };
  const planned = new Set<string>();
  if (options.effort !== undefined) {
    if (wordPattern.test(options.effort)) {
      planned.add(plannedKeys.effort);
      pushOverride(plannedKeys.effort, `"${options.effort}"`, true);
    } else {
      refuse('option-invalid', `effort ${JSON.stringify(options.effort)} must be a single word`);
    }
  }
  if (permissions.kind === 'profile') {
    if (wordPattern.test(permissions.name)) {
      planned.add(plannedKeys.profile);
      pushOverride(plannedKeys.profile, `"${permissions.name}"`, true);
    } else {
      refuse('option-invalid', `permission profile name ${JSON.stringify(permissions.name)} must be a single word`);
    }
  }
  for (const override of options.overrides ?? []) {
    const problem = overrideProblem(override);
    if (problem !== null) {
      refuse('override-invalid', problem);
      continue;
    }
    if (planned.has(override.key)) {
      refuse('override-conflict', `-c ${override.key} is already set by this plan's own options; set it in one place`);
      continue;
    }
    pushOverride(override.key, override.value, override.public === true);
  }

  const composed = composeEnv(options.baseEnv, options.env, home);
  refusals.push(...composed.refusals);
  if (home.kind === 'path' && options.executableClass === 'switch-launcher' && !isTruthyFlag(composed.env['CODEX_SWITCH_OFF'])) {
    refuse('launcher-replaces-home', 'the executable is an account-switching launcher, which replaces CODEX_HOME with its own view on every working route, so the named home would be ignored. Spawn native Codex directly, set CODEX_SWITCH_OFF=1 for this run, or let the launcher choose the home');
  }
  notes.push(homeNote(home, composed.env['CODEX_HOME']));
  notes.push(configNote(config));
  notes.push({ what: 'permissions', detail: permissionNote(permissions) });
  const sessionDetail = sessionNote(session);
  if (sessionDetail !== null) {
    notes.push({ what: 'session', detail: sessionDetail });
  }
  for (const detail of composed.notes) {
    notes.push({ what: 'env', detail });
  }

  const assembleArgs = (overrides: readonly string[]): string[] => [
    'exec',
    ...(options.images ?? []).flatMap(image => [ '--image', image ]),
    '--json',
    '--color', 'never',
    '--output-last-message', options.lastMessageFile,
    '--cd', options.cwd,
    ...(options.addDirs ?? []).flatMap(dir => [ '--add-dir', dir ]),
    ...overrides,
    ...(model === undefined ? [] : [ '--model', model ]),
    ...permissionArgs(permissions),
    ...(config.kind === 'isolated' ? [ '--ignore-user-config', '--ignore-rules' ] : []),
    ...(options.strictConfig === true ? [ '--strict-config' ] : []),
    ...(options.ephemeral === true ? [ '--ephemeral' ] : []),
    ...(options.allowOutsideRepo === true ? [ '--skip-git-repo-check' ] : []),
    ...(options.outputSchemaFile === undefined ? [] : [ '--output-schema', options.outputSchemaFile ]),
    ...sessionArgs(session),
    '-',
  ];

  return {
    command: options.codexPath,
    args: assembleArgs(overrideArgs),
    recordArgs: assembleArgs(recordedOverrideArgs),
    env: composed.env,
    envFacts: composed.facts,
    stdin,
    promptSha256: sha256Hex(stdin),
    notes,
    refusals,
  };
}

/** The plan as it may be written to disk: no environment values, no prompt, no non-public `-c` values. */
export function planRecord(plan: InvocationPlan): PlanRecord {
  return {
    schema: 'bare-codex.plan/v1',
    command: plan.command,
    args: [ ...plan.recordArgs ],
    envFacts: plan.envFacts,
    promptSha256: plan.promptSha256,
    promptBytes: plan.stdin.length,
    notes: plan.notes,
    refusals: plan.refusals,
  };
}
