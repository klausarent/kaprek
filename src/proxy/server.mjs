// kaprek proxy: Claude Code -> here -> api.anthropic.com, unchanged.
//
// One upstream account, the login Claude Code already has (only
// ANTHROPIC_BASE_URL is set, so the saved claude.ai login stays the
// credential and its plan limits apply — code.claude.com/docs/en/llm-gateway).
// No pooling, no rotation, no other models. What the proxy adds is reading
// along: the unified rate-limit headers and the usage numbers, written to
// <dataDir>/proxy. Bodies and credentials are relayed, never stored.
import http from 'node:http';
import { openUpstream } from './upstream.mjs';
import { parseUnifiedHeaders } from './ratelimit.mjs';
import { createUsageTap } from './usage-tap.mjs';
import { appendRequest, writeQuota } from './store.mjs';
import { createAccountResolver } from './accounts.mjs';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

function forwardHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  return out;
}

function header(req, name) {
  const v = req.headers[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

// Claude Code aborts a stream after 5 min without bytes; the upstream gets
// a little longer so Claude Code, not the proxy, decides. (Council: a
// black-holed upstream must not hang a turn forever.)
const UPSTREAM_IDLE_MS = 6 * 60 * 1000;

export function createProxyServer({ dataDir, requestUpstream = openUpstream, now = Date.now, upstreamIdleMs = UPSTREAM_IDLE_MS, resolveAccount = createAccountResolver({ dataDir }) } = {}) {
  const warned = new Set();
  const server = http.createServer((req, res) => {
    const started = now();
    const pathOnly = (req.url ?? '/').split('?')[0];
    const recordable = pathOnly === '/v1/messages';
    // x-kaprek-account is kaprek's own tag for the session (see accounts.mjs);
    // it is read here and not forwarded.
    const accountTag = header(req, 'x-kaprek-account');
    const headers = { ...forwardHeaders(req.headers), 'accept-encoding': 'identity' };
    delete headers['x-kaprek-account'];
    let done = false;
    let clientGone = false;

    function finish(extra) {
      if (done) return;
      done = true;
      if (!recordable) return;
      try {
        appendRequest(dataDir, {
          ts: new Date(started).toISOString(),
          ms: now() - started,
          sessionId: header(req, 'x-claude-code-session-id'),
          agentId: header(req, 'x-claude-code-agent-id'),
          requestClass: header(req, 'x-claude-code-request-class'),
          method: req.method,
          path: pathOnly,
          ...extra,
        });
      } catch {
        // a full disk must not break the session
      }
    }

    const upReq = requestUpstream({ method: req.method, path: req.url, headers });
    upReq.setTimeout(upstreamIdleMs, () => upReq.destroy(Object.assign(new Error('upstream idle timeout'), { code: 'ETIMEDOUT' })));

    // Client gone at any point (Esc in Claude Code, closed terminal): cut the
    // upstream at once, record it as aborted, never write to the dead socket.
    res.on('close', () => {
      if (res.writableFinished) return;
      clientGone = true;
      upReq.destroy();
    });
    // ECONNRESET on either socket must not throw out of the one process
    // every session depends on.
    req.on('error', () => upReq.destroy());
    res.on('error', () => upReq.destroy());

    upReq.on('response', (upRes) => {
      const limits = parseUnifiedHeaders(upRes.headers);
      const orgId = typeof upRes.headers['anthropic-organization-id'] === 'string' ? upRes.headers['anthropic-organization-id'] : null;
      let who = { account: accountTag ?? 'unbekannt', mismatch: null };
      try {
        who = resolveAccount({ headerAccount: accountTag, orgId });
      } catch {
        // an unreadable org map must not break the session
      }
      if (who.mismatch && !warned.has(who.mismatch)) {
        warned.add(who.mismatch);
        console.warn(`kaprek proxy: a session started as ${who.mismatch} answered as ${who.account}; is its token missing or expired?`);
      }
      if (upRes.statusCode === 401 && accountTag && recordable) {
        // Expired or revoked setup-token: take the account out of the pick
        // until a request on it succeeds again (that overwrites this) or
        // AUTH_HOLD_MS passes. Only /v1/messages counts: a side endpoint
        // that wants a scope the token lacks says nothing about inference.
        try {
          writeQuota(dataDir, { seenAt: new Date(now()).toISOString(), status: 'auth-error', authError: true, windows: {} }, undefined, accountTag);
        } catch {
          // same as below
        }
      } else if (limits) {
        try {
          writeQuota(dataDir, { seenAt: new Date(now()).toISOString(), ...limits }, undefined, who.account);
        } catch {
          // same as above
        }
      }
      const tap = createUsageTap(upRes.headers['content-type']);
      const tail = () => ({ status: upRes.statusCode, ...tap.result(), rateLimit: limits?.windows ?? null, account: who.account, orgId, mismatch: who.mismatch });
      if (clientGone) {
        upRes.destroy();
        finish({ ...tail(), aborted: true });
        return;
      }
      res.writeHead(upRes.statusCode ?? 502, forwardHeaders(upRes.headers));
      res.flushHeaders();
      upRes.on('data', (chunk) => tap.push(chunk));
      upRes.pipe(res);
      upRes.on('end', () => finish({ ...tail(), aborted: clientGone }));
      upRes.on('error', () => {
        // Upstream died mid-stream: end the client socket too, so Claude
        // Code sees a dropped connection and retries instead of waiting.
        res.destroy();
        finish({ ...tail(), aborted: true });
      });
      upRes.on('close', () => {
        if (!upRes.complete) finish({ ...tail(), aborted: true });
      });
    });

    upReq.on('error', (err) => {
      const code = String(err.code ?? err.message);
      if (clientGone) {
        finish({ status: null, aborted: true, error: code });
        return;
      }
      if (!res.headersSent) {
        // x-should-retry: Claude Code reads it to decide on a retry
        // (llm-gateway-protocol, "Response headers").
        res.writeHead(502, { 'content-type': 'application/json', 'x-should-retry': 'true' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `kaprek proxy: api.anthropic.com unreachable (${code})` } }));
      } else {
        res.destroy();
      }
      finish({ status: 502, aborted: false, error: code });
    });

    req.pipe(upReq);
  });
  // Node's default requestTimeout (300 s) would cut long turns; the socket
  // stays open as long as the stream does. Headers still have to arrive fast.
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 1000;
  server.timeout = 0;
  server.keepAliveTimeout = 65 * 1000;
  return server;
}
