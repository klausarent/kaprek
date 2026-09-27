// Tests for the GLM (ZCode) peer driver. Run: npx vitest run src/harness/peers/glm.test.mjs
//
// No real CLI is ever spawned: a peer turn costs a Coding Plan turn and needs
// an account, so every test here drives a node script standing in for
// zcode.cjs, the same way grok.test.mjs fakes the grok binary.
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import {
  GLM_ATTACHMENT_MAX_BYTES,
  GLM_ATTACHMENT_MIN_BYTES,
  GLM_AUDIT_LOG_MAX_BYTES,
  GLM_DISALLOWED_TOOLS,
  GLM_MAX_PROMPT_BYTES,
  GLM_TOOL_AUDIT_SKIP_ENV,
  KNOWN_SAFE_MCP,
  buildGlmArgs,
  buildGlmChildEnv,
  buildGlmInstruction,
  chunkPromptForZcode,
  defaultZcodeCjsPath,
  effectiveDisallowedTools,
  glmDriver,
  killTree,
  parseGlmStdout,
  providerConfigPathFor,
  resetGlmPreflightCacheForTests,
  resolveZcodeCli,
  runGlmTurn,
  toolNamesForSession,
} from './glm.mjs';
import { PEER_MAX_STDOUT_BYTES, PEER_OUTPUT_SCHEMA, parsePeerAnswer } from './driver.mjs';

const dirs = [];
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-peer-test-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  // A pre-flight cached by an EARLIER test would otherwise silently decide
  // a LATER one — the cache is per-process, and vitest runs a file's tests
  // in one process.
  resetGlmPreflightCacheForTests();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows releases a killed process's handles a moment after the kill,
      // so a directory that held one can still be EBUSY here. It is a temp
      // directory: the OS will get it. Failing the test over it would report
      // a platform quirk as a defect in the code under test.
    }
  }
});

/** Stands in for the ZCode CLI: a node script that gets the same argv the real one would. */
function fakeCli(script) {
  // The driver's args go after `--` so node hands them to the script instead
  // of trying to interpret --attach as one of its own options.
  return (_command, args, options) =>
    spawn(process.execPath, ['-e', script, '--', ...args], { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
}

const envelope = (status, message, extra = {}) =>
  JSON.stringify({ response: JSON.stringify({ status, message }), usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 }, sessionId: 'sess_x', turnId: 1, ...extra });

/** A `plugins list`/turn-agnostic fake CLI: whatever it is asked (metadata call or real turn), it answers the same clean envelope — the pre-flight's own parser finds zero plugin blocks in that text, which passes trivially. */
function fakeCliAnswering(status, message, extra = {}) {
  return fakeCli(`process.stdout.write(${JSON.stringify(envelope(status, message, extra))})`);
}

/** A safe ZCode CLI config: no plugins enabled, no user-level MCP servers. */
function writeSafeZcodeConfig(dir) {
  const p = path.join(dir, 'zcode-config.json');
  fs.writeFileSync(p, JSON.stringify({ plugins: { enabledPlugins: {} } }), 'utf8');
  return p;
}

/** The options every "this should just succeed" test needs beyond cwd/prompt/logDir/spawnFn: a fake CLI path, the post-turn audit skipped (it has its own dedicated tests below), and a config.json that passes the pre-flight. */
function happyOptions(dir, envExtra = {}) {
  return {
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs'), [GLM_TOOL_AUDIT_SKIP_ENV]: '1', ...envExtra },
    zcodeConfigPath: writeSafeZcodeConfig(dir),
  };
}

function writeSessionLog(dir, lines, { date = new Date() } = {}) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const filePath = path.join(dir, `zcode-${y}-${m}-${d}.jsonl`);
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  return filePath;
}

test('the -p instruction carries the schema, and the prompt travels as attachments, never on the instruction line', () => {
  const args = buildGlmArgs({ instruction: buildGlmInstruction(PEER_OUTPUT_SCHEMA, 2), attachmentPaths: ['C:/tmp/a1.txt', 'C:/tmp/a2.txt'], cwd: 'C:/work' });
  expect(args[0]).toBe('-p');
  expect(args[1]).toContain(JSON.stringify(PEER_OUTPUT_SCHEMA));
  const attachIndexes = args.reduce((acc, arg, idx) => (arg === '--attach' ? [...acc, idx] : acc), []);
  expect(attachIndexes.map((idx) => args[idx + 1])).toEqual(['C:/tmp/a1.txt', 'C:/tmp/a2.txt']);
});

