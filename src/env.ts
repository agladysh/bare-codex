/**
 * The child environment: composed from the inherited one and described
 * without revealing it. Pure: the inherited environment is an argument.
 *
 * Auth belongs to the caller and its managed launcher. By default the whole
 * inherited environment is passed on, so a launcher's variables and an
 * inherited `CODEX_HOME` reach native Codex unchanged. What is not passed on
 * silently is an inherited variable that would move native onto another
 * credential route; see `AmbientCredentialPolicy`.
 */

import type { EnvPolicy, HomePolicy, Refusal } from './types.ts';

/**
 * Variables that change which credential native Codex 0.162.1 uses, or where
 * it sends one (openai/codex 092d3acd, codex-rs/login/src/auth/manager.rs):
 * - `CODEX_API_KEY` is used ahead of any stored login when the caller enables
 *   it, which `codex exec` does: usage-billed API-key auth (manager.rs:1500-1506,
 *   exec/src/lib.rs:745);
 * - `CODEX_ACCESS_TOKEN` is used ahead of the stored login, as an access token
 *   or personal access token (manager.rs:1537-1545);
 * - `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and `CODEX_REVOKE_TOKEN_URL_OVERRIDE`
 *   say where refresh tokens and revoke requests are sent (manager.rs:212-215,
 *   1727-1730);
 * - `CODEX_APP_SERVER_LOGIN_CLIENT_ID` says which OAuth client a refresh
 *   claims to be (manager.rs:216, 1720-1725).
 */
export const ROUTE_CHANGING_VARIABLES = [
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_REFRESH_TOKEN_URL_OVERRIDE',
  'CODEX_REVOKE_TOKEN_URL_OVERRIDE',
  'CODEX_APP_SERVER_LOGIN_CLIENT_ID',
] as const;

export type RouteChangingVariable = typeof ROUTE_CHANGING_VARIABLES[number];

/**
 * Variables whose presence a record states. `OPENAI_API_KEY` is listed for
 * presence only: the extracted 0.162.1 sources show no `codex exec` route that
 * reads it for model auth, but a configured provider can name it as its
 * `env_key`.
 */
export const REPORTED_VARIABLES = [
  ...ROUTE_CHANGING_VARIABLES,
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CODEX_SWITCH_ACCOUNT',
  'CODEX_SWITCH_OFF',
  'RUST_LOG',
  'HOME',
  'PATH',
] as const;

/** The only variables whose values a record keeps: paths, an account label and an on/off switch. */
export const VALUE_RECORDED_VARIABLES: readonly string[] = [ 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_SWITCH_ACCOUNT', 'CODEX_SWITCH_OFF' ];

/** How a reported variable came to be in the child environment, or not. */
export type VariableOrigin =
  /** Passed on from the inherited environment. */
  | 'inherited'
  /** Set for this run by the caller, directly or by naming a home. */
  | 'set'
  /** Left out by the caller's `unset`. */
  | 'unset'
  /** A route-changing variable passed on because the caller chose `pass`. */
  | 'ambient-passed'
  /** A route-changing variable left out because the caller chose `unset`. */
  | 'ambient-unset'
  /** Neither inherited nor set. */
  | 'absent';

export interface VariableFact {
  name: string,
  present: boolean,
  origin: VariableOrigin,
  /** Only for {@link VALUE_RECORDED_VARIABLES}. */
  value?: string,
}

/** What a record may say about the child environment. */
export interface EnvFacts {
  inherited: boolean,
  /** How many variables the child gets; their names and values are not recorded. */
  count: number,
  variables: VariableFact[],
}

export interface ComposedEnv {
  env: Record<string, string>,
  facts: EnvFacts,
  refusals: Refusal[],
  notes: string[],
}

const nul = String.fromCharCode(0);

const ambientReasons: Record<RouteChangingVariable, string> = {
  CODEX_API_KEY: 'codex exec 0.162.1 uses it ahead of any stored login, as usage-billed API-key auth',
  CODEX_ACCESS_TOKEN: 'codex 0.162.1 uses it ahead of the stored login, as an access token',
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'codex 0.162.1 sends refresh tokens to the URL it names',
  CODEX_REVOKE_TOKEN_URL_OVERRIDE: 'codex 0.162.1 sends revoke requests to the URL it names',
  CODEX_APP_SERVER_LOGIN_CLIENT_ID: 'codex 0.162.1 claims to be that OAuth client when it refreshes',
};

function isRouteChanging(name: string): name is RouteChangingVariable {
  return ROUTE_CHANGING_VARIABLES.some(variable => variable === name);
}

/** The reading a launcher gives an on/off variable such as `CODEX_SWITCH_OFF`. */
export function isTruthyFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  return ![ '', '0', 'false', 'no', 'off' ].includes(value.trim().toLowerCase());
}

