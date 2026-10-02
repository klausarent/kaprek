// codex' own account of its windows, read from the rollout files it writes
// to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Every token_count event
// carries rate_limits; the newest non-null one is the current state. Only
// the tail of the newest files is read — rollouts grow to tens of MB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function newestRollouts(root, maxFiles) {
  const files = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try {
          files.push({ full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // vanished
        }
      }
    }
  };
  walk(root, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, maxFiles).map((f) => f.full);
}

function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function toWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const mins = typeof w.window_minutes === 'number' ? w.window_minutes : null;
  const name = mins === 300 ? '5h' : mins === 10080 ? '7d' : mins !== null ? `${mins}m` : 'window';
  const pct = typeof w.used_percent === 'number' ? Math.round(w.used_percent) : null;
  const resetsAt = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null;
  return { name, usedPercent: pct, resetsAt, windowMinutes: mins };
}

// 1 MB: tool outputs make single rollout lines large, and a window that
// only holds half of one would hide the token_count lines before it.
export function latestCodexLimits({ home = os.homedir(), maxFiles = 20, tailBytes = 1024 * 1024 } = {}) {
  const root = path.join(home, '.codex', 'sessions');
  for (const file of newestRollouts(root, maxFiles)) {
    let text;
    try {
      text = tail(file, tailBytes);
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const rl = e?.payload?.rate_limits;
      const windows = [toWindow(rl?.primary), toWindow(rl?.secondary)].filter(Boolean);
      if (windows.length === 0) continue;
      const ts = Date.parse(e.timestamp);
      return { seenAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null, plan: typeof rl.plan_type === 'string' ? rl.plan_type : null, windows };
    }
  }
  return null;
}
