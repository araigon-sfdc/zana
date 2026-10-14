import { describe, it, expect, vi } from 'vitest';

// scheduler-store imports `electron` for its `app.getPath('home')` call. We
// only need that path inside `listAllSchedules` / `saveSchedule`; the
// validator we're testing here doesn't touch it. Mocking keeps the tests
// from blowing up at import time.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cc-test-home' }
}));

import { validateScheduleFile } from './scheduler-store.js';
import { normalizeCatchUp, normalizeRetry } from './schedule-validation.js';

const baseTask = {
  id: 'sched-1',
  name: 'My schedule',
  enabled: true,
  projectId: 'proj-1',
  profile: 'claude',
  schedule: { every: '5m' },
  overlap: 'skip',
  history: { retain: 10 },
  status: { runCount: 0, runs: [] },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
};

describe('validateScheduleFile', () => {
  it('accepts a valid schedule and round-trips fields', () => {
    const r = validateScheduleFile({ ...baseTask });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.id).toBe('sched-1');
    expect(r.name).toBe('My schedule');
    expect(r.profile).toBe('claude');
    expect(r.schedule.every).toBe('5m');
    expect(r.history.retain).toBe(10);
  });

  it('rejects missing every', () => {
    const r = validateScheduleFile({ ...baseTask, schedule: {} });
    expect('error' in r).toBe(true);
  });

  it('rejects unparseable every (e.g. "1 hour")', () => {
    const r = validateScheduleFile({ ...baseTask, schedule: { every: '1 hour' } });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/invalid interval/i);
  });

  it('accepts a cron schedule and round-trips cron + tz', () => {
    const r = validateScheduleFile({
      ...baseTask,
      schedule: { cron: '0 9 * * 1-5', tz: 'Europe/Paris' }
    });
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.schedule.cron).toBe('0 9 * * 1-5');
    expect(r.schedule.tz).toBe('Europe/Paris');
    expect(r.schedule.every).toBeUndefined();
  });

  it('rejects an invalid cron expression', () => {
    const r = validateScheduleFile({ ...baseTask, schedule: { cron: 'not a cron' } });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/invalid cron/i);
  });

  it('rejects a schedule that sets both every and cron', () => {
    const r = validateScheduleFile({
      ...baseTask,
      schedule: { every: '5m', cron: '0 9 * * *' }
    });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/exactly one/i);
  });

  it('rejects invalid profile', () => {
    const r = validateScheduleFile({ ...baseTask, profile: 'gopher' });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/invalid profile/i);
  });

  it('preserves a team schedule and rejects one without a team id', () => {
    const valid = validateScheduleFile({ ...baseTask, kind: 'team', teamId: 'release-squad', planSource: 'provided' });
    expect('error' in valid).toBe(false);
    if (!('error' in valid)) expect(valid).toMatchObject({ kind: 'team', teamId: 'release-squad', planSource: 'provided' });
    expect(validateScheduleFile({ ...baseTask, kind: 'team' })).toEqual({ error: 'team schedule requires teamId' });
  });

  it('rejects non-string name', () => {
    const r = validateScheduleFile({ ...baseTask, name: 42 });
    expect('error' in r).toBe(true);
  });

  it('rejects missing projectId', () => {
    const { projectId: _drop, ...rest } = baseTask;
    void _drop;
    const r = validateScheduleFile(rest);
    expect('error' in r).toBe(true);
  });

  it('rejects non-boolean enabled', () => {
    const r = validateScheduleFile({ ...baseTask, enabled: 'yes' });
    expect('error' in r).toBe(true);
  });

  it('falls back to defaults for missing optional pieces', () => {
    const { history: _h, status: _s, ...rest } = baseTask;
    void _h;
    void _s;
    const r = validateScheduleFile(rest);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.history.retain).toBe(10);
    expect(r.status.runs).toEqual([]);
    expect(r.status.runCount).toBe(0);
  });

  describe('inboxLevel migration', () => {
    it('defaults to quiet when neither inboxLevel nor notifyInbox is present', () => {
      const r = validateScheduleFile({ ...baseTask });
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.inboxLevel).toBe('quiet');
    });

    it('honors an explicit inboxLevel', () => {
      for (const level of ['silent', 'quiet', 'loud'] as const) {
        const r = validateScheduleFile({ ...baseTask, inboxLevel: level });
        expect('error' in r).toBe(false);
        if ('error' in r) return;
        expect(r.inboxLevel).toBe(level);
      }
    });

    it('migrates legacy notifyInbox:true → loud', () => {
      const r = validateScheduleFile({ ...baseTask, notifyInbox: true });
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.inboxLevel).toBe('loud');
    });

    it('migrates legacy notifyInbox:false → quiet', () => {
      const r = validateScheduleFile({ ...baseTask, notifyInbox: false });
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.inboxLevel).toBe('quiet');
    });

    it('prefers inboxLevel over a conflicting legacy notifyInbox', () => {
      const r = validateScheduleFile({ ...baseTask, inboxLevel: 'silent', notifyInbox: true });
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.inboxLevel).toBe('silent');
    });

    it('falls back to quiet for an unrecognized inboxLevel string', () => {
      const r = validateScheduleFile({ ...baseTask, inboxLevel: 'shout' });
      expect('error' in r).toBe(false);
      if ('error' in r) return;
      expect(r.inboxLevel).toBe('quiet');
    });
  });
});