test('the flag line pins plan mode, json output, and the full disallowed-tools list — never yolo', () => {
  const args = buildGlmArgs({ instruction: 'go', cwd: 'C:/work' });
  const flag = (name) => args[args.indexOf(name) + 1];
  expect(flag('--mode')).toBe('plan');
  expect(args).toContain('--json');
  for (const tool of GLM_DISALLOWED_TOOLS.split(' ')) {
    expect(flag('--disallowed-tools').split(' ')).toContain(tool);
  }
  expect(flag('--cwd')).toBe('C:/work');
  expect(args.join(' ')).not.toMatch(/yolo/);
});

test('effectiveDisallowedTools extends the base list from KAPREK_GLM_EXTRA_DISALLOWED, space-separated', () => {
  expect(effectiveDisallowedTools({ KAPREK_GLM_EXTRA_DISALLOWED: 'mcp__foo__bar mcp__baz__qux' })).toBe(`${GLM_DISALLOWED_TOOLS} mcp__foo__bar mcp__baz__qux`);
  expect(effectiveDisallowedTools({})).toBe(GLM_DISALLOWED_TOOLS);
  expect(effectiveDisallowedTools({ KAPREK_GLM_EXTRA_DISALLOWED: '  ' })).toBe(GLM_DISALLOWED_TOOLS);
});

// ---- minimal child env (P1a) ----

test('buildGlmChildEnv passes only the allowlist plus ZCODE_* — secrets like tokens never reach the child', () => {
  const child = buildGlmChildEnv({
    PATH: 'C:/Windows;C:/Windows/System32',
    SystemRoot: 'C:/Windows',
    TEMP: 'C:/Temp',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/x/zcode-builtin.json',
    ZCODE_SOMETHING_ELSE: 'ok',
    GITHUB_TOKEN: 'ghp_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    OPENAI_API_KEY: 'sk-secret',
    KAPREK_ZCODE_PATH: 'C:/somewhere/zcode.cjs',
    HOME: '/home/x',
  });
  expect(child).toMatchObject({
    PATH: 'C:/Windows;C:/Windows/System32',
    SystemRoot: 'C:/Windows',
    TEMP: 'C:/Temp',
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/x/zcode-builtin.json',
    ZCODE_SOMETHING_ELSE: 'ok',
    HOME: '/home/x',
  });
  expect(child).not.toHaveProperty('GITHUB_TOKEN');
  expect(child).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(child).not.toHaveProperty('OPENAI_API_KEY');
  // KAPREK_ zcode-side control vars are for THIS driver's own logic, not for
  // the child process — they must not leak through either.
  expect(child).not.toHaveProperty('KAPREK_ZCODE_PATH');
});

test('the actually spawned child env is the minimal allowlist, not process.env', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: JSON.stringify(Object.keys(process.env).sort()) }), sessionId: 'sess_x' }));`;
  let seenOptions = null;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'plugins-list-noise')(command, args, options);
    seenOptions = options;
    return fakeCli(script)(command, args, options);
  };
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    ...happyOptions(dir, { GITHUB_TOKEN: 'ghp_secret', ANTHROPIC_API_KEY: 'sk-ant-secret' }),
    spawnFn,
  });
  const keys = JSON.parse(result.message);
  expect(keys).not.toContain('GITHUB_TOKEN');
  expect(keys).not.toContain('ANTHROPIC_API_KEY');
  expect(seenOptions.env).not.toHaveProperty('GITHUB_TOKEN');
});

// ---- pre-flight: plugins list + config.json (P1a) ----

test('parsePluginsList / auditPluginsList: an enabled plugin with a non-none MCP id not in KNOWN_SAFE_MCP refuses the turn', async () => {
  const dir = tmpDir();
  const pluginsListing = [
    '- android-emulator@zcode-plugins-official [enabled]',
    '  skills: 1, commands: 1, hooks: 0, mcp: plugin:android-emulator:android-emulator',
  ].join('\n');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify(pluginsListing)})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn }),
  ).rejects.toThrow(/pre-flight refused.*android-emulator.*MCP/s);
});

test('an enabled plugin with hooks > 0 refuses the turn even with mcp: none', async () => {
  const dir = tmpDir();
  const pluginsListing = ['- some-plugin@src [enabled]', '  skills: 0, commands: 0, hooks: 2, mcp: none'].join('\n');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify(pluginsListing)})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn })).rejects.toThrow(/pre-flight refused.*some-plugin.*hook/s);
});

test('a disabled plugin with mcp and hooks is not inspected — nothing enabled can run it', async () => {
  const dir = tmpDir();
  const pluginsListing = ['- android-emulator@zcode-plugins-official [disabled]', '  skills: 1, commands: 1, hooks: 3, mcp: plugin:android-emulator:android-emulator'].join('\n');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify(pluginsListing)})`)(command, args, options);
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  const result = await runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn });
  expect(result.status).toBe('done');
});

