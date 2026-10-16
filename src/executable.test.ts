import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyExecutableHead, findOnPath, inspectExecutable, parseVersion } from './executable.ts';

const LF = String.fromCharCode(10);
const encode = (text: string) => new TextEncoder().encode(text);

describe('classifyExecutableHead', () => {
  test('reads native binaries by magic number', () => {
    expect(classifyExecutableHead(new Uint8Array([ 0xcf, 0xfa, 0xed, 0xfe, 0 ])).class).toBe('native-binary');
    expect(classifyExecutableHead(new Uint8Array([ 0xca, 0xfe, 0xba, 0xbe, 0 ])).class).toBe('native-binary');
    expect(classifyExecutableHead(new Uint8Array([ 0x7f, 0x45, 0x4c, 0x46, 2 ])).class).toBe('native-binary');
  });

  test('tells a switching launcher, an npm wrapper and a plain script apart', () => {
    expect(classifyExecutableHead(encode(`#!/usr/bin/python3${LF}off = os.environ.get("CODEX_SWITCH_OFF")${LF}`))).toEqual({ class: 'switch-launcher', shebang: '/usr/bin/python3' });
    expect(classifyExecutableHead(encode(`#!/usr/bin/env node${LF}import '../dist/codex.js';${LF}`)).class).toBe('npm-wrapper');
    expect(classifyExecutableHead(encode(`#!/bin/sh${LF}exec something${LF}`))).toEqual({ class: 'script', shebang: '/bin/sh' });
    expect(classifyExecutableHead(encode('plain text')).class).toBe('unknown');
  });
});

describe('findOnPath', () => {
  test('finds an executable on PATH, skips non-executables, and takes paths as given', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bare-codex-exe-')));
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, 'codex'), 'not executable');
    writeFileSync(join(second, 'codex'), `#!/bin/sh${LF}`, { mode: 0o755 });
    chmodSync(join(second, 'codex'), 0o755);
    expect(findOnPath('codex', `${first}:${second}`, dir)).toBe(join(second, 'codex'));
    expect(findOnPath('codex', first, dir)).toBeNull();
    expect(findOnPath('./second/codex', undefined, dir)).toBe(join(second, 'codex'));
    expect(findOnPath('codex', undefined, dir)).toBeNull();
  });
});

test('inspectExecutable records class, real path and hash without running anything', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bare-codex-exe-')));
  const path = join(dir, 'codex');
  writeFileSync(path, `#!/bin/sh${LF}exit 9${LF}`, { mode: 0o755 });
  const facts = await inspectExecutable(path);
  expect(facts).toMatchObject({ path, realpath: path, class: 'script', shebang: '/bin/sh' });
  expect(facts.sha256).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
  expect((await inspectExecutable(path, { hash: false })).sha256).toBeNull();
});

test('parseVersion takes the first x.y.z', () => {
  expect(parseVersion('codex-cli 0.162.1')).toBe('0.162.1');
  expect(parseVersion('codex-cli 0.170.0-alpha.2 (build)')).toBe('0.170.0-alpha.2');
  expect(parseVersion('no version')).toBeNull();
});
