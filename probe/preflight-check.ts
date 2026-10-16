/**
 * One isolation check, run by the native probe three times with the same
 * environment: unsandboxed before, inside the outer sandbox, unsandboxed
 * after. It prints one JSON line. It contacts nothing beyond loopback when
 * unsandboxed (TEST-NET-1 is tried only inside the sandbox), and it never
 * reads a real home: the read check uses the synthetic decoy file.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

interface Attempt {
  result: string,
  ms: number,
}

function codeOf(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : String(error);
}

function attempt(host: string, port: number): Promise<Attempt> {
  return new Promise(done => {
    const started = Date.now();
    const finish = (result: string) => done({ result, ms: Date.now() - started });
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      finish('timeout');
    }, 3_000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      finish('connected');
    });
    socket.once('error', error => {
      clearTimeout(timer);
      finish(codeOf(error));
    });
  });
}

const env = process.env;
const mode = env['PROBE_MODE'] ?? 'unknown';
const port = Number(env['PROBE_PORT']);
const decoyPort = Number(env['PROBE_DECOY_PORT']);
const writeTarget = env['PROBE_WRITE_TARGET'] ?? '';
const decoyFile = env['PROBE_DECOY_FILE'] ?? '';
const report: Record<string, unknown> = { mode };

try {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  report['provider'] = (await response.text()) === 'ok';
} catch (error) {
  report['provider'] = false;
  report['providerError'] = String(error);
}
report['providerTcp'] = await attempt('127.0.0.1', port);
report['decoyTcp'] = await attempt('127.0.0.1', decoyPort);
if (mode === 'sandboxed') {
  report['egress'] = await attempt('192.0.2.1', 80);
}
try {
  writeFileSync(writeTarget, 'probe write check');
  rmSync(writeTarget, { force: true });
  report['write'] = 'allowed';
} catch (error) {
  report['write'] = codeOf(error);
}
try {
  readFileSync(decoyFile);
  report['decoyRead'] = 'allowed';
} catch (error) {
  report['decoyRead'] = codeOf(error);
}
process.stdout.write(`${JSON.stringify(report)}${String.fromCharCode(10)}`);