test('KNOWN_SAFE_MCP is empty by default, and an explicitly allowed mcp id passes', async () => {
  expect(KNOWN_SAFE_MCP).toEqual([]);
  const dir = tmpDir();
  const pluginsListing = ['- vetted-plugin@src [enabled]', '  skills: 1, commands: 0, hooks: 0, mcp: plugin:vetted:vetted'].join('\n');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify(pluginsListing)})`)(command, args, options);
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  const result = await runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn, knownSafeMcp: ['plugin:vetted:vetted'] });
  expect(result.status).toBe('done');
});

test('the pre-flight is cached for the process — two turns within the cache window spawn "plugins list" only once', async () => {
  const dir = tmpDir();
  let pluginsListCalls = 0;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) {
      pluginsListCalls += 1;
      return fakeCli(`process.stdout.write(${JSON.stringify('')})`)(command, args, options);
    }
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  const opts = happyOptions(dir);
  await runGlmTurn({ cwd: dir, prompt: 'go 1', logDir: dir, ...opts, spawnFn });
  await runGlmTurn({ cwd: dir, prompt: 'go 2', logDir: dir, ...opts, spawnFn });
  expect(pluginsListCalls).toBe(1);
});

test('a refusal from config.json (not from plugins list) still surfaces even after a passing plugins-list cache entry from a DIFFERENT config path', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify('')})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  const unsafeConfig = path.join(dir, 'unsafe-config.json');
  fs.writeFileSync(unsafeConfig, JSON.stringify({ mcpServers: { evil: { command: 'node' } } }), 'utf8');
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), zcodeConfigPath: unsafeConfig, spawnFn }),
  ).rejects.toThrow(/mcpServers.*evil/s);
});

test('config.json defining mcpServers nested under an arbitrary key still refuses the turn', async () => {
  const dir = tmpDir();
  const nested = path.join(dir, 'nested-config.json');
  fs.writeFileSync(nested, JSON.stringify({ some: { deeply: { nested: { mcpServers: { evil: {} } } } } }), 'utf8');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify('')})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), zcodeConfigPath: nested, spawnFn }),
  ).rejects.toThrow(/mcpServers.*evil/s);
});

test('an unreadable config.json fails the pre-flight closed', async () => {
  const dir = tmpDir();
  const missing = path.join(dir, 'does-not-exist.json');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify('')})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), zcodeConfigPath: missing, spawnFn }),
  ).rejects.toThrow(/could not read/);
});

test('a malformed config.json fails the pre-flight closed', async () => {
  const dir = tmpDir();
  const malformed = path.join(dir, 'malformed-config.json');
  fs.writeFileSync(malformed, '{not json', 'utf8');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli(`process.stdout.write(${JSON.stringify('')})`)(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(
    runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), zcodeConfigPath: malformed, spawnFn }),
  ).rejects.toThrow(/malformed/);
});

test('a "plugins list" call that itself fails refuses the turn rather than assuming it would have passed', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCli('process.stderr.write("boom"); process.exit(1);')(command, args, options);
    return fakeCliAnswering('done', 'should not be reached')(command, args, options);
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn })).rejects.toThrow(/pre-flight exited with code 1/);
});

// ---- chunking (point 7 from round 1) ----

test('chunkPromptForZcode packs the prompt into headered parts that fit the attachment cap', () => {
  const lines = [];
  for (let i = 0; i < 2000; i += 1) lines.push(`line ${i} `.repeat(50));
  const prompt = lines.join('\n');
  const parts = chunkPromptForZcode(prompt);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MAX_BYTES);
  parts.forEach((part, idx) => expect(part.startsWith(`[Teil ${idx + 1} von ${parts.length}]\n`)).toBe(true));
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('a single line longer than the attachment cap is hard-split, never dropped', () => {
  const longLine = 'x'.repeat(GLM_ATTACHMENT_MAX_BYTES * 2 + 500);
  const prompt = `intro\n${longLine}\noutro`;
  const parts = chunkPromptForZcode(prompt);
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MAX_BYTES);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('a prompt that fits in one attachment is not split needlessly', () => {
  const parts = chunkPromptForZcode('short prompt\nwith two lines');
  expect(parts).toEqual(['[Teil 1 von 1]\nshort prompt\nwith two lines']);
});

test('an attachment cap below the minimum is refused rather than risking a stuck or corrupt chunk', () => {
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES - 1 })).toThrow(new RegExp(String(GLM_ATTACHMENT_MIN_BYTES)));
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: 100 })).toThrow(new RegExp(String(GLM_ATTACHMENT_MIN_BYTES)));
  expect(() => chunkPromptForZcode('hello', { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES })).not.toThrow();
});

test('supplementary-plane characters (emoji) survive exactly even when they land on a chunk boundary', () => {
  const emoji = '😀🚀🔥🎉👍';
  const line = 'a'.repeat(50) + emoji.repeat(4000);
  const parts = chunkPromptForZcode(line, { attachmentMaxBytes: 2048 });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(2048);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(line);
  expect(rebuilt).not.toContain('\uFFFD');
});

test('CRLF line endings round-trip exactly, each \\r staying attached to its own line', () => {
  const prompt = ['line one', 'line two', 'line three'].join('\r\n');
  const parts = chunkPromptForZcode(prompt);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
});

test('dense short lines pack right up to the boundary without ever splitting one in half', () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `L${i}`);
  const prompt = lines.join('\n');
  const parts = chunkPromptForZcode(prompt, { attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(GLM_ATTACHMENT_MIN_BYTES);
  const rebuilt = parts.map((part) => part.slice(part.indexOf('\n') + 1)).join('');
  expect(rebuilt).toBe(prompt);
  parts.slice(0, -1).forEach((part) => {
    const body = part.slice(part.indexOf('\n') + 1);
    expect(body.endsWith('\n')).toBe(true);
  });
});

// ---- CLI resolution ----

test('resolveZcodeCli spawns node against the resolved entry unless the override is an .exe', () => {
  expect(resolveZcodeCli({ KAPREK_ZCODE_PATH: 'C:/tools/zcode/resources/glm/zcode.cjs' })).toEqual({
    command: process.execPath,
    argsPrefix: ['C:/tools/zcode/resources/glm/zcode.cjs'],
    entryPath: 'C:/tools/zcode/resources/glm/zcode.cjs',
  });
  expect(resolveZcodeCli({ KAPREK_ZCODE_PATH: 'C:/tools/zcode/resources/glm/zcode.exe' })).toEqual({
    command: 'C:/tools/zcode/resources/glm/zcode.exe',
    argsPrefix: [],
    entryPath: 'C:/tools/zcode/resources/glm/zcode.exe',
  });
});

test('the default entry path is built from LOCALAPPDATA, falling back rather than throwing when it is missing', () => {
  expect(defaultZcodeCjsPath({ LOCALAPPDATA: 'C:/Users/x/AppData/Local' })).toBe(path.join('C:/Users/x/AppData/Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  expect(() => defaultZcodeCjsPath({})).not.toThrow();
});

test('the provider config path sits next to the entry, one level up from resources/glm', () => {
  expect(providerConfigPathFor('C:/x/resources/glm/zcode.cjs')).toBe(path.join('C:/x/resources/glm', '..', 'config', 'provider', 'zcode-builtin.json'));
});

// ---- happy path / wiring ----

test('a well-formed turn comes back as status, message, usage and a null (never zero) cost', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'plugins-list-noise')(command, args, options);
    return fakeCliAnswering('handoff', 'here is the draft')(command, args, options);
  };
  const result = await runGlmTurn({ cwd: dir, prompt: 'write something', logDir: dir, ...happyOptions(dir), spawnFn });

  expect(result).toMatchObject({ status: 'handoff', message: 'here is the draft', costUsd: null });
  expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, totalTokens: 12 });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);
  expect(result.sessionId).toBeUndefined(); // internal bookkeeping only, never leaked into the PeerTurnResult
  expect(fs.readFileSync(result.rawLogPath, 'utf8')).toContain('--- stdout ---');
});

test('the attachment files are cleaned up, so a draft does not linger in temp — the raw log is kept', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  const result = await runGlmTurn({ cwd: dir, prompt: 'secret draft', logDir: dir, ...happyOptions(dir), spawnFn });
  const turnDir = path.dirname(result.rawLogPath);
  expect(fs.readdirSync(turnDir).filter((name) => name.startsWith('glm-prompt-'))).toEqual([]);
  expect(fs.existsSync(result.rawLogPath)).toBe(true);
});

test('the provider config env var is injected for the child unless the caller already set one', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }), sessionId: 'sess_x' }));`;
  const entryPath = 'C:/fake/resources/glm/zcode.cjs';
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli(script)(command, args, options);
  };
  const result = await runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir, { KAPREK_ZCODE_PATH: entryPath }), spawnFn });
  expect(result.message).toBe(providerConfigPathFor(entryPath));
});

