#!/usr/bin/env bun
/**
 * A stand-in for native `codex` in tests; it contacts nothing. FAKE_CODEX_MODE
 * picks its behaviour. It records what it received (argv, cwd, environment
 * variable names, a few non-secret values, stdin) as JSON in FAKE_CODEX_LOG,
 * every byte its exec invocation writes to stdout in FAKE_CODEX_LOG.stdout, each signal it
 * handles as a line in FAKE_CODEX_LOG.signals, and the pid of any grandchild
 * in FAKE_CODEX_LOG.grandchild.
 */

import { appendFileSync, writeFileSync, writeSync } from 'node:fs';

const LF = String.fromCharCode(10);
const args = process.argv.slice(2);
const mode = process.env['FAKE_CODEX_MODE'] ?? 'ok';
const logPath = process.env['FAKE_CODEX_LOG'];
const NEW_THREAD = '0199a000-0000-7000-8000-000000000001';
const FORKED_THREAD = '0199a000-0000-7000-8000-0000000000f0';
const OTHER_THREAD = '0199a000-0000-7000-8000-0000000000aa';
const REUSED = 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
const HELP_FLAGS = [
  '--json', '--color', '--output-last-message', '--cd', '--add-dir', '--config', '--model', '--sandbox', '--approve-for-me',
  '--dangerously-bypass-approvals-and-sandbox', '--ignore-user-config', '--ignore-rules', '--strict-config', '--ephemeral',
  '--skip-git-repo-check', '--output-schema', '--image',
];

function out(text: string): void {
  writeSync(1, text);
  if (logPath !== undefined) {
    appendFileSync(`${logPath}.stdout`, text);
  }
}

function err(text: string): void {
  writeSync(2, text);
}

function emit(event: Record<string, unknown>): void {
  out(`${JSON.stringify(event)}${LF}`);
}

function valueOf(flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

function noteSignal(name: string): void {
  if (logPath !== undefined) {
    appendFileSync(`${logPath}.signals`, `${name}${LF}`);
  }
}

if (args[0] === '--version') {
  writeSync(1, `codex-cli 0.162.1${LF}`);
  process.exit(0);
}
if (args.includes('--help')) {
  const shown = mode === 'help-missing' ? HELP_FLAGS.filter(flag => flag !== '--approve-for-me') : HELP_FLAGS;
  writeSync(1, `Usage: codex exec [OPTIONS] [PROMPT]${LF}${shown.map(flag => `  ${flag}`).join(LF)}${LF}`);
  process.exit(0);
}
if (mode === 'early-exit') {
  err(`fake: exiting before reading stdin${LF}`);
  process.exit(2);
}

const stdin = await new Response(Bun.stdin.stream()).text();
const resumeAt = args.indexOf('resume');
const resumed = resumeAt === -1 ? undefined : args[resumeAt + 1];
const thread = args.includes('fork') ? FORKED_THREAD : resumed ?? NEW_THREAD;
const lastMessage = valueOf('--output-last-message');

if (logPath !== undefined) {
  writeFileSync(logPath, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    envNames: Object.keys(process.env).sort(),
    values: {
      CODEX_HOME: process.env['CODEX_HOME'] ?? null,
      CODEX_SWITCH_ACCOUNT: process.env['CODEX_SWITCH_ACCOUNT'] ?? null,
      CODEX_SWITCH_OFF: process.env['CODEX_SWITCH_OFF'] ?? null,
    },
    present: {
      CODEX_API_KEY: process.env['CODEX_API_KEY'] !== undefined,
      BARE_CODEX_TEST_SECRET: process.env['BARE_CODEX_TEST_SECRET'] !== undefined,
    },
    stdin,
  }));
}

const usage = { input_tokens: 3, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };

function agent(text: string): void {
  emit({ type: 'item.completed', item: { id: 'item_9', type: 'agent_message', text } });
}

function finish(text: string, code = 0): never {
  if (lastMessage !== undefined) {
    writeFileSync(lastMessage, text);
  }
  process.exit(code);
}

