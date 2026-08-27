import { test, expect } from 'vitest';
import {
  POSTURES,
  effectivePosture,
  postureAllows,
  stricterPosture,
  BUILTIN_HARD_DENIALS,
  evaluateHardDenials,
  validateHardDenials,
  hardDenialsOf,
  cliDenyRules,
  posixPath,
  HardDenialValidationError,
} from './guards.mjs';

const HOME = 'C:\\Users\\alice';

test('posture is a ceiling: a mission can only tighten the global dial, never loosen it', () => {
  expect(POSTURES).toEqual(['ask', 'edits', 'auto']);
  expect(effectivePosture({ global: 'auto', mission: null })).toBe('auto');
  expect(effectivePosture({ global: 'auto', mission: 'ask' })).toBe('ask');
  expect(effectivePosture({ global: 'edits', mission: 'auto' })).toBe('edits');
  expect(effectivePosture({ global: 'nonsense' })).toBe('auto');
  expect(stricterPosture(null, 'edits')).toBe('edits');
  expect(postureAllows('edits', 'ask')).toBe(true);
  expect(postureAllows('edits', 'edits')).toBe(true);
  expect(postureAllows('edits', 'auto')).toBe(false);
  expect(postureAllows('ask', 'edits')).toBe(false);
  expect(postureAllows('auto', 'bogus')).toBe(false);
});

test('writing an agent configuration is denied whatever the tool, wherever the path points', () => {
  const home = HOME;
  const hits = [
    { toolName: 'Edit', input: { file_path: 'C:\\Users\\alice\\.claude\\settings.json' } },
    { toolName: 'Write', input: { file_path: 'c:/users/alice/.claude/CLAUDE.md' } },
    { toolName: 'Write', input: { file_path: 'C:\\Users\\alice\\.claude.json' } },
    { toolName: 'NotebookEdit', input: { notebook_path: 'C:\\Users\\alice\\.codex\\notes.ipynb' } },
    { toolName: 'Edit', input: { file_path: 'D:\\work\\proj\\.mcp.json' } },
    { toolName: 'Edit', input: { file_path: '.mcp.json' } },
  ];
  for (const request of hits) {
    const verdict = evaluateHardDenials(request, BUILTIN_HARD_DENIALS, { home });
    expect(verdict.denied, JSON.stringify(request)).toBe(true);
    expect(verdict.rule.id).toBe('agent-config-write');
  }
  const misses = [
    { toolName: 'Edit', input: { file_path: 'D:\\work\\proj\\.claude\\settings.json' } }, // a PROJECT's .claude is the project's business
    { toolName: 'Read', input: { file_path: 'C:\\Users\\alice\\.claude\\settings.json' } },
    { toolName: 'Edit', input: { file_path: 'C:\\Users\\alice\\project\\mcp.json' } },
    { toolName: 'Edit', input: {} },
  ];
  for (const request of misses) expect(evaluateHardDenials(request, BUILTIN_HARD_DENIALS, { home }).denied, JSON.stringify(request)).toBe(false);
});

test('a recursive delete aimed at a root or a home is denied; an ordinary one is not', () => {
  const denied = ['rm -rf /', 'rm -rf ~', 'rm -rf "$HOME"', 'cd /tmp && rm -fr *', 'rm -r .', 'rmdir /s /q C:\\', 'Remove-Item -Recurse -Force C:\\', 'echo x; rm -rf /'];
  for (const command of denied) {
    const verdict = evaluateHardDenials({ toolName: 'Bash', input: { command } });
    expect(verdict.denied, command).toBe(true);
    expect(verdict.rule.id).toBe('recursive-delete-of-root');
  }
  const allowed = ['rm -rf node_modules', 'rm -rf ./dist', 'rm -r build/', 'rm file.txt', 'Remove-Item -Recurse -Force .\\dist', 'git rm -r --cached x'];
  for (const command of allowed) expect(evaluateHardDenials({ toolName: 'Bash', input: { command } }).denied, command).toBe(false);
  expect(evaluateHardDenials({ toolName: 'Edit', input: { command: 'rm -rf /' } }).denied).toBe(false);
});

test('rules a person adds are validated, normalized, and evaluated after the built-ins', () => {
  const extra = validateHardDenials([{ id: 'no-prod-db', why: 'production is not a sandbox', tools: ['Bash'], command: 'psql\\s+.*prod' }]);
  expect(extra).toEqual([{ id: 'no-prod-db', why: 'production is not a sandbox', tools: ['Bash'], command: 'psql\\s+.*prod' }]);
  const rules = hardDenialsOf({ hardDenials: extra });
  expect(rules.map((r) => r.id)).toEqual(['agent-config-write', 'recursive-delete-of-root', 'no-prod-db']);
  expect(evaluateHardDenials({ toolName: 'Bash', input: { command: 'psql -h db.prod.internal' } }, rules).rule.id).toBe('no-prod-db');
  expect(validateHardDenials(undefined)).toEqual([]);
  expect(validateHardDenials([{ id: 'p', tools: ['Edit'], paths: ['**/secrets/**'] }])[0].why).toBe('denied by policy.json');

  const bad = [
    'not an array',
    [{ id: '', tools: ['Bash'], command: 'x' }],
    [{ id: 'agent-config-write', tools: ['Bash'], command: 'x' }],
    [{ id: 'a', tools: [], command: 'x' }],
    [{ id: 'a', tools: ['Bash'] }],
    [{ id: 'a', tools: ['Bash'], command: '(' }],
    [{ id: 'a', tools: ['Bash'], command: 'x', extra: true }],
    [{ id: 'a', tools: ['Bash'], command: 'x' }, { id: 'a', tools: ['Bash'], command: 'y' }],
  ];
  for (const raw of bad) expect(() => validateHardDenials(raw), JSON.stringify(raw)).toThrow(HardDenialValidationError);
});

test('the CLI deny rules carry the path rules as Edit(...) and leave command rules to the handler', () => {
  expect(cliDenyRules()).toEqual(['Edit(~/.claude/**)', 'Edit(~/.claude.json)', 'Edit(~/.codex/**)', 'Edit(~/.gemini/**)', 'Edit(~/.kimi-code/**)', 'Edit(**/.mcp.json)']);
  const withExtra = cliDenyRules(hardDenialsOf({ hardDenials: [{ id: 'x', tools: ['Write'], paths: ['//d/secrets/**'] }, { id: 'y', tools: ['Bash'], command: 'z' }] }));
  expect(withExtra).toContain('Edit(//d/secrets/**)');
  expect(withExtra.some((r) => r.startsWith('Bash('))).toBe(false);
});

test('paths are compared the way the CLI compares them: forward slashes, /c/ for a drive', () => {
  expect(posixPath('C:\\Users\\alice\\x.txt')).toBe('/c/Users/alice/x.txt');
  expect(posixPath('/home/alice/x')).toBe('/home/alice/x');
});