test('an env var the caller already set is never overwritten', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write(JSON.stringify({ response: JSON.stringify({ status: 'done', message: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' }), sessionId: 'sess_x' }));`;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli(script)(command, args, options);
  };
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    ...happyOptions(dir, { KAPREK_ZCODE_PATH: 'C:/fake/resources/glm/zcode.cjs', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: 'C:/already/set.json' }),
    spawnFn,
  });
  expect(result.message).toBe('C:/already/set.json');
});

test('the actual spawned argv pins plan mode, json, the full disallowed-tools list and a fresh --cwd — the caller\'s cwd is ignored', async () => {
  const dir = tmpDir();
  let seenArgs = null;
  let seenOptions = null;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    seenArgs = args;
    seenOptions = options;
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  await runGlmTurn({ cwd: 'C:/some/mission/tree', prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn });

  expect(seenArgs[seenArgs.indexOf('--mode') + 1]).toBe('plan');
  expect(seenArgs).toContain('--json');
  expect(seenArgs[seenArgs.indexOf('--disallowed-tools') + 1]).toBe(GLM_DISALLOWED_TOOLS);
  expect(seenArgs.join(' ')).not.toMatch(/yolo/);

  const cwdIdx = seenArgs.indexOf('--cwd');
  expect(cwdIdx).toBeGreaterThan(-1);
  const scratchCwd = seenArgs[cwdIdx + 1];
  expect(scratchCwd).not.toBe('C:/some/mission/tree');
  expect(seenOptions.cwd).toBe(scratchCwd);
  expect(path.dirname(scratchCwd)).toBe(dir);
  expect(fs.existsSync(scratchCwd)).toBe(true);
});

test('KAPREK_GLM_EXTRA_DISALLOWED reaches the actual argv', async () => {
  const dir = tmpDir();
  let seenArgs = null;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    seenArgs = args;
    return fakeCliAnswering('done', 'ok')(command, args, options);
  };
  await runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir, { KAPREK_GLM_EXTRA_DISALLOWED: 'mcp__foo__bar' }), spawnFn });
  expect(seenArgs[seenArgs.indexOf('--disallowed-tools') + 1]).toBe(`${GLM_DISALLOWED_TOOLS} mcp__foo__bar`);
});

