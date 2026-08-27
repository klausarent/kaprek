import { test, expect } from 'vitest';
import { parseFindings, renderFindingsSection, appendFindingsSection, FINDINGS_FENCE } from './findings.mjs';
import { parseSteps } from './markdown.mjs';

const block = (json) => ['Checked the plan.', '', '```' + FINDINGS_FENCE, JSON.stringify(json), '```'].join('\n');

test('a block with gaps is not converged, and every gap keeps its taxonomy', () => {
  const result = parseFindings(
    block({
      converged: false,
      checked: { requirements: 7, files: 3 },
      findings: [
        { id: 'F1', sourceRef: 'Step 3', gapType: 'missing', severity: 'high', evidence: 'src/a.mjs has no export named parse', remainingWork: 'add parse() to src/a.mjs' },
        { id: 'F2', sourceRef: 'Step 5', gapType: 'unrequested', severity: 'low', evidence: 'src/b.mjs exists but no step names it', remainingWork: 'decide whether b.mjs stays' },
      ],
    }),
  );
  expect(result.converged).toBe(false);
  expect(result.checked).toEqual({ requirements: 7, files: 3 });
  expect(result.findings.map((f) => [f.id, f.gapType, f.severity])).toEqual([
    ['F1', 'missing', 'high'],
    ['F2', 'unrequested', 'low'],
  ]);
});

test('converged means the claim AND zero findings — a claim next to a gap is a gap', () => {
  expect(parseFindings(block({ converged: true, findings: [] })).converged).toBe(true);
  const contradiction = parseFindings(block({ converged: true, findings: [{ id: 'F1', evidence: 'x', remainingWork: 'y' }] }));
  expect(contradiction.converged).toBe(false);
  expect(contradiction.findings).toHaveLength(1);
});

test('no claim and no findings is no result — silence is not completion', () => {
  expect(parseFindings(block({ findings: [] }))).toBeNull();
  expect(parseFindings(block({ converged: false }))).toBeNull();
});

test('unknown gap types and severities fall back rather than dropping the finding; an empty finding is dropped', () => {
  const result = parseFindings(
    block({
      findings: [
        { gapType: 'weird', severity: 'urgent', remainingWork: 'do it' },
        { id: 'empty' },
        { evidence: 'only evidence here' },
      ],
    }),
  );
  expect(result.findings).toHaveLength(2);
  expect(result.findings[0]).toMatchObject({ id: 'F1', gapType: 'missing', severity: 'medium', remainingWork: 'do it' });
  expect(result.findings[1]).toMatchObject({ id: 'F3', remainingWork: '(see evidence)', evidence: 'only evidence here' });
});

test('duplicate ids are made unique so two findings never share one step', () => {
  const result = parseFindings(block({ findings: [{ id: 'F1', remainingWork: 'a' }, { id: 'F1', remainingWork: 'b' }] }));
  expect(result.findings.map((f) => f.id)).toEqual(['F1', 'F1-2']);
});

test('only the last closed block counts; an example block earlier in the answer is ignored', () => {
  const text = [block({ converged: true, findings: [] }), '', 'Now the real one:', block({ findings: [{ id: 'F1', remainingWork: 'real gap' }] })].join('\n');
  expect(parseFindings(text).findings[0].remainingWork).toBe('real gap');
  const unclosed = [block({ converged: true, findings: [] }), '', '```' + FINDINGS_FENCE, '{"findings": []'].join('\n');
  expect(parseFindings(unclosed)).toBeNull();
});

test('a block shown inside a longer fence is an illustration, not a result', () => {
  const text = ['````markdown', block({ converged: true, findings: [] }), '````'].join('\n');
  expect(parseFindings(text)).toBeNull();
});

test('malformed input is null, never a throw', () => {
  expect(parseFindings(undefined)).toBeNull();
  expect(parseFindings('no block at all')).toBeNull();
  expect(parseFindings(['```' + FINDINGS_FENCE, 'not json', '```'].join('\n'))).toBeNull();
  expect(parseFindings(['```' + FINDINGS_FENCE, '[1,2]', '```'].join('\n'))).toBeNull();
});

test('the rendered section is checkbox steps the plan parser reads back, appended without touching the text above', () => {
  const plan = '# The plan\n\n- [x] Step 1\n- [ ] Step 2\n';
  const findings = parseFindings(
    block({ findings: [{ id: 'F1', sourceRef: 'Step 2', gapType: 'partial', severity: 'high', evidence: 'test missing', remainingWork: 'write the test' }] }),
  ).findings;
  const next = appendFindingsSection(plan, renderFindingsSection({ round: 1, findings, ts: '2026-08-27T10:00:00.000Z' }));
  expect(next.startsWith(plan)).toBe(true);
  expect(next).toContain('## Convergence round 1 (2026-08-27)');
  const steps = parseSteps(next);
  expect(steps).toHaveLength(3);
  expect(steps[2].done).toBe(false);
  expect(steps[2].text).toBe('**F1 (high, partial, Step 2):** write the test — test missing');
});

test('a CRLF plan file stays CRLF after the append', () => {
  const plan = '# Plan\r\n\r\n- [ ] Step\r\n';
  const next = appendFindingsSection(plan, renderFindingsSection({ round: 2, findings: [{ id: 'F1', severity: 'low', gapType: 'missing', sourceRef: '', evidence: '', remainingWork: 'x' }], ts: '' }));
  expect(next).not.toMatch(/[^\r]\n/);
  expect(next).toContain('## Convergence round 2\r\n');
});
