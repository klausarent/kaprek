import { describe, it, expect } from 'vitest';
import { createUsageTap } from './usage-tap.mjs';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('createUsageTap', () => {
  it('sums usage from message_start and the last message_delta, across split chunks', () => {
    const tap = createUsageTap('text/event-stream; charset=utf-8');
    const body =
      sse('message_start', { type: 'message_start', message: { model: 'claude-opus-5-5', usage: { input_tokens: 12, cache_read_input_tokens: 4000, cache_creation_input_tokens: 300, output_tokens: 1 } } }) +
      sse('ping', { type: 'ping' }) +
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 250 } });
    for (let i = 0; i < body.length; i += 7) tap.push(Buffer.from(body.slice(i, i + 7)));
    expect(tap.result()).toEqual({ model: 'claude-opus-5-5', inputTokens: 12, outputTokens: 250, cacheReadTokens: 4000, cacheCreationTokens: 300, stopReason: 'end_turn' });
  });

  it('reads a non-streamed JSON body', () => {
    const tap = createUsageTap('application/json');
    tap.push(JSON.stringify({ model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 7 } }));
    expect(tap.result()).toMatchObject({ model: 'claude-haiku-4-5', inputTokens: 5, outputTokens: 7 });
  });

  it('never throws on garbage and stops buffering JSON past 1 MB', () => {
    const tap = createUsageTap('application/json');
    tap.push('x'.repeat(1024 * 1024 + 10));
    tap.push('{not json');
    expect(tap.result()).toEqual({ model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: null });
  });
});
