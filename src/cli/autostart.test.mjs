import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { autostartFile, autostartPath, install, launchCommand, status, uninstall } from './autostart.mjs';

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-autostart-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const env = () => ({ APPDATA: path.join(home, 'AppData', 'Roaming') });

describe('autostartPath', () => {
  test('one known place per platform', () => {
    expect(autostartPath('win32', home, env())).toContain('Startup');
    expect(autostartPath('darwin', home, {})).toContain('LaunchAgents');
    expect(autostartPath('linux', home, {})).toContain('.config');
  });

  test('an unknown platform gets null rather than a guess', () => {
    expect(autostartPath('aix', home, {})).toBeNull();
  });
});

describe('autostartFile', () => {
  test('always passes --no-open', () => {
    // Something starting with the machine must not throw a browser window at
    // whoever just logged in.
    for (const platform of ['win32', 'darwin', 'linux']) {
      expect(autostartFile({ platform, command: 'kaprek' })).toContain('--no-open');
    }
  });

  test('carries extra arguments through', () => {
    expect(autostartFile({ platform: 'linux', command: 'kaprek', args: ['--lan'] })).toContain('--lan');
  });
});

describe('launchCommand', () => {
  test('windows calls the shim npm put on PATH', () => {
    expect(launchCommand({ platform: 'win32' })).toEqual({ command: 'kaprek', args: [] });
  });

  test('elsewhere it calls node with the script, which survives a login PATH', () => {
    const result = launchCommand({ platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/opt/kaprek/bin/cli.mjs' });
    expect(result).toEqual({ command: '/usr/bin/node', args: ['/opt/kaprek/bin/cli.mjs'] });
  });
});

describe('install, status, uninstall', () => {
  test('writes exactly one file, and status prints its path', () => {
    const installed = install({ platform: 'linux', home, env: {}, scriptPath: '/opt/kaprek/bin/cli.mjs' });
    expect(fs.existsSync(installed.path)).toBe(true);

    const state = status({ platform: 'linux', home, env: {} });
    expect(state.installed).toBe(true);
    // A tool that puts something in your startup folder owes you the path
    // AND the contents.
    expect(state.path).toBe(installed.path);
    expect(state.contents).toContain('--no-open');
  });

  test('uninstall removes that file and says whether there was one', () => {
    install({ platform: 'linux', home, env: {}, scriptPath: '/x/cli.mjs' });
    expect(uninstall({ platform: 'linux', home, env: {} }).removed).toBe(true);
    expect(uninstall({ platform: 'linux', home, env: {} }).removed).toBe(false);
    expect(status({ platform: 'linux', home, env: {} }).installed).toBe(false);
  });

  test('installing twice is not an error and leaves one file', () => {
    install({ platform: 'linux', home, env: {}, scriptPath: '/x/cli.mjs' });
    const second = install({ platform: 'linux', home, env: {}, scriptPath: '/x/cli.mjs' });
    expect(fs.readdirSync(path.dirname(second.path))).toHaveLength(1);
  });

  test('an unsupported platform refuses rather than writing somewhere random', () => {
    expect(() => install({ platform: 'aix', home, env: {}, scriptPath: '/x' })).toThrow(/does not know where/);
    expect(status({ platform: 'aix', home, env: {} }).supported).toBe(false);
  });
});

describe('what Codex found', () => {
  test('a path with & or < does not break the plist', () => {
    const file = autostartFile({ platform: 'darwin', command: '/opt/tools & things/<node>' });
    expect(file).toContain('&amp;');
    expect(file).toContain('&lt;node&gt;');
    // The raw characters would make the XML invalid or change what it says.
    expect(file).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;)/);
  });

  test('a path with spaces or a field code survives the .desktop Exec line', () => {
    const file = autostartFile({ platform: 'linux', command: '/home/someone/my tools/kaprek %f' });
    // Quoted, and % doubled — an unquoted space splits arguments and %f is a
    // field code the desktop replaces with a filename.
    expect(file).toMatch(/Exec="[^"]*my tools[^"]*"/);
    expect(file).toContain('%%f');
  });

  test('uninstall leaves a file kaprek did not write', () => {
    const target = autostartPath('linux', home, {});
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '[Desktop Entry]\nName=something else\n', 'utf8');

    const result = uninstall({ platform: 'linux', home, env: {} });
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/not written by kaprek/);
    expect(fs.existsSync(target)).toBe(true);
  });

  test('and still removes its own', () => {
    install({ platform: 'linux', home, env: {}, scriptPath: '/x/cli.mjs' });
    expect(uninstall({ platform: 'linux', home, env: {} }).removed).toBe(true);
  });
});

describe('a second, named entry (kaprek proxy)', () => {
  test('lives next to kaprek.cmd under its own name and leaves kaprek.cmd alone', () => {
    install({ platform: 'win32', home, env: env(), scriptPath: 'x' });
    const proxy = install({ platform: 'win32', home, env: env(), scriptPath: 'x', extraArgs: ['proxy'], entry: 'kaprek-proxy', noOpen: false });
    expect(path.basename(proxy.path)).toBe('kaprek-proxy.cmd');
    const text = fs.readFileSync(proxy.path, 'utf8');
    // The subcommand must come first, or the CLI never sees `proxy`.
    expect(text).toContain('start "" /min "kaprek" "proxy"');
    expect(text).not.toContain('--no-open');
    expect(status({ platform: 'win32', home, env: env(), entry: 'kaprek-proxy' }).installed).toBe(true);
    expect(uninstall({ platform: 'win32', home, env: env(), entry: 'kaprek-proxy' }).removed).toBe(true);
    expect(status({ platform: 'win32', home, env: env() }).installed).toBe(true);
  });

  test('gets its own launchd label on macOS', () => {
    const proxy = install({ platform: 'darwin', home, env: {}, scriptPath: '/x/cli.mjs', extraArgs: ['proxy'], entry: 'kaprek-proxy', noOpen: false });
    expect(path.basename(proxy.path)).toBe('com.kaprek.kaprek-proxy.plist');
    expect(fs.readFileSync(proxy.path, 'utf8')).toContain('<string>com.kaprek.kaprek-proxy</string>');
  });
});
