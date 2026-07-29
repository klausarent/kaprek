// P1-C2 (client half): web/src/lib/api.ts's SSE parsing/incomplete-stream
// detection, tested directly against the real module (Vitest transpiles the
// imported .ts file via esbuild regardless of this test file's own
// extension — no separate web-side test runner needed). The server half
// (a truncated response is a real possibility) is covered in
// src/server/server.test.mjs.
import { test, expect, vi, afterEach } from 'vitest';
import { parseSseChunk, streamChatTurn, IncompleteStreamError } from '../../web/src/lib/api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('parseSseChunk: splits complete frames off the buffer, keeps an incomplete tail', () => {
  const chunk = `data: ${JSON.stringify({ type: 'chat-id', chatId: 'c1' })}\n\ndata: ${JSON.stringify({ type: 'text', text: 'hi' })}\n\ndata: {"type":"tex`;
  const { frames, rest } = parseSseChunk(chunk);
  expect(frames).toEqual([
    { type: 'chat-id', chatId: 'c1' },
    { type: 'text', text: 'hi' },
  ]);
  expect(rest).toBe('data: {"type":"tex');
});

test('parseSseChunk: a malformed frame is skipped, well-formed frames around it still parse', () => {
  const chunk = `data: not json\n\ndata: ${JSON.stringify({ type: 'text', text: 'ok' })}\n\n`;
  const { frames } = parseSseChunk(chunk);
  expect(frames).toEqual([{ type: 'text', text: 'ok' }]);
});

/** Builds a fetch Response whose body streams `chunks` (strings), one per read(). */
function fakeSseResponse(chunks) {
  let i = 0;
  const body = {
    getReader: () => ({
      read: async () => {
        if (i >= chunks.length) return { done: true, value: undefined };
        const value = new TextEncoder().encode(chunks[i]);
        i += 1;
        return { done: false, value };
      },
    }),
  };
  return { ok: true, status: 200, body };
}

test('streamChatTurn: resolves normally once a turn-complete frame is seen', async () => {
  const chatId = 'c1';
  const chunks = [
    `data: ${JSON.stringify({ type: 'chat-id', chatId })}\n\n`,
    `data: ${JSON.stringify({ type: 'text', text: 'hi' })}\n\n`,
    `data: ${JSON.stringify({ type: 'turn-complete', chatId, cliSessionId: null, costUsd: 0, stopReason: 'result', error: null })}\n\n`,
  ];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSseResponse(chunks)));

  const seen = [];
  await expect(streamChatTurn({ text: 'hi', onEvent: (e) => seen.push(e.type) })).resolves.toBeUndefined();
  expect(seen).toEqual(['chat-id', 'text', 'turn-complete']);
});

test('streamChatTurn: a body that ends without turn-complete throws IncompleteStreamError instead of resolving silently', async () => {
  const chunks = [`data: ${JSON.stringify({ type: 'chat-id', chatId: 'c1' })}\n\n`, `data: ${JSON.stringify({ type: 'text', text: 'partial' })}\n\n`];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fakeSseResponse(chunks)));

  const seen = [];
  await expect(streamChatTurn({ text: 'hi', onEvent: (e) => seen.push(e.type) })).rejects.toBeInstanceOf(IncompleteStreamError);
  expect(seen).toEqual(['chat-id', 'text']); // events up to the drop still reached the caller
});