function startCommand(): void {
  emit({ type: 'thread.started', thread_id: thread });
  emit({ type: 'turn.started' });
  emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep 600', aggregated_output: '', exit_code: null, status: 'in_progress' } });
}

switch (mode) {
  case 'ok':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    finish('fake final');
    break;
  case 'turn-failed':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    emit({ type: 'error', message: 'stream disconnected before completion' });
    emit({ type: 'turn.failed', error: { message: 'boom: upstream failed' } });
    process.exit(1);
    break;
  case 'auth-reused':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    emit({ type: 'turn.failed', error: { message: REUSED } });
    process.exit(1);
    break;
  case 'agent-mentions-auth':
    emit({ type: 'thread.started', thread_id: thread });
    agent(REUSED);
    emit({ type: 'turn.completed', usage });
    finish(REUSED);
    break;
  case 'recovered':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'turn.started' });
    emit({ type: 'error', message: 'Reconnecting... 1/5' });
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    finish('fake final');
    break;
  case 'error-after-completed':
    emit({ type: 'thread.started', thread_id: thread });
    agent('partial');
    emit({ type: 'error', message: 'fatal after completion' });
    emit({ type: 'turn.completed', usage });
    finish('partial', 1);
    break;
  case 'exit0-no-terminal':
    emit({ type: 'thread.started', thread_id: thread });
    process.exit(0);
    break;
  case 'malformed':
    emit({ type: 'thread.started', thread_id: thread });
    out(`not json${LF}`);
    emit({ type: 'mystery.event' });
    emit({ type: 'item.completed', item: { id: 'x', type: 'hologram' } });
    out(`{"type":7}${LF}`);
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    out('{"type":"turn.started"');
    finish('fake final');
    break;
  case 'mismatch':
    emit({ type: 'thread.started', thread_id: thread });
    agent('streamed text');
    emit({ type: 'turn.completed', usage });
    finish('backfilled text');
    break;
  case 'warning':
    emit({ type: 'thread.started', thread_id: thread });
    emit({ type: 'item.completed', item: { id: 'w', type: 'error', message: 'config warning' } });
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    finish('fake final');
    break;
  case 'resume-other-thread':
    emit({ type: 'thread.started', thread_id: OTHER_THREAD });
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    finish('fake final');
    break;
  case 'launcher-refuse':
    err(`codex: no account is selected for this non-interactive run; nothing was run${LF}`);
    process.exit(3);
    break;
  case 'launcher-refuse-1':
    err(`codex: the selected account is not registered; nothing was run${LF}`);
    process.exit(1);
    break;
  case 'leave-child': {
    const sleeper = Bun.spawn([ 'sleep', '600' ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    sleeper.unref();
    if (logPath !== undefined) {
      writeFileSync(`${logPath}.grandchild`, String(sleeper.pid));
    }
    emit({ type: 'thread.started', thread_id: thread });
    agent('fake final');
    emit({ type: 'turn.completed', usage });
    finish('fake final');
    break;
  }
  case 'config-error':
    err(`Error loading config.toml:${LF}unknown field${LF}`);
    process.exit(1);
    break;
  case 'hang': {
    process.on('SIGINT', () => {
      noteSignal('SIGINT');
      setTimeout(() => process.exit(1), 20);
    });
    const sleeper = Bun.spawn([ 'sleep', '600' ], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    sleeper.unref();
    if (logPath !== undefined) {
      writeFileSync(`${logPath}.grandchild`, String(sleeper.pid));
    }
    startCommand();
    setInterval(() => undefined, 1_000);
    break;
  }
  case 'ignore-signals':
    process.on('SIGINT', () => noteSignal('SIGINT'));
    process.on('SIGTERM', () => noteSignal('SIGTERM'));
    startCommand();
    setInterval(() => undefined, 1_000);
    break;
  default:
    err(`fake: unknown FAKE_CODEX_MODE ${mode}${LF}`);
    process.exit(99);
}