test('a multibyte character split across two data events decodes correctly instead of corrupting at the boundary', async () => {
  const dir = tmpDir();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.kill = () => {};

  const message = 'emoji: \u{1F600} done';
  const full = Buffer.from(envelope('done', message), 'utf8');
  const text = full.toString('utf8');
  const emojiByteIndex = Buffer.byteLength(text.slice(0, text.indexOf('\u{1F600}')), 'utf8');
  const splitAt = emojiByteIndex + 2; // inside the emoji's 4-byte UTF-8 sequence

  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return child;
  };

  const pending = runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn });

  stdout.write(full.subarray(0, splitAt));
  stdout.write(full.subarray(splitAt));
  stdout.end();
  stderr.end();
  await new Promise((resolve) => stdout.on('end', resolve));
  child.emit('close', 0);

  const result = await pending;
  expect(result.message).toBe(message);
});

// ---- envelope parsing (point 6 from round 1) ----

test('stdout is read via a balanced-brace scan, so a log line ahead of the JSON envelope does not break the parse', () => {
  const stdout = `ZCode Built-in skipped (not-due)\n${envelope('done', 'ignored the log line')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'ignored the log line' });
});

test('a brace inside a log line (not starting the line) does not derail the parse', () => {
  const stdout = `Warning: token cache miss for key {abc}\n${envelope('done', 'real answer')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'real answer' });
});

test('a diagnostic JSON line without a "response" field is skipped in favor of the real envelope', () => {
  const diagnostic = JSON.stringify({ type: 'diagnostic', level: 'info', dueAt: null });
  const stdout = `${diagnostic}\n${envelope('handoff', 'the real answer')}`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'handoff', message: 'the real answer' });
});

test('a trailing line after the envelope does not break the parse', () => {
  const stdout = `${envelope('done', 'answer before the trailing noise')}\nZCode Built-in: session saved`;
  const parsed = parseGlmStdout(stdout);
  expect(parsed).toMatchObject({ status: 'done', message: 'answer before the trailing noise' });
});

test('a fenced ```json answer is unwrapped before it is parsed', () => {
  const fenced = '```json\n{"status":"done","message":"fenced"}\n```';
  const parsed = parseGlmStdout(JSON.stringify({ response: fenced, usage: null }));
  expect(parsed).toMatchObject({ status: 'done', message: 'fenced' });
});

test('a missing cost stays null, and the CLI never reports one to pass through', () => {
  const parsed = parseGlmStdout(JSON.stringify({ response: JSON.stringify({ status: 'done', message: 'ok' }) }));
  expect(parsed.costUsd).toBeNull();
});

