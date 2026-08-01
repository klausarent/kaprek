// The engine registry — the one place that knows which harnesses exist.
//
// Deliberately STATIC: both engines are always listed, and whether the CLI
// is actually installed is settled by the first turn (spawn ENOENT arrives
// as a normalized stopReason 'error'), not by shelling out on every list
// call — a liveness probe per GET is the dev-server-zombie trap's nearest
// relative, and an engine that is installed but broken would pass it anyway.
import { startTurn as claudeCodeStartTurn } from './claude-code.mjs';
import { startTurn as codexStartTurn } from './codex.mjs';

const ENGINES = new Map([
  [
    'claude-code',
    {
      startTurn: claudeCodeStartTurn,
      capabilities: Object.freeze({
        id: 'claude-code',
        displayName: 'Claude Code',
        supportsCostUsd: true,
        supportsUpdatedInput: true,
        supportsAllowedTools: true,
        supportsMcpConfig: true,
        supportsSettingsPath: true,
      }),
    },
  ],
  [
    'codex',
    {
      startTurn: codexStartTurn,
      capabilities: Object.freeze({
        id: 'codex',
        displayName: 'Codex',
        // Codex reports token usage, never USD; an 'allow' cannot rewrite
        // the proposed input; and allowedTools/mcpConfig/settings are
        // claude-specific options the codex CLI has no equivalent for. The
        // harness ignores them — this declaration is what makes that
        // ignoring visible instead of silent.
        supportsCostUsd: false,
        supportsUpdatedInput: false,
        supportsAllowedTools: false,
        supportsMcpConfig: false,
        supportsSettingsPath: false,
      }),
    },
  ],
]);

/** Every engine's capability declaration, in stable registry order. */
export function listEngines() {
  return [...ENGINES.values()].map((engine) => engine.capabilities);
}

/** The engine behind an id — `{startTurn, capabilities}` — or null for an unknown one. */
export function getEngine(id) {
  return ENGINES.get(id) ?? null;
}
