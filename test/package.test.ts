import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isJsonObject } from '../src/types.ts';
import { BARE_CODEX_VERSION } from '../src/version.ts';

function manifest(): unknown {
  return JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8'));
}

test('the exported version is the package version', () => {
  const pkg = manifest();
  expect(isJsonObject(pkg) ? pkg['version'] : null).toBe(BARE_CODEX_VERSION);
});

test('lifecycle comes from the pinned public bare-claude commit, not from a copy', () => {
  const pkg = manifest();
  const dependencies = isJsonObject(pkg) ? pkg['dependencies'] : null;
  const spec = isJsonObject(dependencies) ? dependencies['@agladysh/bare-claude'] : null;
  expect(spec).toBe('github:agladysh/bare-claude#0fa4f8a7c4688fa6b82507fe9a53920147a6cfb7');
});
