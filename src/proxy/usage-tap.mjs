// Reads token usage out of a response the proxy is relaying anyway.
//
// It only ever sees copies of the chunks: what reaches Claude Code is the
// upstream's bytes, untouched. Streams carry usage in message_start (input
// and cache) and message_delta (cumulative output); plain JSON carries it
// once. Anything unreadable leaves zeros, never an exception — a broken
// tap must not break a session.
const MAX_JSON_BYTES = 1024 * 1024;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function createUsageTap(contentType) {
  const streaming = /text\/event-stream/i.test(contentType ?? '');
  const out = { model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, stopReason: null };
  let pending = '';
  let jsonBytes = 0;
  let jsonOverflow = false;

  function applyUsage(usage) {
    if (!usage || typeof usage !== 'object') return;
    if ('input_tokens' in usage) out.inputTokens = num(usage.input_tokens);
    if ('cache_read_input_tokens' in usage) out.cacheReadTokens = num(usage.cache_read_input_tokens);
    if ('cache_creation_input_tokens' in usage) out.cacheCreationTokens = num(usage.cache_creation_input_tokens);
    if ('output_tokens' in usage) out.outputTokens = num(usage.output_tokens);
  }

  function onEvent(data) {
    let e;
    try {
      e = JSON.parse(data);
    } catch {
      return;
    }
    if (e?.type === 'message_start') {
      if (typeof e.message?.model === 'string') out.model = e.message.model;
      applyUsage(e.message?.usage);
    } else if (e?.type === 'message_delta') {
      applyUsage(e.usage);
      if (typeof e.delta?.stop_reason === 'string') out.stopReason = e.delta.stop_reason;
    }
  }

  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (streaming) {
        pending += text;
        let idx;
        while ((idx = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, idx).replace(/\r$/, '');
          pending = pending.slice(idx + 1);
          if (line.startsWith('data:')) onEvent(line.slice(5).trim());
        }
        if (pending.length > MAX_JSON_BYTES) pending = '';
        return;
      }
      if (jsonOverflow) return;
      jsonBytes += Buffer.byteLength(text);
      if (jsonBytes > MAX_JSON_BYTES) {
        jsonOverflow = true;
        pending = '';
        return;
      }
      pending += text;
    },
    result() {
      if (!streaming && !jsonOverflow && pending) {
        try {
          const body = JSON.parse(pending);
          if (typeof body?.model === 'string') out.model = body.model;
          if (typeof body?.stop_reason === 'string') out.stopReason = body.stop_reason;
          applyUsage(body?.usage);
        } catch {
          // not JSON: zeros stay
        }
        pending = '';
      }
      return { ...out };
    },
  };
}
