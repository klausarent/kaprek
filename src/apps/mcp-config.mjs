// Writes/removes the temporary --mcp-config file the Claude Code CLI is
// started with (see src/harness/claude-code.mjs's buildArgs()). Format
// verified against Claude Code's own --mcp-config: a JSON object with an
// `mcpServers` map, each entry `{command, args, env?}` describing how to
// spawn one MCP server as a local stdio process — the same shape used for
// `.mcp.json` project config files.
//
// Sandbox (default on): the spawned server runs under Node's own
// `--permission` model, not just src/apps/mcp-server.mjs's `import()`
// boundary check — a user app's handler runs arbitrary code (see that
// module's header), and a lexical "does this path start with appDir" check
// is not an enforcement boundary, only a courtesy. `--permission` IS
// enforced by the V8/libuv layer itself: fs reads/writes outside the
// allow-listed directories throw ERR_ACCESS_DENIED before they ever reach
// disk, regardless of what a handler's own code tries to do (verified
// empirically against this exact server: a handler calling
// `fs.writeFileSync()` on a path outside the allowed write directory,
// bypassing src/workspace/fs.mjs entirely, is stopped by Node itself and
// surfaces as a normal CallToolResult isError, not a crash).
//
// What has to be readable for the server to even start: the server's own
// module graph (mcp-server.mjs statically imports loader.mjs, which imports
// manifest.mjs, all under `packageRoot`), package.json (read for
// serverVersion()), the bundled apps directory (also under packageRoot by
// default), and every app's handler.mjs (bundled apps under packageRoot,
// user apps under dataDir). Node's permission model checks EVERY fs read —
// including ESM module resolution — so `packageRoot` must be readable, not
// just the entry script; only the entry script itself is exempt (Node's own
// bootstrap has to read it before any permission the process defines could
// even apply).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { workspaceDirFor } from './mcp-server.mjs';

/**
 * Writes a one-server --mcp-config JSON file wiring up kaprek's own apps
 * MCP server (see mcp-server.mjs), and returns its path.
 *
 * `serverScriptPath` is passed as an argv element to `node`, never
 * interpreted by a shell — so no escaping/quoting concerns even on Windows.
 * The server itself gets its directories via env, matching mcp-server.mjs's
 * `run()` (KAPREK_DATA_DIR / KAPREK_APPS_DIR), since Claude Code spawns the
 * server with a fresh environment we don't otherwise control the argv of.
 *
 * `packageRoot` is required whenever `sandbox` is true (the default): it is
 * the directory that must stay readable for the server's own code and the
 * bundled apps under it to load at all (see module header). Callers already
 * know it — it's wherever kaprek itself is installed/checked out — so this
 * intentionally does not try to guess it from `serverScriptPath`'s layout.
 *
 * `command` is always `process.execPath` (the exact node binary running
 * THIS process), never the bare string `'node'` — the first `node` found on
 * a spawned child's PATH is not guaranteed to be the same binary, and
 * `--permission` support/flags are version-specific.
 *
 * `sandbox: false` drops the `--permission` argv entirely (plain
 * `[serverScriptPath]`), for local debugging only — never the default.
 */
export function writeMcpConfig({ dataDir, appsDir, packageRoot, serverScriptPath, tmpDir = os.tmpdir(), sandbox = true }) {
  if (!dataDir) throw new Error('writeMcpConfig requires dataDir');
  if (!serverScriptPath) throw new Error('writeMcpConfig requires serverScriptPath');
  if (sandbox && !packageRoot) throw new Error('writeMcpConfig requires packageRoot when sandbox is enabled');

  const workspaceDir = workspaceDirFor(dataDir);

  const args = sandbox
    ? [
        '--permission',
        `--allow-fs-read=${packageRoot}`,
        `--allow-fs-read=${dataDir}`,
        ...(appsDir ? [`--allow-fs-read=${appsDir}`] : []),
        `--allow-fs-write=${workspaceDir}`,
        serverScriptPath,
      ]
    : [serverScriptPath];

  const config = {
    mcpServers: {
      'kaprek-apps': {
        command: process.execPath,
        args,
        env: {
          KAPREK_DATA_DIR: dataDir,
          ...(appsDir ? { KAPREK_APPS_DIR: appsDir } : {}),
        },
      },
    },
  };

  const configPath = path.join(tmpDir, `kaprek-mcp-config-${crypto.randomUUID()}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  return configPath;
}

/** Removes a --mcp-config file written by writeMcpConfig(). Never throws — a missing/already-removed file is not an error for a cleanup call. */
export function cleanupMcpConfig(configPath) {
  try {
    fs.rmSync(configPath, { force: true });
  } catch {
    // best-effort cleanup only
  }
}
