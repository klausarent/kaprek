// Tests for the engine registry — the one place that knows which harnesses
// exist and what each one can honestly do.
import { test, expect } from 'vitest';
import { getEngine, listEngines } from './registry.mjs';
import { isHarnessCapabilities } from './adapter.mjs';

test('both engines are listed, each with a complete capability declaration', () => {
  const engines = listEngines();
  expect(engines.map((engine) => engine.id)).toEqual(['claude-code', 'codex']);
  for (const engine of engines) {
    expect(isHarnessCapabilities(engine), `incomplete capabilities: ${JSON.stringify(engine)}`).toBe(true);
  }
  const claude = engines.find((engine) => engine.id === 'claude-code');
  const codex = engines.find((engine) => engine.id === 'codex');
  // The honest differences a caller must be able to see BEFORE picking:
  // codex reports no USD, cannot rewrite tool input on allow, and knows
  // nothing of allowed-tools / mcp-config / settings files.
  expect(claude).toMatchObject({ supportsCostUsd: true, supportsUpdatedInput: true, supportsAllowedTools: true });
  expect(codex).toMatchObject({
    supportsCostUsd: false,
    supportsUpdatedInput: false,
    supportsAllowedTools: false,
    supportsMcpConfig: false,
    supportsSettingsPath: false,
  });
});

test('getEngine returns a startTurn and its capabilities, and null for an unknown id', () => {
  const codex = getEngine('codex');
  expect(typeof codex.startTurn).toBe('function');
  expect(codex.capabilities.id).toBe('codex');
  const claude = getEngine('claude-code');
  expect(typeof claude.startTurn).toBe('function');
  expect(getEngine('nope')).toBeNull();
  expect(getEngine(undefined)).toBeNull();
});
