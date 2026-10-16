/**
 * bare-codex: run Codex (`codex exec`) headless with caller-owned auth and
 * inherited configuration.
 *
 * Library first. The pure layers can be used alone by a consumer that keeps
 * its own supervisor and ledger: `planInvocation` (argv, environment,
 * stdin), `reduceLine`/`reduceParsed` (the event stream) and `conclude` (the
 * outcome). `runCodex` composes them with supervision and custody, `doctor`
 * checks an invocation without a model call, and `bin/bare-codex.ts` is the
 * worked CLI over all of it.
 */

export * from './types.ts';
export * from './env.ts';
export * from './plan.ts';
export * from './events.ts';
export * from './outcome.ts';
export * from './executable.ts';
export * from './lifecycle.ts';
export * from './run.ts';
export * from './doctor.ts';
export { BARE_CODEX_VERSION } from './version.ts';