const okTask = (raw: unknown) => {
  const r = validateScheduleFile(raw);
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('normalizeCatchUp', () => {
  it('accepts each mode', () => {
    for (const mode of ['once', 'skip', 'all'] as const) expect(normalizeCatchUp({ mode })).toEqual({ mode });
  });
  it('clamps and rounds max to 1-10', () => {
    expect(normalizeCatchUp({ mode: 'all', max: 99 })).toEqual({ mode: 'all', max: 10 });
    expect(normalizeCatchUp({ mode: 'all', max: 0 })).toEqual({ mode: 'all', max: 1 });
    expect(normalizeCatchUp({ mode: 'all', max: 2.6 })).toEqual({ mode: 'all', max: 3 });
  });
  it('drops a non-numeric max but keeps the mode', () => {
    expect(normalizeCatchUp({ mode: 'all', max: 'x' })).toEqual({ mode: 'all' });
  });
  it('invalid values become undefined', () => {
    for (const bad of [undefined, null, 'once', 5, [], {}, { mode: 'weekly' }, { mode: 1 }]) {
      expect(normalizeCatchUp(bad)).toBeUndefined();
    }
  });
});

describe('normalizeRetry', () => {
  it('accepts valid values and clamps', () => {
    expect(normalizeRetry({ attempts: 3, delayMinutes: 10 })).toEqual({ attempts: 3, delayMinutes: 10 });
    expect(normalizeRetry({ attempts: 99, delayMinutes: 99999 })).toEqual({ attempts: 5, delayMinutes: 1440 });
    expect(normalizeRetry({ attempts: -4, delayMinutes: 0 })).toEqual({ attempts: 0, delayMinutes: 1 });
    expect(normalizeRetry({ attempts: 1.6, delayMinutes: 5.4 })).toEqual({ attempts: 2, delayMinutes: 5 });
  });
  it('invalid values become undefined', () => {
    for (const bad of [undefined, null, 3, [], {}, { attempts: 2 }, { delayMinutes: 5 }, { attempts: 'a', delayMinutes: 5 }, { attempts: NaN, delayMinutes: 5 }]) {
      expect(normalizeRetry(bad)).toBeUndefined();
    }
  });
});

describe('validateScheduleFile: recovery fields', () => {
  it('carries valid catchUp / retry', () => {
    const t = okTask({ ...baseTask, catchUp: { mode: 'all', max: 4 }, retry: { attempts: 2, delayMinutes: 15 } });
    expect(t.catchUp).toEqual({ mode: 'all', max: 4 });
    expect(t.retry).toEqual({ attempts: 2, delayMinutes: 15 });
  });
  it('clamps and drops invalid catchUp / retry without rejecting the file', () => {
    const t = okTask({ ...baseTask, catchUp: { mode: 'all', max: 50 }, retry: { attempts: 9, delayMinutes: 0 } });
    expect(t.catchUp).toEqual({ mode: 'all', max: 10 });
    expect(t.retry).toEqual({ attempts: 5, delayMinutes: 1 });
    const bad = okTask({ ...baseTask, catchUp: 'yes', retry: 7 });
    expect('catchUp' in bad).toBe(false);
    expect('retry' in bad).toBe(false);
  });
  it('carries valid status fields', () => {
    const status = {
      runCount: 1, runs: [],
      slotCursorAt: '2026-02-01T00:00:00.000Z',
      missedFloorAt: '2026-02-01T01:00:00.000Z',
      pendingRetry: { rootRunId: 'run-1', attempt: 2, dueAt: '2026-02-01T02:00:00.000Z' }
    };
    const t = okTask({ ...baseTask, retry: { attempts: 2, delayMinutes: 10 }, status });
    expect(t.status.slotCursorAt).toBe(status.slotCursorAt);
    expect(t.status.missedFloorAt).toBe(status.missedFloorAt);
    expect(t.status.pendingRetry).toEqual(status.pendingRetry);
  });
  it('drops a pending retry that has no live retry policy', () => {
    const status = { runCount: 1, runs: [], pendingRetry: { rootRunId: 'run-1', attempt: 2, dueAt: '2026-02-01T02:00:00.000Z' } };
    expect(okTask({ ...baseTask, status }).status.pendingRetry).toBeUndefined();
    expect(okTask({ ...baseTask, retry: { attempts: 0, delayMinutes: 10 }, status }).status.pendingRetry).toBeUndefined();
  });
  it.each([
    ['non-ISO cursor', { slotCursorAt: 'soon', missedFloorAt: 5 }],
    ['pendingRetry empty root', { pendingRetry: { rootRunId: '', attempt: 2, dueAt: '2026-02-01T02:00:00.000Z' } }],
    ['pendingRetry long root', { pendingRetry: { rootRunId: 'x'.repeat(257), attempt: 2, dueAt: '2026-02-01T02:00:00.000Z' } }],
    ['pendingRetry attempt 1', { pendingRetry: { rootRunId: 'r', attempt: 1, dueAt: '2026-02-01T02:00:00.000Z' } }],
    ['pendingRetry attempt 7', { pendingRetry: { rootRunId: 'r', attempt: 7, dueAt: '2026-02-01T02:00:00.000Z' } }],
    ['pendingRetry fractional attempt', { pendingRetry: { rootRunId: 'r', attempt: 2.5, dueAt: '2026-02-01T02:00:00.000Z' } }],
    ['pendingRetry bad dueAt', { pendingRetry: { rootRunId: 'r', attempt: 2, dueAt: 'later' } }],
    ['pendingRetry not an object', { pendingRetry: 'now' }]
  ])('drops invalid status fields (%s)', (_name, extra) => {
    const t = okTask({ ...baseTask, status: { runCount: 0, runs: [], ...extra } });
    expect(t.status.slotCursorAt).toBeUndefined();
    expect(t.status.missedFloorAt).toBeUndefined();
    expect(t.status.pendingRetry).toBeUndefined();
    expect('slotCursorAt' in t.status).toBe(false);
    expect('pendingRetry' in t.status).toBe(false);
  });
  it('keeps run records whole, including new run fields', () => {
    const runs = [{ at: '2026-02-01T00:00:00.000Z', result: 'skipped', marker: true, reasonCode: 'missed-asleep', missed: { count: 2, from: 'a', to: 'b' } }];
    expect(okTask({ ...baseTask, status: { runCount: 0, runs } }).status.runs[0]).toEqual(runs[0]);
  });
  it('a legacy file with none of the fields round-trips unchanged', () => {
    const legacy = {
      ...baseTask,
      description: 'd', prompt: 'p', inboxLevel: 'quiet', autoCloseOnFinish: true,
      status: { runCount: 1, runs: [{ at: '2026-02-01T00:00:00.000Z', result: 'success' }], lastRunAt: '2026-02-01T00:00:00.000Z', lastRunResult: 'success' }
    };
    const t = okTask(legacy);
    const again = okTask(JSON.parse(JSON.stringify(t)));
    expect(JSON.parse(JSON.stringify(again))).toEqual(JSON.parse(JSON.stringify(t)));
    for (const key of ['catchUp', 'retry']) expect(key in t).toBe(false);
    for (const key of ['slotCursorAt', 'missedFloorAt', 'pendingRetry', 'queuedAt']) expect(key in t.status).toBe(false);
    expect(Object.keys(t).sort()).toEqual(Object.keys(okTask(baseTask)).sort());
  });
});

describe('validateScheduleFile: unknown key preservation (C5)', () => {
  it('preserves unknown top-level and status keys', () => {
    const t = okTask({ ...baseTask, futureThing: { a: 1 }, status: { runCount: 0, runs: [], futureCursor: 'x' } }) as unknown as Record<string, unknown> & { status: Record<string, unknown> };
    expect(t.futureThing).toEqual({ a: 1 });
    expect(t.status.futureCursor).toBe('x');
  });
  it('never preserves source, external or status.queuedAt', () => {
    const t = okTask({
      ...baseTask, source: 'global', external: { kind: 'claude-loop' },
      status: { runCount: 0, runs: [], queuedAt: '2026-02-01T00:00:00.000Z' }
    }) as unknown as Record<string, unknown> & { status: Record<string, unknown> };
    expect('source' in t).toBe(false);
    expect('external' in t).toBe(false);
    expect('queuedAt' in t.status).toBe(false);
  });
  it('does not preserve a __proto__ key', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}}');
    const t = okTask({ ...baseTask, ...raw, status: { runCount: 0, runs: [] } });
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect((t as unknown as { polluted?: boolean }).polluted).toBeUndefined();
  });
  it('fills the 4096-char budget field by field: an oversized field drops only itself', () => {
    const t = okTask({ ...baseTask, small: 'ok', big: 'x'.repeat(4100), status: { runCount: 0, runs: [], tiny: 1 } }) as unknown as Record<string, unknown> & { status: Record<string, unknown> };
    expect(t.small).toBe('ok');
    expect('big' in t).toBe(false);
    expect(t.status.tiny).toBe(1);
    const over = okTask({ ...baseTask, a: 'x'.repeat(3000), b: 'y'.repeat(2000) }) as unknown as Record<string, unknown>;
    expect(over.a).toHaveLength(3000);
    expect('b' in over).toBe(false);
  });
  it('keeps extras at or under the cap', () => {
    const t = okTask({ ...baseTask, fine: 'x'.repeat(3000) }) as unknown as Record<string, unknown>;
    expect(t.fine).toHaveLength(3000);
  });
  it('known keys always win over extras and the personaId drop is unchanged', () => {
    const t = okTask({ ...baseTask, personaId: 'pp' }) as unknown as Record<string, unknown>;
    expect('personaId' in t).toBe(false);
  });
});
