import { describe, expect, test } from 'bun:test';
import { initialStreamState, JsonlSplitter, parseLine, reduceEvents, reduceLine } from './events.ts';

const LF = String.fromCharCode(10);
const THREAD = '0199a000-0000-7000-8000-000000000001';
const usage = { input_tokens: 3, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 };

function lines(...events: object[]): string {
  return events.map(event => JSON.stringify(event)).join(LF) + LF;
}

const complete = lines(
  { type: 'thread.started', thread_id: THREAD },
  { type: 'turn.started' },
  { type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'done' } },
  { type: 'turn.completed', usage },
);

describe('JsonlSplitter', () => {
  test('gives the same lines whatever the chunk boundaries, and keeps a torn tail', () => {
    const bytes = new TextEncoder().encode(`${complete}{"type":"turn.sta`);
    for (const size of [ 1, 3, 7, 64, bytes.length ]) {
      const splitter = new JsonlSplitter();
      const got: string[] = [];
      for (let at = 0; at < bytes.length; at += size) {
        for (const line of splitter.push(bytes.subarray(at, at + size))) {
          got.push(new TextDecoder().decode(line));
        }
      }
      expect(got.length).toBe(5);
      expect(new TextDecoder().decode(splitter.end() ?? new Uint8Array())).toBe('{"type":"turn.sta');
    }
  });

  test('end is null when the stream ended on a newline', () => {
    const splitter = new JsonlSplitter();
    splitter.push(new TextEncoder().encode(complete));
    expect(splitter.end()).toBeNull();
  });
});

describe('parseLine', () => {
  test('names why a line is not an event, and never throws', () => {
    expect(parseLine('not json')).toMatchObject({ kind: 'malformed', reason: 'invalid-json' });
    expect(parseLine('[1]')).toMatchObject({ kind: 'malformed', reason: 'not-object' });
    expect(parseLine('{"type":7}')).toMatchObject({ kind: 'malformed', reason: 'no-type' });
    expect(parseLine(new Uint8Array([ 0x7b, 0xff, 0x7d ]))).toMatchObject({ kind: 'malformed', reason: 'invalid-utf8' });
    expect(parseLine('   ')).toEqual({ kind: 'blank' });
    expect(parseLine('{"type":"turn.started"}')).toMatchObject({ kind: 'event', type: 'turn.started' });
  });
});

describe('reduceEvents', () => {
  test('a completed stream: thread, terminal with usage, last agent message, counts', () => {
    const state = reduceEvents(complete);
    expect(state.threadIds).toEqual([ THREAD ]);
    expect(state.terminal).toEqual({ kind: 'completed', line: 5, usage });
    expect(state.lastAgentMessage).toBe('done');
    expect(state.commandsStarted).toBe(1);
    expect(state.events).toBe(5);
    expect(state.malformed).toBe(0);
    expect(state.tornTail).toBeNull();
  });

  test('unknown event and item types are counted, never dropped silently', () => {
    const state = reduceEvents(lines(
      { type: 'thread.started', thread_id: THREAD },
      { type: 'mystery.event' },
      { type: 'item.completed', item: { id: 'x', type: 'hologram' } },
    ));
    expect(state.unknownEventTypes).toEqual({ 'mystery.event': 1 });
    expect(state.unknownItemTypes).toEqual({ hologram: 1 });
  });

  test('known events without their fields are shape anomalies', () => {
    const state = reduceEvents(lines({ type: 'thread.started' }, { type: 'turn.completed' }, { type: 'item.completed', item: { type: 'agent_message' } }));
    expect(state.shapeAnomalies).toBe(3);
    expect(state.terminal).toEqual({ kind: 'completed', line: 2, usage: null });
  });

  test('errors are counted before and after the terminal event; warnings are items, not failures', () => {
    const state = reduceEvents(lines(
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { id: 'w', type: 'error', message: 'config warning' } },
      { type: 'turn.completed', usage },
      { type: 'error', message: 'late' },
    ));
    expect(state.errorsBeforeTerminal).toBe(1);
    expect(state.errorsAfterTerminal).toBe(1);
    expect(state.warnings.map(warning => warning.message)).toEqual([ 'config warning' ]);
    expect(state.eventsAfterTerminal).toBe(1);
  });

  test('turn.failed is the terminal event with its message', () => {
    const state = reduceEvents(lines({ type: 'turn.failed', error: { message: 'boom' } }));
    expect(state.terminal).toEqual({ kind: 'failed', line: 1, message: 'boom' });
  });

  test('a torn tail is recorded and not folded in', () => {
    const state = reduceEvents(`${lines({ type: 'turn.started' })}{"type":"turn.completed","usage":{}}`);
    expect(state.tornTail).toMatchObject({ parses: true, type: 'turn.completed' });
    expect(state.terminal).toBeNull();
  });

  test('the reducer leaves the state it was given as it was', () => {
    const before = initialStreamState();
    const snapshot = JSON.stringify(before);
    reduceLine(before, '{"type":"thread.started","thread_id":"t"}');
    reduceLine(before, 'garbage');
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
