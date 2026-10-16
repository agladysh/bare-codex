/**
 * The `codex exec --json` event stream, read without trusting it: a byte
 * splitter that keeps torn tails, a line parser that never throws, and a
 * pure reducer whose state says what was seen, including what was not
 * understood. Raw bytes are the caller's to keep before any of this runs;
 * `runCodex` writes them to `events.jsonl` first.
 *
 * Vocabulary at 0.162.1 (codex-rs/exec/src/exec_events.rs): top-level
 * `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
 * `item.started`, `item.updated`, `item.completed` and `error`; item types
 * `agent_message`, `reasoning`, `command_execution`, `file_change`,
 * `mcp_tool_call`, `collab_tool_call`, `web_search`, `todo_list` and `error`.
 * Anything else is counted as unknown, never dropped silently and never
 * guessed at.
 *
 * Meaning, from codex-rs/exec/src/event_processor_with_jsonl_output.rs:
 * - a top-level `error` is emitted for retried stream errors too: JSONL drops
 *   `will_retry` (:447-458; exec/src/lib.rs:1341-1347);
 * - an interrupted turn emits no terminal event (:559-563);
 * - warnings, config warnings, deprecation notices and model reroutes arrive
 *   as `item.completed` items of type `error` (:427-473, :494-507); they are
 *   not failures.
 */

import { isJsonObject, type JsonObject, type JsonValue } from './types.ts';

/** Top-level event types of codex exec 0.162.1 (codex-rs/exec/src/exec_events.rs:11-37). */
export const KNOWN_EVENT_TYPES: readonly string[] = [
  'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error',
];

/** Item types of codex exec 0.162.1 (codex-rs/exec/src/exec_events.rs:105-133). */
export const KNOWN_ITEM_TYPES: readonly string[] = [
  'agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'todo_list', 'error',
];

const sampleLimit = 8;
const listLimit = 32;
const textLimit = 2_000;
const lineFeed = 0x0a;
const carriageReturn = 13;

export type MalformedReason = 'invalid-utf8' | 'invalid-json' | 'not-object' | 'no-type';

/** One line of the stream, as parsed. */
export type ParsedLine =
  | { kind: 'blank' }
  | { kind: 'event', type: string, event: JsonObject }
  | { kind: 'malformed', reason: MalformedReason, text: string };

export type ParsedEvent = Extract<ParsedLine, { kind: 'event' }>;

/** A line kept as an example, with its 1-based line number. */
export interface LineSample {
  line: number,
  reason: string,
  text: string,
}

export interface StreamError {
  line: number,
  message: string,
}

/** `turn.completed` usage (codex-rs/exec/src/exec_events.rs:59-73). */
export interface Usage {
  input_tokens: number,
  cached_input_tokens: number,
  cache_write_input_tokens: number,
  output_tokens: number,
  reasoning_output_tokens: number,
}

/** The first terminal event, with its line number. */
export type Terminal =
  | { kind: 'completed', line: number, usage: Usage | null }
  | { kind: 'failed', line: number, message: string };

/** Bytes left after the last newline when the stream ended. */
export interface TornTail {
  bytes: number,
  /** Whether those bytes happen to parse as an event; they are not reduced either way. */
  parses: boolean,
  type: string | null,
  text: string,
}

/**
 * What a stream has shown so far. The reducer never mutates a state it is
 * given; every list is bounded, with a count beside it.
 */
export interface StreamState {
  lines: number,
  blankLines: number,
  events: number,
  malformed: number,
  malformedSamples: LineSample[],
  shapeAnomalies: number,
  shapeSamples: LineSample[],
  eventTypes: Record<string, number>,
  unknownEventTypes: Record<string, number>,
  itemTypes: Record<string, number>,
  unknownItemTypes: Record<string, number>,
  threadIds: string[],
  threadStartedEvents: number,
  turnsStarted: number,
  terminal: Terminal | null,
  terminalEvents: number,
  eventsAfterTerminal: number,
  errors: StreamError[],
  errorCount: number,
  errorsBeforeTerminal: number,
  errorsAfterTerminal: number,
  warnings: StreamError[],
  warningCount: number,
  lastAgentMessage: string | null,
  agentMessages: number,
  commandsStarted: number,
  tornTail: TornTail | null,
}