test('an answer that ignores the schema fails the turn rather than being guessed at', () => {
  expect(() => parseGlmStdout(JSON.stringify({ response: '{"message":"no status here"}' }))).toThrow(/status/);
  expect(() => parseGlmStdout('no JSON here at all')).toThrow(/did not print JSON/);
  expect(() => parseGlmStdout('')).toThrow(/did not print JSON/);
  expect(() => parseGlmStdout('garbled {not json')).toThrow(/did not print JSON/);
});

test('a non-validating (council) parse takes the response as-is instead of enforcing the relay shape', () => {
  const parsed = parseGlmStdout(JSON.stringify({ response: '{"verdict":"agree","summary":"looks fine"}' }), { validate: false });
  expect(parsed.status).toBe('done');
  expect(parsed.message).toBe('{"verdict":"agree","summary":"looks fine"}');
});

// ---- resource limits ----

test('stdout past the cap ends the turn cleanly instead of buffering a runaway CLI', async () => {
  const dir = tmpDir();
  const script = `process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000);`;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli(script)(command, args, options);
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn })).rejects.toThrow(new RegExp(`more than ${PEER_MAX_STDOUT_BYTES} bytes`));
});

test('a peer that never answers is killed at the timeout rather than held forever', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli('setInterval(() => {}, 1000)')(command, args, options);
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', timeoutMs: 1_000, logDir: dir, ...happyOptions(dir), spawnFn })).rejects.toThrow(/did not answer within 1000ms/);
});

test('an abort signal ends the turn at once', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli('setTimeout(() => {}, 30000)')(command, args, options);
  };
  const pending = runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, signal: controller.signal, ...happyOptions(dir), spawnFn });
  controller.abort();
  await expect(pending).rejects.toThrow(/stopped/);
});

test('an already-aborted signal is refused before any scratch directory is created or anything is spawned', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  controller.abort();
  const spawnFn = () => {
    throw new Error('must not spawn');
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, signal: controller.signal, ...happyOptions(dir), spawnFn })).rejects.toThrow(/stopped/);
  // happyOptions() itself drops a zcode-config.json fixture into `dir` for
  // the pre-flight to read — what must be absent is a TURN directory, since
  // that is the artifact runGlmTurn's own abort check must have skipped.
  expect(fs.readdirSync(dir).filter((name) => name.startsWith('kaprek-glm-turn-'))).toEqual([]);
});

test('a non-zero exit is reported with what the CLI said on stderr', async () => {
  const dir = tmpDir();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli('process.stderr.write("not authenticated"); process.exit(3)')(command, args, options);
  };
  await expect(runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, ...happyOptions(dir), spawnFn })).rejects.toThrow(/exited with code 3.*not authenticated/s);
});

test('an empty prompt is refused before anything is spawned', async () => {
  await expect(runGlmTurn({ cwd: tmpDir(), prompt: '   ' })).rejects.toThrow(/needs a prompt/);
});

test('a prompt above the limit is refused before anything is spawned', async () => {
  const spawnFn = () => {
    throw new Error('must not spawn');
  };
  await expect(runGlmTurn({ cwd: tmpDir(), prompt: 'p'.repeat(GLM_MAX_PROMPT_BYTES + 1), spawnFn })).rejects.toThrow(/GLM_MAX_PROMPT_BYTES/);
});

test('available() is a file check, never a spawn', () => {
  const dir = tmpDir();
  const realEntry = path.join(dir, 'zcode.cjs');
  fs.writeFileSync(realEntry, '// stand-in\n', 'utf8');
  expect(glmDriver.available({ KAPREK_ZCODE_PATH: realEntry })).toBe(true);
  expect(glmDriver.available({ KAPREK_ZCODE_PATH: path.join(dir, 'does-not-exist.cjs') })).toBe(false);
});

test('the driver declares the same prompt limit consult.mjs trims to, mirroring the grok mechanism', () => {
  expect(glmDriver.maxPromptBytes).toBe(GLM_MAX_PROMPT_BYTES);
  expect(glmDriver.id).toBe('glm');
});

// ---- killTree order (round 1, point 1) ----

test.skipIf(process.platform !== 'win32')('killTree runs taskkill BEFORE child.kill(), windowsHide, and awaits it', async () => {
  const order = [];
  const child = { pid: 4242, kill: () => order.push('child.kill') };
  const taskkillChild = new EventEmitter();
  const spawnFn = (command, args, options) => {
    order.push('taskkill.spawn');
    expect(command).toBe('taskkill');
    expect(args).toEqual(['/pid', '4242', '/t', '/f']);
    expect(options.windowsHide).toBe(true);
    setImmediate(() => taskkillChild.emit('close', 0));
    return taskkillChild;
  };
  await killTree(child, { spawnFn });
  expect(order).toEqual(['taskkill.spawn', 'child.kill']);
});

