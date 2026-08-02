// Tests for the environment scan. The rule under test in half of these:
// paths and names travel, values never do.
import { test, expect, beforeEach, afterEach, describe } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineIdsByReadiness, envKeyNames, findOnPath, mcpServerNames, nextSteps, scanEnvironment } from './environment.mjs';

let home;
let binDir;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-home-'));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-bin-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(binDir, { recursive: true, force: true });
});

/** Puts a file where PATH will find it, with the extension this platform expects. */
function fakeCli(command) {
  const name = process.platform === 'win32' ? `${command}.CMD` : command;
  fs.writeFileSync(path.join(binDir, name), '', 'utf8');
}

function write(rel, content) {
  const target = path.join(home, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

const env = () => ({ PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

describe('findOnPath', () => {
  test('finds an executable that is there', () => {
    fakeCli('codex');
    expect(findOnPath('codex', env())).toContain(binDir);
  });

  test('returns null rather than guessing', () => {
    expect(findOnPath('definitely-not-installed', env())).toBeNull();
  });
});

describe('envKeyNames', () => {
  test('returns the names and never the values', () => {
    const file = write('.env', ['# a comment', 'OPENAI_API_KEY=sk-super-secret-value', 'export ANTHROPIC_API_KEY="also-secret"', '', 'NOT A KEY LINE'].join('\n'));
    const keys = envKeyNames(file);
    expect(keys).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
    // The point of the whole module, asserted rather than assumed.
    expect(JSON.stringify(keys)).not.toContain('secret');
  });

  test('a missing file is an empty list, not a throw', () => {
    expect(envKeyNames(path.join(home, 'nope.env'))).toEqual([]);
  });
});

describe('mcpServerNames', () => {
  test('reads the names out of a JSON config and leaves the config alone', () => {
    const file = write('.claude.json', JSON.stringify({ mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_secret' } }, filesystem: {} } }));
    const names = mcpServerNames(file);
    expect(names).toEqual(['github', 'filesystem']);
    expect(JSON.stringify(names)).not.toContain('ghp_secret');
  });

  test('reads table names out of a TOML config', () => {
    const file = write('.codex/config.toml', ['model = "gpt-5"', '', '[mcp_servers.github]', 'command = "npx"', '', '[mcp_servers."my server"]', 'command = "x"'].join('\n'));
    expect(mcpServerNames(file)).toEqual(['github', 'my server']);
  });

  test('an unparseable config is empty rather than fatal', () => {
    expect(mcpServerNames(write('.claude.json', '{not json'))).toEqual([]);
  });
});

describe('scanEnvironment', () => {
  test('reports an installed, signed-in CLI', () => {
    fakeCli('claude');
    write('.claude/.credentials.json', '{"token":"secret"}');
    const scan = scanEnvironment({ home, env: env() });
    const claude = scan.clis.find((cli) => cli.id === 'claude-code');
    expect(claude.installed).toBe(true);
    expect(claude.signedIn).toBe(true);
    expect(claude.commandPath).toContain(binDir);
    // The credentials file was never opened, so its contents cannot be here.
    expect(JSON.stringify(scan)).not.toContain('secret');
  });

  test('tells "installed" apart from "signed in"', () => {
    fakeCli('codex');
    const codex = scanEnvironment({ home, env: env() }).clis.find((cli) => cli.id === 'codex');
    expect(codex.installed).toBe(true);
    expect(codex.signedIn).toBe(false);
  });

  test('lists env files by path and key name only', () => {
    write('.env', 'FISH_AUDIO_KEY=abc123\n');
    const scan = scanEnvironment({ home, env: env() });
    expect(scan.envFiles).toHaveLength(1);
    expect(scan.envFiles[0].keys).toEqual(['FISH_AUDIO_KEY']);
    expect(scan.envFiles[0].path).toBe(path.join(home, '.env'));
    expect(JSON.stringify(scan.envFiles)).not.toContain('abc123');
  });

  test('looks at a project directory too when asked', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-project-'));
    fs.writeFileSync(path.join(project, '.env'), 'DATABASE_URL=postgres://user:pw@host/db\n', 'utf8');
    const scan = scanEnvironment({ home, env: env(), projectDirs: [project] });
    expect(scan.envFiles.map((entry) => entry.keys).flat()).toContain('DATABASE_URL');
    expect(JSON.stringify(scan)).not.toContain('postgres://');
    fs.rmSync(project, { recursive: true, force: true });
  });

  test('an empty machine is an empty answer, not an error', () => {
    const scan = scanEnvironment({ home, env: { PATH: '' } });
    expect(scan.clis.every((cli) => cli.installed === false)).toBe(true);
    expect(scan.envFiles).toEqual([]);
  });
});

describe('engineIdsByReadiness', () => {
  test('a signed-in engine is offered before one that is merely installed', () => {
    fakeCli('claude');
    fakeCli('codex');
    write('.codex/auth.json', '{}');
    // codex can actually answer; claude would ask for a login first.
    expect(engineIdsByReadiness(scanEnvironment({ home, env: env() }))).toEqual(['codex', 'claude-code']);
  });

  test('an engine that is not installed is not offered at all', () => {
    fakeCli('grok');
    expect(engineIdsByReadiness(scanEnvironment({ home, env: env() }))).toEqual(['grok']);
  });
});

describe('nextSteps', () => {
  test('an empty machine is told what kaprek needs, once', () => {
    const steps = nextSteps(scanEnvironment({ home, env: { PATH: '' } }));
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('install-a-cli');
  });

  test('an installed CLI without a login gets the command to run', () => {
    fakeCli('codex');
    const steps = nextSteps(scanEnvironment({ home, env: env() }));
    expect(steps.find((step) => step.id === 'sign-in-codex').text).toContain('`codex`');
  });

  test('one engine is named as the reason there can be no second opinion', () => {
    fakeCli('codex');
    write('.codex/auth.json', '{}');
    const steps = nextSteps(scanEnvironment({ home, env: env() }));
    expect(steps.find((step) => step.id === 'second-engine').text).toMatch(/second opinion/);
  });

  test('two signed-in engines need nothing', () => {
    fakeCli('codex');
    fakeCli('grok');
    write('.codex/auth.json', '{}');
    write('.grok/auth.json', '{}');
    expect(nextSteps(scanEnvironment({ home, env: env() }))).toEqual([]);
  });
});
