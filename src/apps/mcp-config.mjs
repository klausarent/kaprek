// Writes/removes the temporary --mcp-config file the Claude Code CLI is
// started with (see src/harness/claude-code.mjs's buildArgs()). Format
// verified against Claude Code's own --mcp-config: a JSON object with an
// `mcpServers` map, each entry `{command, args, env?}` describing how to
// spawn one MCP server as a local stdio process — the same shape used for
// `.mcp.json` project config files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Writes a one-server --mcp-config JSON file wiring up kaprek's own apps
 * MCP server (see mcp-server.mjs), and returns its path.
 *
 * `serverScriptPath` is passed as an argv element to `node`, never
 * interpreted by a shell — so no escaping/quoting concerns even on Windows.
 * The server itself gets its directories via env, matching mcp-server.mjs's
 * `run()` (KAPREK_DATA_DIR / KAPREK_APPS_DIR), since Claude Code spawns the
 * server with a fresh environment we don't otherwise control the argv of.
 */
export function writeMcpConfig({ dataDir, appsDir, serverScriptPath, tmpDir = os.tmpdir() }) {
  if (!dataDir) throw new Error('writeMcpConfig requires dataDir');
  if (!serverScriptPath) throw new Error('writeMcpConfig requires serverScriptPath');

  const config = {
    mcpServers: {
      'kaprek-apps': {
        command: 'node',
        args: [serverScriptPath],
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