export function initialStreamState(): StreamState {
  return {
    lines: 0,
    blankLines: 0,
    events: 0,
    malformed: 0,
    malformedSamples: [],
    shapeAnomalies: 0,
    shapeSamples: [],
    eventTypes: {},
    unknownEventTypes: {},
    itemTypes: {},
    unknownItemTypes: {},
    threadIds: [],
    threadStartedEvents: 0,
    turnsStarted: 0,
    terminal: null,
    terminalEvents: 0,
    eventsAfterTerminal: 0,
    errors: [],
    errorCount: 0,
    errorsBeforeTerminal: 0,
    errorsAfterTerminal: 0,
    warnings: [],
    warningCount: 0,
    lastAgentMessage: null,
    agentMessages: 0,
    commandsStarted: 0,
    tornTail: null,
  };
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const lenientDecoder = new TextDecoder('utf-8');

function clip(text: string): string {
  return text.length <= textLimit ? text : `${text.slice(0, textLimit)}…`;
}

function increment(counts: Readonly<Record<string, number>>, key: string): Record<string, number> {
  return { ...counts, [key]: (counts[key] ?? 0) + 1 };
}

function keepFirst<T>(list: readonly T[], item: T, limit: number): T[] {
  return list.length >= limit ? [ ...list ] : [ ...list, item ];
}

function keepLast<T>(list: readonly T[], item: T, limit: number): T[] {
  const next = [ ...list, item ];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Parses one line (without its newline). Never throws. */
export function parseLine(line: Uint8Array | string): ParsedLine {
  let text: string;
  if (typeof line === 'string') {
    text = line;
  } else {
    try {
      text = strictDecoder.decode(line);
    } catch {
      return { kind: 'malformed', reason: 'invalid-utf8', text: clip(lenientDecoder.decode(line)) };
    }
  }
  if (text.charCodeAt(text.length - 1) === carriageReturn) {
    text = text.slice(0, -1);
  }
  if (text.trim() === '') {
    return { kind: 'blank' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: 'malformed', reason: 'invalid-json', text: clip(text) };
  }
  if (!isJsonObject(value)) {
    return { kind: 'malformed', reason: 'not-object', text: clip(text) };
  }
  const type = value['type'];
  if (typeof type !== 'string') {
    return { kind: 'malformed', reason: 'no-type', text: clip(text) };
  }
  return { kind: 'event', type, event: value };
}

function parseUsage(value: JsonValue | undefined): Usage | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const object = value;
  const number = (key: string): number | null => {
    const field = object[key];
    return typeof field === 'number' ? field : null;
  };
  const input = number('input_tokens');
  const cached = number('cached_input_tokens');
  const output = number('output_tokens');
  const reasoning = number('reasoning_output_tokens');
  if (input === null || cached === null || output === null || reasoning === null) {
    return null;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: number('cache_write_input_tokens') ?? 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
  };
}

/** Folds one parsed line into a new state; `state` itself is left as it was. */
export function reduceParsed(state: StreamState, parsed: ParsedLine): StreamState {
  const line = state.lines + 1;
  const next: StreamState = { ...state, lines: line };
  if (parsed.kind === 'blank') {
    next.blankLines += 1;
    return next;
  }
  if (parsed.kind === 'malformed') {
    next.malformed += 1;
    next.malformedSamples = keepFirst(state.malformedSamples, { line, reason: parsed.reason, text: parsed.text }, sampleLimit);
    return next;
  }

  const { event, type } = parsed;
  next.events += 1;
  next.eventTypes = increment(state.eventTypes, type);
  if (state.terminal !== null) {
    next.eventsAfterTerminal += 1;
  }
  const anomaly = (reason: string) => {
    next.shapeAnomalies += 1;
    next.shapeSamples = keepFirst(next.shapeSamples, { line, reason, text: clip(JSON.stringify(event)) }, sampleLimit);
  };

  switch (type) {
    case 'thread.started': {
      next.threadStartedEvents += 1;
      const id = event['thread_id'];
      if (typeof id !== 'string' || id === '') {
        anomaly('thread.started without a thread_id string');
        break;
      }
      if (!state.threadIds.includes(id) && state.threadIds.length < sampleLimit) {
        next.threadIds = [ ...state.threadIds, id ];
      }
      break;
    }
    case 'turn.started':
      next.turnsStarted += 1;
      break;
    case 'turn.completed': {
      const usage = parseUsage(event['usage']);
      if (usage === null) {
        anomaly('turn.completed without a usage object of numbers');
      }
      next.terminalEvents += 1;
      if (state.terminal === null) {
        next.terminal = { kind: 'completed', line, usage };
      }
      break;
    }
    case 'turn.failed': {
      const error = event['error'];
      const message = isJsonObject(error) ? error['message'] : undefined;
      if (typeof message !== 'string') {
        anomaly('turn.failed without error.message');
      }
      next.terminalEvents += 1;
      if (state.terminal === null) {
        next.terminal = { kind: 'failed', line, message: clip(typeof message === 'string' ? message : 'turn failed (no message)') };
      }
      break;
    }
    case 'error': {
      const message = event['message'];
      if (typeof message !== 'string') {
        anomaly('error without a message string');
      }
      next.errorCount += 1;
      if (state.terminal === null) {
        next.errorsBeforeTerminal += 1;
      } else {
        next.errorsAfterTerminal += 1;
      }
      next.errors = keepLast(state.errors, { line, message: clip(typeof message === 'string' ? message : JSON.stringify(event)) }, listLimit);
      break;
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event['item'];
      const itemType = isJsonObject(item) ? item['type'] : undefined;
      const itemId = isJsonObject(item) ? item['id'] : undefined;
      if (!isJsonObject(item) || typeof itemType !== 'string' || typeof itemId !== 'string') {
        anomaly(`${type} without an item carrying string id and type`);
        break;
      }
      if (!KNOWN_ITEM_TYPES.includes(itemType)) {
        next.unknownItemTypes = increment(state.unknownItemTypes, itemType);
      }
      if (type === 'item.started' && itemType === 'command_execution') {
        next.commandsStarted += 1;
      }
      if (type !== 'item.completed') {
        break;
      }
      next.itemTypes = increment(state.itemTypes, itemType);
      if (itemType === 'agent_message') {
        const text = item['text'];
        if (typeof text !== 'string') {
          anomaly('agent_message without text');
          break;
        }
        next.agentMessages += 1;
        next.lastAgentMessage = text;
      } else if (itemType === 'error') {
        const message = item['message'];
        next.warningCount += 1;
        next.warnings = keepLast(state.warnings, { line, message: clip(typeof message === 'string' ? message : JSON.stringify(item)) }, listLimit);
      }
      break;
    }
    default:
      next.unknownEventTypes = increment(state.unknownEventTypes, type);
  }
  return next;
}

/** Parses and folds one line. */
export function reduceLine(state: StreamState, line: Uint8Array | string): StreamState {
  return reduceParsed(state, parseLine(line));
}

/** Records what was left after the last newline; it is never folded in as an event. */
export function finishStream(state: StreamState, tail: Uint8Array | null): StreamState {
  if (tail === null || tail.length === 0) {
    return state;
  }
  const parsed = parseLine(tail);
  return {
    ...state,
    tornTail: {
      bytes: tail.length,
      parses: parsed.kind === 'event',
      type: parsed.kind === 'event' ? parsed.type : null,
      text: clip(lenientDecoder.decode(tail)),
    },
  };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Splits a byte stream into lines at `\n`, whatever the chunk boundaries; keeps what follows the last newline. */
export class JsonlSplitter {
  #pending: Uint8Array[] = [];

  /** The complete lines this chunk finishes, without their newlines. */
  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    for (let at = chunk.indexOf(lineFeed, start); at !== -1; at = chunk.indexOf(lineFeed, start)) {
      lines.push(this.#join(chunk.subarray(start, at)));
      start = at + 1;
    }
    if (start < chunk.length) {
      this.#pending.push(chunk.slice(start));
    }
    return lines;
  }

  /** The bytes after the last newline, or null when the stream ended on one. */
  end(): Uint8Array | null {
    if (this.#pending.length === 0) {
      return null;
    }
    const tail = concat(this.#pending);
    this.#pending = [];
    return tail;
  }

  #join(part: Uint8Array): Uint8Array {
    if (this.#pending.length === 0) {
      return part.slice();
    }
    const line = concat([ ...this.#pending, part ]);
    this.#pending = [];
    return line;
  }
}

/** Reduces a complete stream held in memory. */
export function reduceEvents(input: string | Uint8Array): StreamState {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const splitter = new JsonlSplitter();
  let state = initialStreamState();
  for (const line of splitter.push(bytes)) {
    state = reduceLine(state, line);
  }
  return finishStream(state, splitter.end());
}