test.skipIf(process.platform !== 'win32')('killTree still calls child.kill() when the taskkill helper fails to start', async () => {
  const child = { pid: 4242, kill: vi.fn() };
  const spawnFn = () => {
    throw new Error('taskkill.exe not found');
  };
  await killTree(child, { spawnFn });
  expect(child.kill).toHaveBeenCalled();
});

test.skipIf(process.platform !== 'win32')('killTree still calls child.kill() when the taskkill helper itself errors out', async () => {
  const child = { pid: 4242, kill: vi.fn() };
  const taskkillChild = new EventEmitter();
  const spawnFn = () => {
    setImmediate(() => taskkillChild.emit('error', new Error('ENOENT')));
    return taskkillChild;
  };
  await killTree(child, { spawnFn });
  expect(child.kill).toHaveBeenCalled();
});

// ---- termination idempotency (round 2, P2) ----

test('an abort that beats a short timeout keeps "stopped" as the reason, even once the timeout also fires', async () => {
  const dir = tmpDir();
  const controller = new AbortController();
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli('setTimeout(() => {}, 30000)')(command, args, options);
  };
  const pending = runGlmTurn({ cwd: dir, prompt: 'go', timeoutMs: 50, logDir: dir, signal: controller.signal, ...happyOptions(dir), spawnFn });
  controller.abort();
  await expect(pending).rejects.toThrow(/stopped/);
});

test('overflow and abort arriving together only terminate once — no second killTree call', async () => {
  const dir = tmpDir();
  let killCount = 0;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.pid = 4242;
  child.kill = () => {
    killCount += 1;
  };

  const controller = new AbortController();
  let resolveSpawned;
  const spawned = new Promise((resolve) => {
    resolveSpawned = resolve;
  });
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    resolveSpawned();
    return child;
  };
  const pending = runGlmTurn({ cwd: dir, prompt: 'go', logDir: dir, signal: controller.signal, ...happyOptions(dir), spawnFn });

  // Wait until the main turn's child actually exists (the pre-flight's own
  // spawn happens first) before racing overflow against abort — otherwise
  // both would-be triggers fire before there is even a child to terminate.
  await spawned;
  stdout.write(Buffer.alloc(PEER_MAX_STDOUT_BYTES + 10, 'x'));
  controller.abort();

  await expect(pending).rejects.toThrow(/stopped|more than/);
  expect(killCount).toBe(1);
});

// ---- attachment cleanup on partial write failure (round 2, P2) ----

test('a failure writing the 2nd attachment leaves nothing behind — the 1st is still cleaned up', async () => {
  const dir = tmpDir();
  const prompt = 'y'.repeat(3000);
  let writeCount = 0;
  const realWriteFileSync = fs.writeFileSync;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    if (String(args[0]).includes('glm-prompt-')) {
      writeCount += 1;
      if (writeCount === 2) throw new Error('disk full (simulated)');
    }
    return realWriteFileSync(...args);
  });
  try {
    await expect(
      runGlmTurn({
        cwd: dir,
        prompt,
        logDir: dir,
        attachmentMaxBytes: GLM_ATTACHMENT_MIN_BYTES,
        ...happyOptions(dir),
        spawnFn: (command, args, options) => {
          if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
          throw new Error('must not spawn — the 2nd attachment write fails before any spawn for the main turn');
        },
      }),
    ).rejects.toThrow(/disk full/);
    const created = fs.readdirSync(dir).filter((name) => name.startsWith('kaprek-glm-turn-'));
    expect(created).toHaveLength(1);
    const turnDir = path.join(dir, created[0]);
    expect(fs.readdirSync(turnDir).filter((name) => name.startsWith('glm-prompt-'))).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

// ---- post-turn tool audit (round 1 point 9B, hardened round 2 P1b) ----

test('a clean session (log has a line for it, none with a toolName) passes the post-turn audit', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  writeSessionLog(logDir, [
    { sessionId: 'sess_clean', event: 'turn.start' },
    { sessionId: 'sess_other', toolName: 'Bash' }, // a different session's tool call must not taint this one
  ]);
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_clean' })(command, args, options);
  };
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    zcodeLogDir: logDir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
    zcodeConfigPath: writeSafeZcodeConfig(dir),
    spawnFn,
  });
  expect(result.status).toBe('done');
});

test('a session whose log shows a tool call fails the turn — the answer is discarded', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  writeSessionLog(logDir, [
    { sessionId: 'sess_bad', toolName: 'Bash' },
    { sessionId: 'sess_bad', toolName: 'ExitPlanMode' },
  ]);
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_bad' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/invoked tools: Bash, ExitPlanMode/);
});

test('a log file that exists but never mentions this sessionId fails closed — a file is not the same as evidence', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  writeSessionLog(logDir, [{ sessionId: 'sess_someone_else', event: 'turn.start' }]);
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_absent' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/no evidence for session/);
});

