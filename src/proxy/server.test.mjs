import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxyServer } from './server.mjs';
import { readRequests, readQuota, proxyDir } from './store.mjs';

let dataDir, upstream, proxy, proxyPort, seen;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function call(p, { method = 'POST', headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method, path: p, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function start(handler) {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      handler(req, res);
    });
  });
  const upPort = await listen(upstream);
  const requestUpstream = ({ method, path: p, headers }) => http.request({ host: '127.0.0.1', port: upPort, method, path: p, headers });
  proxy = createProxyServer({ dataDir, requestUpstream });
  proxyPort = await listen(proxy);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-proxy-srv-'));
});
afterEach(async () => {
  await new Promise((r) => (proxy ? proxy.close(r) : r()));
  await new Promise((r) => (upstream ? upstream.close(r) : r()));
  proxy = upstream = null;
});

describe('proxy server', () => {
  it('forwards anthropic headers and body unchanged and relays the stream', async () => {
    await start((req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'anthropic-ratelimit-unified-5h-utilization': '0.42',
        'anthropic-ratelimit-unified-5h-reset': '1790000000',
        'anthropic-ratelimit-unified-status': 'allowed',
      });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":3,"output_tokens":1}}}\n\n');
      res.end('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n');
    });
    const r = await call('/v1/messages?beta=true', {
      headers: { authorization: 'Bearer SECRET-TOKEN', 'anthropic-beta': 'oauth-2025-04-20,foo', 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': 'sess-1' },
      body: '{"model":"claude-opus-5-5"}',
    });
    expect(r.status).toBe(200);
    expect(r.text).toContain('message_delta');
    expect(r.headers['anthropic-ratelimit-unified-5h-utilization']).toBe('0.42');
    expect(seen.headers['anthropic-beta']).toBe('oauth-2025-04-20,foo');
    expect(seen.headers.authorization).toBe('Bearer SECRET-TOKEN');
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.body).toBe('{"model":"claude-opus-5-5"}');
    expect(seen.url).toBe('/v1/messages?beta=true');

    const [rec] = readRequests(dataDir);
    expect(rec).toMatchObject({ sessionId: 'sess-1', path: '/v1/messages', status: 200, model: 'claude-opus-5-5', inputTokens: 3, outputTokens: 9, aborted: false });
    expect(readQuota(dataDir).windows['5h'].usedPercent).toBe(42);
    const onDisk = fs.readFileSync(path.join(proxyDir(dataDir), 'requests.jsonl'), 'utf8');
    expect(onDisk).not.toContain('SECRET-TOKEN');
    expect(onDisk).not.toContain('claude-opus-5-5"}'); // no request body
  });

  it('records the windows of a 429 too', async () => {
    await start((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30', 'anthropic-ratelimit-unified-5h-utilization': '1', 'anthropic-ratelimit-unified-status': 'rejected' });
      res.end('{"type":"error","error":{"type":"rate_limit_error","message":"x"}}');
    });
    const r = await call('/v1/messages');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBe('30');
    expect(readQuota(dataDir)).toMatchObject({ status: 'rejected', windows: { '5h': { usedPercent: 100 } } });
  });

  it('answers 502 in Anthropic error shape when the upstream is unreachable', async () => {
    proxy = createProxyServer({ dataDir, requestUpstream: ({ method, path: p, headers }) => http.request({ host: '127.0.0.1', port: 1, method, path: p, headers }) });
    proxyPort = await listen(proxy);
    const r = await call('/v1/messages');
    expect(r.status).toBe(502);
    expect(JSON.parse(r.text)).toMatchObject({ type: 'error', error: { type: 'api_error' } });
    expect(readRequests(dataDir)[0]).toMatchObject({ status: 502, error: expect.any(String) });
  });

  it('aborts the upstream request when the client goes away mid-stream', async () => {
    let upstreamClosed;
    const closed = new Promise((r) => (upstreamClosed = r));
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      res.on('close', upstreamClosed);
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
      req.end('{}');
    });
    await closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(readRequests(dataDir)[0]).toMatchObject({ aborted: true });
  });

  it('does not cut long streams: request timeout off, header timeout on', async () => {
    const s = createProxyServer({ dataDir });
    expect(s.requestTimeout).toBe(0);
    expect(s.timeout).toBe(0);
    expect(s.headersTimeout).toBe(60000);
  });

  it('records aborted when the client leaves before the upstream answered', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    await start(async (req, res) => {
      await gate;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: ping\ndata: {"type":"ping"}\n\n');
    });
    await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages' });
      req.on('error', () => {});
      req.end('{}', () => setTimeout(() => {
        req.destroy();
        resolve();
      }, 30));
    });
    // Let the proxy see the closed socket before the upstream answers.
    await new Promise((r) => setTimeout(r, 100));
    release();
    await new Promise((r) => setTimeout(r, 80));
    const [rec] = readRequests(dataDir);
    expect(rec.aborted).toBe(true);
    expect(rec.status).not.toBe(502);
  });

  it('gives up on a silent upstream after upstreamIdleMs with a retryable 502', async () => {
    upstream = http.createServer(() => {}); // never answers
    const upPort = await listen(upstream);
    proxy = createProxyServer({ dataDir, upstreamIdleMs: 100, requestUpstream: ({ method, path: p, headers }) => http.request({ host: '127.0.0.1', port: upPort, method, path: p, headers }) });
    proxyPort = await listen(proxy);
    const r = await call('/v1/messages');
    expect(r.status).toBe(502);
    expect(r.headers['x-should-retry']).toBe('true');
    expect(readRequests(dataDir)[0].error).toBe('ETIMEDOUT');
  });

  it('ends the client socket when the upstream dies mid-stream', async () => {
    await start((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {"type":"ping"}\n\n');
      setTimeout(() => res.socket.destroy(), 20);
    });
    const outcome = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'POST', path: '/v1/messages' }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve('end'));
        res.on('error', () => resolve('error'));
        res.on('close', () => resolve('close'));
      });
      req.on('error', () => resolve('error'));
      req.end('{}');
    });
    expect(['error', 'close', 'end']).toContain(outcome);
    await new Promise((r) => setTimeout(r, 50));
    expect(readRequests(dataDir)[0].aborted).toBe(true);
  });

  it('only records /v1/messages, but relays everything', async () => {
    await start((req, res) => res.writeHead(200).end());
    const r = await call('/api/hello', { method: 'HEAD', body: '' });
    expect(r.status).toBe(200);
    expect(readRequests(dataDir)).toEqual([]);
  });
});
