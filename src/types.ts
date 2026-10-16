/**
 * Types shared by the pure layers (environment, planner, events, outcome)
 * and the effectful ones (runner, doctor). Nothing here touches a process,
 * a file or the clock.
 */

/**
 * Where native Codex finds its home: stored login, `config.toml`, sessions.
 * bare-codex never reads, copies or links anything inside a home.
 */
export type HomePolicy =
  /** Whatever `CODEX_HOME` the composed environment carries; native's default home when it carries none. */
  | { kind: 'inherit' }
  /** A home the caller names: `CODEX_HOME` is set to it for the run. */
  | { kind: 'path', codexHome: string };

/** Which configuration layers native Codex loads. */
export type ConfigPolicy =
  /** Native layering, unchanged: user config, project layers, rules, managed and cloud layers. */
  | { kind: 'inherit' }
  /**
   * `--ignore-user-config --ignore-rules`: `$CODEX_HOME/config.toml` and the
   * user and project `.rules` files are not loaded. Project config layers,
   * managed and cloud layers and AGENTS.md discovery still apply, and auth
   * still uses `CODEX_HOME` (codex-rs/exec/src/cli.rs:44-50 at 0.162.1).
   * This is not a hermetic run.
   */
  | { kind: 'isolated' };

/** The legacy `--sandbox` values (codex-rs/utils/cli/src/sandbox_mode_cli_arg.rs). */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * How a run's permissions are chosen. Only `inherit` leaves the loaded
 * configuration's choice alone; every other kind is an explicit override for
 * this run, recorded in the plan's notes.
 */
export type PermissionsPolicy =
  /** No permission option: the loaded configuration (`default_permissions`, `sandbox_mode`, approvals) decides. */
  | { kind: 'inherit' }
  /** `-c default_permissions="<name>"`: a named permission profile the loaded configuration defines. */
  | { kind: 'profile', name: string }
  /** Legacy `--sandbox <mode>`. */
  | { kind: 'sandbox', mode: SandboxMode }
  /** Native `--approve-for-me`: automatic review with the workspace-write sandbox. */
  | { kind: 'approve-for-me' }
  /** `--dangerously-bypass-approvals-and-sandbox`: only for a run that is sandboxed from outside. */
  | { kind: 'bypass' };

/** Which thread the turn runs in. Thread ids are UUIDs; `--last` and thread names are never used. */
export type SessionPolicy =
  | { kind: 'new' }
  | { kind: 'resume', threadId: string }
  | { kind: 'fork', threadId: string };

/**
 * What to do when the inherited environment carries a variable that changes
 * which credential native Codex uses, or where it sends one (see
 * `ROUTE_CHANGING_VARIABLES` in `env.ts`):
 * - `refuse` (the default): do not start, and say which variable;
 * - `unset`: leave it out of the child environment, and record that;
 * - `pass`: pass it on, and record that it was passed deliberately.
 * A value the caller sets through {@link EnvPolicy.set} is not ambient: it is
 * passed, and recorded by presence only.
 */
export type AmbientCredentialPolicy = 'refuse' | 'unset' | 'pass';

/** How the child environment is composed from the inherited one. */
export interface EnvPolicy {
  /** Start from the inherited environment. Default true. */
  inherit?: boolean,

  /** Variables set for the child, applied last. */
  set?: Readonly<Record<string, string>>,

  /** Variables left out of the child. */
  unset?: readonly string[],

  /** See {@link AmbientCredentialPolicy}. Default `refuse`. */
  ambientCredentials?: AmbientCredentialPolicy,
}

/** What an executable is, read from its first bytes (`executable.ts`). */
export type ExecutableClass = 'native-binary' | 'switch-launcher' | 'npm-wrapper' | 'script' | 'unknown';

/** Why a run was not started. */
export type RefusalCode =
  | 'prompt-empty'
  | 'prompt-not-utf8'
  | 'path-not-absolute'
  | 'thread-id-invalid'
  | 'option-invalid'
  | 'override-invalid'
  | 'override-conflict'
  | 'env-invalid'
  | 'ambient-credential'
  | 'launcher-replaces-home'
  | 'executable-not-found'
  | 'executable-not-runnable';

export interface Refusal {
  code: RefusalCode,
  message: string,
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Narrows a parsed JSON value to an object (not an array, not null). */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
