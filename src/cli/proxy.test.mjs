import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseProxyArgs, proxyStatus } from './proxy.mjs';
import { writePid } from '../proxy/store.mjs';

describe('kaprek proxy cli', () => {
  it('defaults to start on 4911, honours --port and KAPREK_PROXY_PORT', () => {
    expect(parseProxyArgs([], {})).toEqual({ sub: 'start', port: 4911 });
    expect(parseProxyArgs(['start', '--port', '5000'], {})).toEqual({ sub: 'start', port: 5000 });
    expect(parseProxyArgs(['status'], { KAPREK_PROXY_PORT: '4999' })).toEqual({ sub: 'status', port: 4999 });
    expect(parseProxyArgs(['--port', 'abc'], {}).sub).toBe('help');
  });

  it('knows the autostart subcommand and rejects unknown actions', () => {
    expect(parseProxyArgs(['autostart', 'install'], {})).toEqual({ sub: 'autostart', action: 'install', port: 4911 });
    expect(parseProxyArgs(['autostart', 'status'], {}).action).toBe('status');
    expect(parseProxyArgs(['autostart', 'nuke'], {}).sub).toBe('help');
    expect(parseProxyArgs(['autostart'], {}).sub).toBe('help');
  });

  it('reports a stale pid file as not running', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-cli-'));
    expect(proxyStatus(dir)).toMatchObject({ running: false, pid: null });
    writePid(dir, { pid: 999999, port: 4911 });
    expect(proxyStatus(dir)).toMatchObject({ running: false, pid: 999999, port: 4911 });
    writePid(dir, { pid: process.pid, port: 4911 });
    expect(proxyStatus(dir).running).toBe(true);
  });
});
