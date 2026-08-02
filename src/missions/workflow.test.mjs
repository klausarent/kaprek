import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvalidWorkflowError, buildWorkflow, importSummary, loadWorkflows, saveWorkflow, validateWorkflow } from './workflow.mjs';

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaprek-workflow-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const preset = {
  id: 'marketing-piece',
  title: 'Marketing piece',
  firstPrompt: 'Research the topic, draft the piece, check it against the style rules, and stop before publishing.',
  goalTemplate: 'A publish-ready piece about <topic>',
};

const workflow = (overrides = {}) => buildWorkflow({ id: 'marketing-piece', title: 'Marketing piece', preset, ...overrides });

describe('buildWorkflow', () => {
  test('bundles the four things that make a way of working', () => {
    const built = workflow({
      recipe: { id: 'r', title: 'r', steps: [{ id: 'draft', agent: 'grok', tools: 'none' }], edges: [], budgets: {}, escalation: {} },
      councilLevel: 'plans',
      profile: ['This project publishes in German.'],
    });
    expect(built.preset.firstPrompt).toContain('Research the topic');
    expect(built.recipe.id).toBe('r');
    expect(built.councilLevel).toBe('plans');
    expect(built.profile).toEqual(['This project publishes in German.']);
  });

  test('the id has to work as a file name', () => {
    expect(() => buildWorkflow({ id: 'Marketing Piece', title: 't', preset })).toThrow(/lowercase/);
  });

  test('refuses an absolute path rather than quietly stripping it', () => {
    // Half a field is worse than a refusal: the file still looks complete,
    // and whoever receives it finds out at run time.
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: 'Read C:\\Users\\klaus\\notes.md first' } })).toThrow(/absolute path/);
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: 'Read /home/klaus/notes.md first' } })).toThrow(InvalidWorkflowError);
  });

  test('refuses anything that names or looks like a secret', () => {
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: 'Use OPENAI_API_KEY from the env' } })).toThrow(/secret/);
    expect(() => buildWorkflow({ id: 'x', title: 't', preset, profile: ['the token is sk-abcdefgh12345'] })).toThrow(/secret/);
  });

  test('a relative path is fine — it is the absolute ones that name a person', () => {
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: 'Read docs/style.md first' } })).not.toThrow();
  });
});

describe('validateWorkflow', () => {
  test('accepts what buildWorkflow produced', () => {
    expect(validateWorkflow(workflow()).id).toBe('marketing-piece');
  });

  test('refuses a version it does not understand', () => {
    expect(() => validateWorkflow({ ...workflow(), version: 99 })).toThrow(/version 99/);
  });

  test('an imported file goes through the same door as an exported one', () => {
    // So nothing can arrive that could not have left.
    expect(() => validateWorkflow({ ...workflow(), preset: { ...preset, firstPrompt: 'Read /home/someone/secrets.md' } })).toThrow(/absolute path/);
  });
});

describe('saving and loading', () => {
  test('a workflow is a file with its id as the name', () => {
    const saved = saveWorkflow(dataDir, workflow());
    expect(path.basename(saved.path)).toBe('marketing-piece.json');
    expect(loadWorkflows(dataDir).map((entry) => entry.id)).toEqual(['marketing-piece']);
  });

  test('no workflows at all is an empty list, not an error', () => {
    expect(loadWorkflows(dataDir)).toEqual([]);
  });

  test('one broken file does not take the catalog down', () => {
    saveWorkflow(dataDir, workflow());
    fs.writeFileSync(path.join(dataDir, 'workflows', 'broken.json'), '{not json', 'utf8');
    const warn = console.warn;
    console.warn = () => {};
    expect(loadWorkflows(dataDir).map((entry) => entry.id)).toEqual(['marketing-piece']);
    console.warn = warn;
  });
});

describe('importSummary', () => {
  test('says what importing it will change, before anything is written', () => {
    const lines = importSummary(
      workflow({
        recipe: {
          id: 'r',
          title: 'r',
          steps: [
            { id: 'draft', agent: 'grok', tools: 'none' },
            { id: 'apply', agent: 'codex', tools: 'full' },
          ],
          edges: [],
          budgets: {},
          escalation: {},
        },
        councilLevel: 'decisions',
        profile: ['a note'],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('grok → codex');
    // The two things that change how future runs behave get named.
    expect(text).toContain('apply may change files');
    expect(text).toContain('decisions');
    expect(text).toContain('1 note');
  });

  test('a plain workflow says only what it is', () => {
    expect(importSummary(workflow())).toHaveLength(1);
  });
});

describe('what Grok found', () => {
  test('an absolute path anywhere, not just under a home directory', () => {
    for (const bad of ['Read /opt/tools/notes.md', 'Read /var/log/app.log', 'Read \\\\fileserver\\share\\notes.md', 'Read ~/notes.md']) {
      expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: bad } })).toThrow(/absolute path/);
    }
  });

  test('a relative path is still fine', () => {
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, firstPrompt: 'Read docs/style.md and ./notes.md' } })).not.toThrow();
  });

  test('checks fields the first version did not: preset.description, the title, the recipe', () => {
    expect(() => buildWorkflow({ id: 'x', title: 't', preset: { ...preset, description: 'Lives in /opt/marketing' } })).toThrow(/absolute path/);
    expect(() => buildWorkflow({ id: 'x', title: 'Uses OPENAI_API_KEY', preset })).toThrow(/secret/);
    expect(() =>
      buildWorkflow({
        id: 'x',
        title: 't',
        preset,
        recipe: { id: 'r', title: 'Runs in /home/klaus/repo', steps: [], edges: [], budgets: {}, escalation: {} },
      }),
    ).toThrow(/absolute path/);
  });

  test('a recipe with no steps does not crash the summary', () => {
    // It belongs in the route's 400, not in a crash inside the sentence
    // meant to explain the file.
    expect(() => importSummary({ ...workflow(), recipe: { id: 'r', title: 'r' } })).not.toThrow();
    expect(() => importSummary({ ...workflow(), recipe: { id: 'r', title: 'r', steps: [] } })).not.toThrow();
  });
});
