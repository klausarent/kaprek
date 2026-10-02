import { describe, it, expect } from 'vitest';
import { parseUnifiedHeaders } from './ratelimit.mjs';

describe('parseUnifiedHeaders', () => {
  it('reads the 5h and 7d windows as percent with ISO resets', () => {
    const out = parseUnifiedHeaders({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-5h-utilization': '0.58',
      'anthropic-ratelimit-unified-5h-reset': '1788617400',
      'anthropic-ratelimit-unified-7d-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-reset': '1788994800',
      'content-type': 'text/event-stream',
    });
    expect(out.status).toBe('allowed');
    expect(out.representativeClaim).toBe('five_hour');
    expect(out.windows['5h']).toEqual({ usedPercent: 58, resetsAt: new Date(1788617400 * 1000).toISOString() });
    expect(out.windows['7d'].usedPercent).toBe(10);
  });

  it('returns null when no unified header is present', () => {
    expect(parseUnifiedHeaders({ 'content-type': 'application/json' })).toBeNull();
  });

  it('keeps unknown windows and tolerates garbage values', () => {
    const out = parseUnifiedHeaders({
      'anthropic-ratelimit-unified-overage-utilization': 'nope',
      'anthropic-ratelimit-unified-7d_fable-utilization': '1',
    });
    expect(out.windows.overage).toEqual({ usedPercent: null, resetsAt: null });
    expect(out.windows['7d_fable'].usedPercent).toBe(100);
  });

  it('ignores header arrays by taking the first value', () => {
    const out = parseUnifiedHeaders({ 'anthropic-ratelimit-unified-5h-utilization': ['0.2', '0.9'] });
    expect(out.windows['5h'].usedPercent).toBe(20);
  });
});
