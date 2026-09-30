import { test, expect } from 'vitest';
import path from 'node:path';
import { claudeConfigDir, claudeUserHome } from './claude-home.mjs';

const home = path.resolve(path.sep, 'home', 'info');

test('without CLAUDE_CONFIG_DIR the config dir is ~/.claude', () => {
  expect(claudeConfigDir({ env: {}, homedir: home })).toBe(path.join(home, '.claude'));
  expect(claudeUserHome({ env: {}, homedir: home })).toBe(home);
});

test('CLAUDE_CONFIG_DIR wins, blank values are ignored', () => {
  const other = path.resolve(path.sep, 'home', 'karent', '.claude');
  expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: other }, homedir: home })).toBe(other);
  expect(claudeConfigDir({ env: { CLAUDE_CONFIG_DIR: '   ' }, homedir: home })).toBe(path.join(home, '.claude'));
});

test('user home is the parent of a .claude config dir, else the OS home', () => {
  const karent = path.resolve(path.sep, 'home', 'karent');
  expect(claudeUserHome({ env: { CLAUDE_CONFIG_DIR: path.join(karent, '.claude') }, homedir: home })).toBe(karent);
  expect(claudeUserHome({ env: { CLAUDE_CONFIG_DIR: path.join(karent, 'claude-cfg') }, homedir: home })).toBe(home);
});
