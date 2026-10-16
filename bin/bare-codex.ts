#!/usr/bin/env bun
/**
 * bare-codex: the worked CLI over the library. It runs one native `codex
 * exec` turn with caller-owned auth and inherited configuration, keeps
 * custody of everything in a new output directory, prints the final message
 * on stdout only when native reported the turn completed, and exits with a
 * status a runner cannot mistake (see USAGE).
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  asStopCause,
  BARE_CODEX_VERSION,
  childPathOf,
  doctor,
  exitStatusForCause,
  findOnPath,
  inspectExecutable,
  OutputExistsError,
  planInvocation,
  planRecord,
  runCodex,
  type AmbientCredentialPolicy,
  type CodexOutcome,
  type CodexSupervisorEvent,
  type ConfigOverride,
  type ConfigPolicy,
  type EnvPolicy,
  type HomePolicy,
  type PermissionsPolicy,
  type RunOptions,
  type SessionPolicy,
} from '../src/index.ts';

const USAGE = `bare-codex ${BARE_CODEX_VERSION}: run Codex headless with caller-owned auth

Usage:
  bare-codex run --out DIR [options] [--prompt-file FILE | -- PROMPT... | < stdin]
  bare-codex plan [options] [prompt as for run]
  bare-codex doctor [options] [--out DIR] [--json]

Executable and environment:
  --codex PATH               executable to run (default: codex on the child PATH);
                             a managed launcher that execs native Codex is fine
  --home DIR                 run with CODEX_HOME=DIR (default: inherit CODEX_HOME)
  --env-set K=V              set a variable for the child (repeatable); the value
                             is in this command's argv, so for a secret export it
                             and use --ambient-credentials pass instead
  --env-unset K              leave a variable out (repeatable)
  --no-inherit-env           start the child environment empty
  --ambient-credentials P    refuse (default) | unset | pass: inherited
                             CODEX_API_KEY, CODEX_ACCESS_TOKEN and auth URL overrides

Run shape:
  --cwd DIR                  native working root (default: here)
  --add-dir DIR              extra writable root (repeatable)
  --config inherit|isolated  isolated adds --ignore-user-config --ignore-rules
  --strict-config            unknown config fields are an error
  --permissions P            inherit (default) | profile:NAME |
                             sandbox:read-only|workspace-write|danger-full-access |
                             approve-for-me | bypass
  --resume UUID | --fork UUID
  -m, --model M   --effort E
  -c, --override KEY=TOML    raw config override (repeatable); records keep only
                             the key and a hash of the value
  --public-override KEY=TOML the same, declared non-secret: records keep the value
  --image FILE (repeatable)  --output-schema FILE   --ephemeral
  --allow-outside-repo       pass --skip-git-repo-check

Custody and output:
  --out DIR                  new directory for run.json, prompt.txt, events.jsonl,
                             stderr.log, last-message.txt, outcome.json
  --stop-grace-ms N          SIGKILL this long after SIGINT (default 10000)
  --json-outcome             print outcome.json on stdout instead of the final message
  --json                     doctor: print the report as JSON
  --quiet                    fewer stderr lines

Exit status:
  0 native turn completed (not a judgement of the task)   1 native failed
  3 a launcher refused to start native   64 usage   69 spawn failed
  70 outcome unknown   73 output directory exists   78 refused before start
  128+n stopped by signal n (SIGINT goes to native first)
`;

const EXIT = {
  completed: 0,
  failed: 1,
  launcherRefused: 3,
  usage: 64,
  spawnFailed: 69,
  unknown: 70,
  outputExists: 73,
  refused: 78,
} as const;

class UsageError extends Error {}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    tokens: true,
    allowPositionals: true,
    strict: true,
    options: {
      codex: { type: 'string' },
      cwd: { type: 'string' },
      'add-dir': { type: 'string', multiple: true },
      home: { type: 'string' },
      config: { type: 'string' },
      'strict-config': { type: 'boolean' },
      permissions: { type: 'string' },
      resume: { type: 'string' },
      fork: { type: 'string' },
      model: { type: 'string', short: 'm' },
      effort: { type: 'string' },
      override: { type: 'string', short: 'c', multiple: true },
      'public-override': { type: 'string', multiple: true },
      image: { type: 'string', multiple: true },
      'output-schema': { type: 'string' },
      ephemeral: { type: 'boolean' },
      'allow-outside-repo': { type: 'boolean' },
      'env-set': { type: 'string', multiple: true },
      'env-unset': { type: 'string', multiple: true },
      'no-inherit-env': { type: 'boolean' },
      'ambient-credentials': { type: 'string' },
      out: { type: 'string' },
      'prompt-file': { type: 'string' },
      'stop-grace-ms': { type: 'string' },
      'json-outcome': { type: 'boolean' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
}

type Values = ReturnType<typeof parse>['values'];

type Common = Pick<RunOptions,
  'codexPath' | 'cwd' | 'addDirs' | 'home' | 'config' | 'strictConfig' | 'permissions' | 'session' | 'model' | 'effort'
  | 'overrides' | 'images' | 'outputSchemaFile' | 'ephemeral' | 'allowOutsideRepo' | 'env'>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise(done => {
    if (text === '') {
      done();
      return;
    }
    stream.write(text, () => done());
  });
}

function splitPair(text: string, flag: string): [ string, string ] {
  const at = text.indexOf('=');
  if (at <= 0) {
    throw new UsageError(`${flag} ${text}: expected KEY=VALUE`);
  }
  return [ text.slice(0, at), text.slice(at + 1) ];
}

function permissionsOf(value: string | undefined): PermissionsPolicy {
  if (value === undefined || value === 'inherit') {
    return { kind: 'inherit' };
  }
  if (value === 'approve-for-me') {
    return { kind: 'approve-for-me' };
  }
  if (value === 'bypass') {
    return { kind: 'bypass' };
  }
  if (value.startsWith('profile:') && value.length > 'profile:'.length) {
    return { kind: 'profile', name: value.slice('profile:'.length) };
  }
  const mode = value.startsWith('sandbox:') ? value.slice('sandbox:'.length) : null;
  if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') {
    return { kind: 'sandbox', mode };
  }
  throw new UsageError(`--permissions ${value}: use inherit, profile:NAME, sandbox:read-only|workspace-write|danger-full-access, approve-for-me or bypass`);
}

function configOf(value: string | undefined): ConfigPolicy {
  if (value === undefined || value === 'inherit') {
    return { kind: 'inherit' };
  }
  if (value === 'isolated') {
    return { kind: 'isolated' };
  }
  throw new UsageError(`--config ${value}: use inherit or isolated`);
}

function ambientOf(value: string | undefined): AmbientCredentialPolicy | undefined {
  if (value === undefined || value === 'refuse' || value === 'unset' || value === 'pass') {
    return value;
  }
  throw new UsageError(`--ambient-credentials ${value}: use refuse, unset or pass`);
}

function graceOf(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const grace = Number(value);
  if (!Number.isInteger(grace) || grace < 0) {
    throw new UsageError(`--stop-grace-ms ${value}: expected a whole number of milliseconds`);
  }
  return grace;
}

function commonOptions(values: Values, tokens: ReturnType<typeof parse>['tokens']): Common {
  if (values.resume !== undefined && values.fork !== undefined) {
    throw new UsageError('--resume and --fork are alternatives');
  }
  const session: SessionPolicy = values.resume !== undefined
    ? { kind: 'resume', threadId: values.resume }
    : values.fork !== undefined ? { kind: 'fork', threadId: values.fork } : { kind: 'new' };
  const home: HomePolicy = values.home === undefined ? { kind: 'inherit' } : { kind: 'path', codexHome: resolve(values.home) };
  const set: Record<string, string> = {};
  for (const pair of values['env-set'] ?? []) {
    const [ key, value ] = splitPair(pair, '--env-set');
    set[key] = value;
  }
  const env: EnvPolicy = {
    inherit: values['no-inherit-env'] !== true,
    set,
    unset: values['env-unset'] ?? [],
    ambientCredentials: ambientOf(values['ambient-credentials']),
  };
  const overrides: ConfigOverride[] = [];
  for (const token of tokens) {
    if (token.kind !== 'option' || (token.name !== 'override' && token.name !== 'public-override')) continue;
    const [key, value] = splitPair(token.value!, `--${token.name}`);
    overrides.push(token.name === 'public-override' ? {key, value, public: true} : {key, value});
  }
  const codex = values.codex;
  return {
    codexPath: codex !== undefined && codex.includes('/') ? resolve(codex) : codex,
    cwd: resolve(values.cwd ?? process.cwd()),
    addDirs: (values['add-dir'] ?? []).map(dir => resolve(dir)),
    home,
    config: configOf(values.config),
    strictConfig: values['strict-config'] === true,
    permissions: permissionsOf(values.permissions),
    session,
    model: values.model,
    effort: values.effort,
    overrides,
    images: (values.image ?? []).map(image => resolve(image)),
    outputSchemaFile: values['output-schema'] === undefined ? undefined : resolve(values['output-schema']),
    ephemeral: values.ephemeral === true,
    allowOutsideRepo: values['allow-outside-repo'] === true,
    env,
  };
}

async function readPrompt(values: Values, words: string[], placeholder: boolean): Promise<Uint8Array> {
  const file = values['prompt-file'];
  if (file !== undefined) {
    if (words.length > 0) {
      throw new UsageError('give the prompt once: --prompt-file or words after the command, not both');
    }
    return new Uint8Array(readFileSync(resolve(file)));
  }
  if (words.length > 0) {
    return new TextEncoder().encode(words.join(' '));
  }
  if (process.stdin.isTTY === true) {
    if (placeholder) {
      return new TextEncoder().encode('bare-codex plan: placeholder prompt');
    }
    throw new UsageError('no prompt: pass --prompt-file FILE, words after "--", or pipe it on stdin');
  }
  return new Uint8Array(await Bun.stdin.arrayBuffer());
}

function describeSupervisorEvent(event: CodexSupervisorEvent): string {
  switch (event.kind) {
    case 'held':
      return `received ${event.cause} while starting codex; it is interrupted with SIGINT as soon as it exists`;
    case 'stopping': {
      const target = event.processGroup === null ? 'it' : `process group ${event.processGroup}`;
      return event.cause === 'finish'
        ? `codex is still running; sent SIGTERM (pid ${event.pid}), SIGKILL to ${target} after ${event.graceMs} ms`
        : `received ${event.cause}; sent SIGINT to codex (pid ${event.pid}) for a native turn interruption, SIGKILL to ${target} after ${event.graceMs} ms`;
    }
    case 'escalating':
      return `received ${event.cause} again; sending SIGKILL now`;
    case 'after-exit':
      return `received ${event.cause} after codex had exited; nothing to stop`;
  }
}

function exitStatus(outcome: CodexOutcome): number {
  switch (outcome.status) {
    case 'completed':
      return EXIT.completed;
    case 'failed':
      return EXIT.failed;
    case 'stopped': {
      const cause = outcome.stop === null ? null : asStopCause(outcome.stop.cause);
      return (cause === null ? null : exitStatusForCause(cause)) ?? EXIT.failed;
    }
    case 'refused':
      return outcome.reason === 'launcher-refused' ? EXIT.launcherRefused : EXIT.refused;
    case 'spawn-failed':
      return EXIT.spawnFailed;
    case 'unknown':
      return EXIT.unknown;
  }
}

async function runCommand(values: Values, words: string[], common: Common): Promise<number> {
  const out = values.out;
  if (out === undefined) {
    throw new UsageError('run needs --out DIR, a directory that does not exist yet');
  }
  const prompt = await readPrompt(values, words, false);
  const quiet = values.quiet === true;
  const info = (line: string) => {
    if (!quiet) {
      process.stderr.write(`bare-codex: ${line}\n`);
    }
  };
  let result;
  try {
    result = await runCodex({
      ...common,
      prompt,
      outDir: out,
      signals: 'process',
      stopGraceMs: graceOf(values['stop-grace-ms']),
      onSpawn: ({ pid, processGroup, outDir }) => {
        process.stderr.write(`bare-codex: codex ${processGroup === null ? `process ${pid}` : `process group ${processGroup}`}; custody in ${outDir}\n`);
      },
      onSupervisor: event => process.stderr.write(`bare-codex: ${describeSupervisorEvent(event)}\n`),
    });
  } catch (error) {
    if (error instanceof OutputExistsError) {
      process.stderr.write(`bare-codex: ${error.message}\n`);
      return EXIT.outputExists;
    }
    throw error;
  }
  const { outcome } = result;
  for (const diagnostic of outcome.diagnostics) {
    info(`${diagnostic.code}: ${diagnostic.detail}`);
  }
  process.stderr.write(`bare-codex: outcome ${outcome.status} (${outcome.reason}): ${outcome.detail}\n`);
  if (values['json-outcome'] === true) {
    await write(process.stdout, `${JSON.stringify(outcome, null, 2)}\n`);
  } else if (outcome.status === 'completed' && outcome.finalMessage.text !== null) {
    await write(process.stdout, outcome.finalMessage.text);
  }
  return exitStatus(outcome);
}

async function planCommand(values: Values, words: string[], common: Common): Promise<number> {
  const cwd = common.cwd ?? process.cwd();
  const baseEnv = process.env;
  const requested = common.codexPath ?? 'codex';
  const located = findOnPath(requested, childPathOf(common, baseEnv), cwd);
  const executable = located === null ? null : await inspectExecutable(located, { hash: false });
  const prompt = await readPrompt(values, words, true);
  const outDir = resolve(values.out ?? join(cwd, 'bare-codex-out'));
  const plan = planInvocation({
    ...common,
    codexPath: located ?? requested,
    executableClass: executable?.class,
    cwd,
    lastMessageFile: join(outDir, 'last-message.txt'),
    baseEnv,
    prompt,
  });
  await write(process.stdout, `${JSON.stringify({ executable, plan: planRecord(plan) }, null, 2)}\n`);
  return plan.refusals.length === 0 && located !== null ? EXIT.completed : EXIT.refused;
}

async function doctorCommand(values: Values, words: string[], common: Common): Promise<number> {
  if (words.length > 0) {
    throw new UsageError('doctor takes no prompt');
  }
  const report = await doctor({ ...common, outDir: values.out });
  if (values.json === true) {
    await write(process.stdout, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    await write(process.stdout, report.checks.map(check => `${check.level.padEnd(4)} ${check.id}: ${check.message}\n`).join(''));
  }
  return report.ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  const { values, positionals } = parsed;
  if (values.version === true) {
    await write(process.stdout, `${BARE_CODEX_VERSION}\n`);
    return 0;
  }
  const [ command, ...words ] = positionals;
  if (values.help === true || command === 'help') {
    await write(process.stdout, USAGE);
    return 0;
  }
  if (command === undefined) {
    await write(process.stderr, USAGE);
    return EXIT.usage;
  }
  const common = commonOptions(values, parsed.tokens);
  switch (command) {
    case 'run':
      return runCommand(values, words, common);
    case 'plan':
      return planCommand(values, words, common);
    case 'doctor':
      return doctorCommand(values, words, common);
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}

let code: number;
try {
  code = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`bare-codex: ${error.message}\nRun "bare-codex --help" for usage.\n`);
    code = EXIT.usage;
  } else {
    process.stderr.write(`bare-codex: ${errorMessage(error)}\n`);
    code = EXIT.unknown;
  }
}
process.exit(code);
