import { describe, expect, test } from 'bun:test';
import { composeEnv, isTruthyFlag } from './env.ts';

const SECRET = 'env-test-secret-value-91c2';

describe('composeEnv', () => {
  test('passes the inherited environment on unchanged by default, launcher variables included', () => {
    const composed = composeEnv({ PATH: '/usr/bin', CODEX_HOME: '/homes/a', CODEX_SWITCH_ACCOUNT: '5', OTHER: 'x', GONE: undefined });
    expect(composed.refusals).toEqual([]);
    expect(composed.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/homes/a', CODEX_SWITCH_ACCOUNT: '5', OTHER: 'x' });
  });

  test('refuses an inherited CODEX_API_KEY by default', () => {
    const composed = composeEnv({ CODEX_API_KEY: SECRET });
    expect(composed.refusals.map(refusal => refusal.code)).toEqual([ 'ambient-credential' ]);
    expect(composed.refusals[0]?.message).toContain('CODEX_API_KEY');
    expect(composed.refusals[0]?.message).not.toContain(SECRET);
  });

  test('refuses every route-changing variable, but not an empty one', () => {
    const composed = composeEnv({ CODEX_ACCESS_TOKEN: SECRET, CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'http://x', CODEX_API_KEY: '  ' });
    expect(composed.refusals.length).toBe(2);
  });

  test('unset drops ambient credentials and says so', () => {
    const composed = composeEnv({ CODEX_API_KEY: SECRET, PATH: '/bin' }, { ambientCredentials: 'unset' });
    expect(composed.refusals).toEqual([]);
    expect(composed.env['CODEX_API_KEY']).toBeUndefined();
    expect(composed.facts.variables.find(fact => fact.name === 'CODEX_API_KEY')).toEqual({ name: 'CODEX_API_KEY', present: false, origin: 'ambient-unset' });
  });

  test('pass keeps ambient credentials, recorded by presence only', () => {
    const composed = composeEnv({ CODEX_API_KEY: SECRET }, { ambientCredentials: 'pass' });
    expect(composed.env['CODEX_API_KEY']).toBe(SECRET);
    expect(composed.notes.join(' ')).toContain('deliberately');
    expect(JSON.stringify(composed.facts)).not.toContain(SECRET);
  });

  test('a credential the caller sets deliberately is passed and never recorded by value', () => {
    const composed = composeEnv({ CODEX_API_KEY: 'ambient-other' }, { set: { CODEX_API_KEY: SECRET } });
    expect(composed.refusals).toEqual([]);
    expect(composed.env['CODEX_API_KEY']).toBe(SECRET);
    expect(composed.facts.variables.find(fact => fact.name === 'CODEX_API_KEY')).toEqual({ name: 'CODEX_API_KEY', present: true, origin: 'set' });
    expect(JSON.stringify(composed.facts)).not.toContain(SECRET);
  });

  test('records values only for paths and the account label', () => {
    const composed = composeEnv({ CODEX_HOME: '/homes/a', CODEX_SWITCH_ACCOUNT: '5', OPENAI_API_KEY: SECRET, HOME: '/Users/x' });
    const facts = composed.facts.variables;
    expect(facts.find(fact => fact.name === 'CODEX_HOME')?.value).toBe('/homes/a');
    expect(facts.find(fact => fact.name === 'CODEX_SWITCH_ACCOUNT')?.value).toBe('5');
    expect(facts.find(fact => fact.name === 'OPENAI_API_KEY')).toEqual({ name: 'OPENAI_API_KEY', present: true, origin: 'inherited' });
    expect(facts.find(fact => fact.name === 'HOME')?.value).toBeUndefined();
    expect(JSON.stringify(composed.facts)).not.toContain(SECRET);
    expect(composed.facts.count).toBe(4);
  });

  test('inherit false starts empty', () => {
    const composed = composeEnv({ CODEX_API_KEY: SECRET, PATH: '/bin' }, { inherit: false, set: { PATH: '/usr/bin' } });
    expect(composed.refusals).toEqual([]);
    expect(composed.env).toEqual({ PATH: '/usr/bin' });
  });

  test('a named home sets CODEX_HOME and notes what it replaced', () => {
    const composed = composeEnv({ CODEX_HOME: '/homes/a', CODEX_SQLITE_HOME: '/db' }, {}, { kind: 'path', codexHome: '/homes/b' });
    expect(composed.env['CODEX_HOME']).toBe('/homes/b');
    expect(composed.notes.join(' ')).toContain('/homes/a');
    expect(composed.notes.join(' ')).toContain('CODEX_SQLITE_HOME');
  });

  test('a named home that disagrees with env.set.CODEX_HOME is refused', () => {
    const composed = composeEnv({}, { set: { CODEX_HOME: '/x' } }, { kind: 'path', codexHome: '/y' });
    expect(composed.refusals.map(refusal => refusal.code)).toEqual([ 'option-invalid' ]);
  });

  test('invalid variable names are refused', () => {
    expect(composeEnv({}, { set: { 'A=B': '1' } }).refusals.map(refusal => refusal.code)).toEqual([ 'env-invalid' ]);
  });
});

test('isTruthyFlag reads on/off the way a launcher does', () => {
  expect([ undefined, '', '0', 'false', 'No', ' off ' ].map(isTruthyFlag)).toEqual([ false, false, false, false, false, false ]);
  expect([ '1', 'yes', 'true', 'on' ].map(isTruthyFlag)).toEqual([ true, true, true, true ]);
});
