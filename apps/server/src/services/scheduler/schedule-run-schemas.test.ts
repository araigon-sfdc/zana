import { describe, expect, it } from 'vitest';
import { scheduleRunQuerySchema, scheduleRunRefsSchema, slimRunQueryResult } from './schedule-run-schemas.js';

describe('scheduleRunQuerySchema', () => {
  it('accepts an empty query and a fully populated one', () => {
    expect(scheduleRunQuerySchema.safeParse({}).success).toBe(true);
    expect(scheduleRunQuerySchema.safeParse({
      state: 'problems', outcomes: ['error', 'missed'], reasonCodes: ['missed-asleep'], since: '2026-01-01T00:00:00Z',
      until: '2026-02-01', projectId: 'p', scheduleIds: ['a'], limit: 500
    }).success).toBe(true);
  });
  it.each([
    [{ state: 'nope' }], [{ outcomes: ['bogus'] }], [{ reasonCodes: ['bogus'] }], [{ since: 'yesterday' }], [{ until: 'x'.repeat(65) }],
    [{ projectId: '' }], [{ projectId: 'x'.repeat(257) }], [{ scheduleIds: Array(51).fill('a') }], [{ scheduleIds: [''] }],
    [{ limit: 0 }], [{ limit: 501 }], [{ limit: 1.5 }], [{ extra: 1 }]
  ])('rejects %j', input => {
    expect(scheduleRunQuerySchema.safeParse(input).success).toBe(false);
  });
});

describe('scheduleRunRefsSchema', () => {
  const schema = scheduleRunRefsSchema(2);
  it('accepts 1..max refs', () => {
    expect(schema.safeParse([{ scheduleId: 's', runId: 'r' }]).success).toBe(true);
    expect(schema.safeParse([{ scheduleId: 's', runId: 'r' }, { scheduleId: 's', runId: 'r2' }]).success).toBe(true);
  });
  it.each([
    [[]], [Array(3).fill({ scheduleId: 's', runId: 'r' })], [[{ scheduleId: '', runId: 'r' }]], [[{ scheduleId: 's' }]],
    [[{ scheduleId: 's', runId: 'x'.repeat(257) }]], [[{ scheduleId: 's', runId: 'r', extra: 1 }]], ['s'], [null]
  ])('rejects %j', input => {
    expect(schema.safeParse(input).success).toBe(false);
  });
});

describe('slimRunQueryResult', () => {
  const row = (report?: string) => ({
    scheduleId: 's', scheduleName: 'S', projectId: 'p', outcome: 'error' as const, problem: true, open: true, manualRetry: true,
    run: { id: 'r', at: '2026-01-01T00:00:00Z', result: 'error' as const, message: 'exit 1', ...(report ? { report } : {}) }
  });
  it('drops report text, keeps every other field and the totals', () => {
    const out = slimRunQueryResult({ rows: [row('x'.repeat(100_000)), row()], total: 7, truncated: true });
    expect(out.rows[0].run).toEqual({ id: 'r', at: '2026-01-01T00:00:00Z', result: 'error', message: 'exit 1' });
    expect('report' in out.rows[0].run).toBe(false);
    expect(out.rows[1]).toEqual(row());
    expect(out).toMatchObject({ total: 7, truncated: true });
  });
  it('does not mutate its input', () => {
    const input = { rows: [row('keep me')], total: 1, truncated: false };
    slimRunQueryResult(input);
    expect(input.rows[0].run.report).toBe('keep me');
  });
});
