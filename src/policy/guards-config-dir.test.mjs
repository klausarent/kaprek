import { test, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { configDirDenials, hardDenialsOf, evaluateHardDenials } from './guards.mjs';

const zwilling = path.join(os.tmpdir(), 'kaprek-zwilling-home', '.claude');

test('no extra denial when CLAUDE_CONFIG_DIR is unset or equals ~/.claude', () => {
  expect(configDirDenials({})).toEqual([]);
  expect(configDirDenials({ CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') })).toEqual([]);
});

test('a foreign CLAUDE_CONFIG_DIR is protected like ~/.claude', () => {
  const rules = hardDenialsOf({}, { env: { CLAUDE_CONFIG_DIR: zwilling } });
  const hit = evaluateHardDenials({ toolName: 'Write', input: { file_path: path.join(zwilling, 'settings.json') } }, rules);
  expect(hit.denied).toBe(true);
  expect(hit.rule.id).toBe('agent-config-write-config-dir');
  const miss = evaluateHardDenials({ toolName: 'Write', input: { file_path: path.join(os.tmpdir(), 'kaprek-zwilling-home', 'notes.md') } }, rules);
  expect(miss.denied).toBe(false);
});