/** The facts a record may keep about `env`, given how each variable got there. */
export function describeEnv(env: Readonly<Record<string, string>>, origins: ReadonlyMap<string, VariableOrigin>, inherited: boolean): EnvFacts {
  return {
    inherited,
    count: Object.keys(env).length,
    variables: REPORTED_VARIABLES.map(name => {
      const present = Object.hasOwn(env, name);
      const fact: VariableFact = { name, present, origin: origins.get(name) ?? 'absent' };
      if (present && VALUE_RECORDED_VARIABLES.includes(name)) {
        fact.value = env[name];
      }
      return fact;
    }),
  };
}

/**
 * Composes the child environment:
 * 1. the inherited environment, unless `policy.inherit` is false;
 * 2. route-changing variables found there, handled by
 *    `policy.ambientCredentials` (default: refuse);
 * 3. `policy.unset` removed;
 * 4. `policy.set` applied;
 * 5. a named home sets `CODEX_HOME`.
 * Nothing else is added, removed or rewritten.
 */
export function composeEnv(
  base: Readonly<Record<string, string | undefined>>,
  policy: EnvPolicy = {},
  home: HomePolicy = { kind: 'inherit' },
): ComposedEnv {
  const inherit = policy.inherit ?? true;
  const ambient = policy.ambientCredentials ?? 'refuse';
  const set = policy.set ?? {};
  const unset = new Set(policy.unset ?? []);
  const env: Record<string, string> = {};
  const origins = new Map<string, VariableOrigin>();
  const refusals: Refusal[] = [];
  const notes: string[] = [];

  for (const [ name, value ] of Object.entries(set)) {
    if (name === '' || name.includes('=') || name.includes(nul) || value.includes(nul)) {
      refusals.push({
        code: 'env-invalid',
        message: `cannot set ${JSON.stringify(name)}: a variable name must be non-empty, without "=" or NUL, and a value without NUL`,
      });
    }
  }

  if (inherit) {
    for (const [ name, value ] of Object.entries(base)) {
      if (value !== undefined) {
        env[name] = value;
        origins.set(name, 'inherited');
      }
    }
    for (const name of ROUTE_CHANGING_VARIABLES) {
      const value = base[name];
      if (value === undefined || value.trim() === '' || Object.hasOwn(set, name) || unset.has(name)) {
        continue;
      }
      switch (ambient) {
        case 'refuse':
          refusals.push({
            code: 'ambient-credential',
            message: `${name} is set in the inherited environment, and ${ambientReasons[name]}. bare-codex does not pass it on silently: set it deliberately for this run, unset it, or choose ambient credentials "unset" or "pass"`,
          });
          break;
        case 'unset':
          delete env[name];
          origins.set(name, 'ambient-unset');
          notes.push(`${name} from the inherited environment is not passed on (ambient credentials: unset)`);
          break;
        case 'pass':
          origins.set(name, 'ambient-passed');
          notes.push(`${name} from the inherited environment is passed on deliberately (ambient credentials: pass); ${ambientReasons[name]}`);
          break;
      }
    }
  }

  for (const name of unset) {
    delete env[name];
    origins.set(name, 'unset');
  }

  for (const [ name, value ] of Object.entries(set)) {
    env[name] = value;
    origins.set(name, 'set');
    if (isRouteChanging(name)) {
      notes.push(`${name} is set for this run by the caller; ${ambientReasons[name]}`);
    }
  }

  if (home.kind === 'path') {
    const named = set['CODEX_HOME'];
    if (named !== undefined && named !== home.codexHome) {
      refusals.push({ code: 'option-invalid', message: 'a named home and env.set.CODEX_HOME disagree; name the home once' });
    }
    const inheritedHome = origins.get('CODEX_HOME') === 'inherited' ? env['CODEX_HOME'] : undefined;
    if (inheritedHome !== undefined && inheritedHome !== home.codexHome) {
      notes.push(`the inherited CODEX_HOME (${inheritedHome}) is replaced by the named home for this run`);
    }
    env['CODEX_HOME'] = home.codexHome;
    origins.set('CODEX_HOME', 'set');
    const sqliteHome = env['CODEX_SQLITE_HOME'];
    if (sqliteHome !== undefined) {
      notes.push(`CODEX_SQLITE_HOME (${sqliteHome}) is passed on unchanged, so native may keep its databases there rather than in the named home`);
    }
  }

  return { env, facts: describeEnv(env, origins, inherit), refusals, notes };
}
