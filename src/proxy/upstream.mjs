// THE ONE FILE IN THE PROXY THAT LEAVES THIS MACHINE, and only to
// api.anthropic.com — the host Claude Code would have called anyway. The
// host is a constant, not a setting: a proxy that could be pointed
// elsewhere would be a way to send someone's login to a stranger.
// Pinned by src/no-network.test.mjs.
import https from 'node:https';

export const UPSTREAM_HOST = 'api.anthropic.com';

export function openUpstream({ method, path, headers }) {
  return https.request({ host: UPSTREAM_HOST, port: 443, method, path, headers: { ...headers, host: UPSTREAM_HOST } });
}
