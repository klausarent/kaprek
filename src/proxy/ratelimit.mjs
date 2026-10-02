// The subscription windows, as Anthropic reports them on every response.
//
// Claude Code reads the same `anthropic-ratelimit-unified-*` headers to show
// plan usage (code.claude.com/docs/en/llm-gateway-protocol, "Response
// headers"); the proxy only reads along. Utilization arrives as a ratio
// (0.58), resets as epoch seconds. Unknown windows are kept under their own
// name because the set grows with Claude Code releases.
const PREFIX = 'anthropic-ratelimit-unified-';
const FIELD_RE = /^(.+)-(utilization|reset)$/;

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

function ratioToPercent(raw) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function epochToIso(raw) {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n < 1e11 ? n * 1000 : n).toISOString();
}

export function parseUnifiedHeaders(headers) {
  let seen = false;
  let status = null;
  let representativeClaim = null;
  const windows = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (!key.startsWith(PREFIX)) continue;
    seen = true;
    const rest = key.slice(PREFIX.length);
    const raw = first(value);
    if (rest === 'status') status = typeof raw === 'string' ? raw : null;
    else if (rest === 'representative-claim') representativeClaim = typeof raw === 'string' ? raw : null;
    const m = FIELD_RE.exec(rest);
    if (!m) continue;
    const win = (windows[m[1]] ??= { usedPercent: null, resetsAt: null });
    if (m[2] === 'utilization') win.usedPercent = ratioToPercent(raw);
    else win.resetsAt = epochToIso(raw);
  }
  return seen ? { status, representativeClaim, windows } : null;
}