test('a malformed JSON line that mentions the sessionId fails the audit closed rather than being skipped', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const y = new Date().getFullYear();
  const m = String(new Date().getMonth() + 1).padStart(2, '0');
  const d = String(new Date().getDate()).padStart(2, '0');
  fs.writeFileSync(path.join(logDir, `zcode-${y}-${m}-${d}.jsonl`), 'this line mentions sess_garbled but is not json\n', 'utf8');
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_garbled' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/not valid JSON/);
});

test('a missing session log fails the turn closed rather than trusting the answer', async () => {
  const dir = tmpDir();
  const logDir = tmpDir(); // empty — no log file for either relevant date
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_missing' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/no evidence for session/);
});

test('a log file over the byte cap fails the audit closed rather than being streamed regardless', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const filePath = writeSessionLog(logDir, [{ sessionId: 'sess_big', event: 'ok' }]);
  fs.appendFileSync(filePath, `${'x'.repeat(200)}\n`.repeat(50), 'utf8');
  const oversizeCap = fs.statSync(filePath).size - 1;
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_big' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      auditLogMaxBytes: oversizeCap,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/over the .*-byte audit cap/);
});

test('an audit that runs out of its time budget fails closed', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const lines = Array.from({ length: 500 }, (_, i) => ({ sessionId: `sess_other_${i}`, event: 'noise' }));
  lines.push({ sessionId: 'sess_slow', event: 'ok' });
  writeSessionLog(logDir, lines);
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_slow' })(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      auditTimeBudgetMs: 0,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/exceeded its .*ms budget/);
});

test('an envelope with no sessionId fails the turn closed', async () => {
  const dir = tmpDir();
  const logDir = tmpDir();
  const envelopeWithoutSessionId = JSON.stringify({ response: JSON.stringify({ status: 'done', message: 'ok' }) });
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCli(`process.stdout.write(${JSON.stringify(envelopeWithoutSessionId)})`)(command, args, options);
  };
  await expect(
    runGlmTurn({
      cwd: dir,
      prompt: 'go',
      logDir: dir,
      zcodeLogDir: logDir,
      env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs') },
      zcodeConfigPath: writeSafeZcodeConfig(dir),
      spawnFn,
    }),
  ).rejects.toThrow(/no sessionId/);
});

test('KAPREK_GLM_SKIP_TOOL_AUDIT=1 bypasses the audit entirely', async () => {
  const dir = tmpDir();
  const logDir = tmpDir(); // still empty — would fail closed otherwise
  const spawnFn = (command, args, options) => {
    if (args.includes('plugins')) return fakeCliAnswering('done', 'noise')(command, args, options);
    return fakeCliAnswering('done', 'ok', { sessionId: 'sess_whatever' })(command, args, options);
  };
  const result = await runGlmTurn({
    cwd: dir,
    prompt: 'go',
    logDir: dir,
    zcodeLogDir: logDir,
    env: { ...process.env, KAPREK_ZCODE_PATH: path.join(dir, 'zcode.cjs'), [GLM_TOOL_AUDIT_SKIP_ENV]: '1' },
    zcodeConfigPath: writeSafeZcodeConfig(dir),
    spawnFn,
  });
  expect(result.status).toBe('done');
});

test('toolNamesForSession checks the turn\'s own start AND end calendar dates — a session only in YESTERDAY\'s file is still found for a turn that started yesterday', async () => {
  const logDir = tmpDir();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  writeSessionLog(logDir, [{ sessionId: 'sess_midnight', event: 'ok' }], { date: yesterday });
  // startedAt is yesterday, endedAt is "now" (today) — a turn that ran right
  // across local midnight. Only yesterday's file exists; today's file is
  // absent, which must not by itself cause a false "no evidence" failure as
  // long as the OTHER relevant date has the evidence.
  const result = await toolNamesForSession('sess_midnight', { zcodeLogDir: logDir, startedAt: yesterday, endedAt: new Date() });
  expect(result.anyFound).toBe(true);
  expect(result.names).toEqual([]);
});

test('toolNamesForSession does NOT check a blanket window around "now" — only the two dates it is given', async () => {
  const logDir = tmpDir();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  writeSessionLog(logDir, [{ sessionId: 'sess_old', event: 'ok' }], { date: twoDaysAgo });
  // Both startedAt and endedAt are "now" — two days ago is neither, so this
  // must report no evidence even though a (correctly dated, but irrelevant)
  // file exists on disk.
  const result = await toolNamesForSession('sess_old', { zcodeLogDir: logDir, startedAt: new Date(), endedAt: new Date() });
  expect(result.anyFound).toBe(false);
});
