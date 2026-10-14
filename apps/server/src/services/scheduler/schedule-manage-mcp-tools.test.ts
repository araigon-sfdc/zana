import { describe, it, expect, vi } from 'vitest';
import {
  registerScheduleManageTools,
  resolveSchedule,
  scopeSchedules,
  projectSchedule,
  formatResolveError,
  type ScheduleAgentApi
} from './schedule-manage-mcp-tools.js';
import type { ScheduledTask } from '@zana-ai/zcc-domain/product';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}>;

function fakeServer() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }
  };
  return { server, tools };
}

function text(res: { content: Array<{ type: string; text?: string }> }): string {
  return res.content.find((c) => c.type === 'text')?.text ?? '';
}

function payload(res: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(text(res));
}

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'qa-hourly',
    name: 'Hourly QA sweep',
    enabled: true,
    projectId: 'proj-1',
    profile: 'claude',
    prompt: 'Run the suite. Do not leak this.',
    extraArgs: ['--secret-token'],
    schedule: { every: '1h' },
    overlap: 'skip',
    history: { retain: 10 },
    status: {
      runCount: 3,
      lastRunAt: '2026-09-01T10:00:00.000Z',
      nextRunAt: '2026-09-01T11:00:00.000Z',
      lastRunResult: 'success',
      runs: [
        {
          id: 'run-1',
          at: '2026-09-01T10:00:00.000Z',
          result: 'success'
        }
      ]
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...over
  };
}

function makeApi(tasks: ScheduledTask[], over: Partial<ScheduleAgentApi> = {}): ScheduleAgentApi {
  return {
    list: vi.fn(() => tasks),
    runNow: vi.fn((id: string) => {
      const t = tasks.find((s) => s.id === id);
      if (!t) throw new Error(`schedule not found: ${id}`);
      return t;
    }),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const t = tasks.find((s) => s.id === id);
      if (!t) return null;
      return { ...t, enabled };
    }),
    ...over
  };
}

describe('scopeSchedules', () => {
  const a = makeTask({ id: 'a', projectId: 'proj-1' });
  const b = makeTask({ id: 'b', projectId: 'proj-2' });

  it('confines to the route project by default', () => {
    expect(scopeSchedules([a, b], 'proj-1', false).map((t) => t.id)).toEqual(['a']);
  });

  it('returns the full list when allProjects is true', () => {
    expect(scopeSchedules([a, b], 'proj-1', true).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('resolveSchedule', () => {
  const hourly = makeTask({ id: 'qa-hourly', name: 'Hourly QA sweep' });
  const nightly = makeTask({ id: 'qa-nightly', name: 'Nightly QA sweep' });
  const twinA = makeTask({ id: 'watch-1', name: 'Watchdog' });
  const twinB = makeTask({ id: 'watch-2', name: 'Watchdog' });

  it('matches exact id first', () => {
    const r = resolveSchedule([hourly, nightly], 'qa-hourly');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe('qa-hourly');
  });

  it('matches a unique case-insensitive name', () => {
    const r = resolveSchedule([hourly, nightly], 'hourly qa sweep');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe('qa-hourly');
  });

  it('matches a unique id prefix', () => {
    const r = resolveSchedule([hourly, nightly], 'qa-n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe('qa-nightly');
  });

  it('reports ambiguous names with candidates', () => {
    const r = resolveSchedule([twinA, twinB], 'watchdog');
    expect(r).toEqual({
      ok: false,
      reason: 'ambiguous',
      candidates: [
        { id: 'watch-1', name: 'Watchdog' },
        { id: 'watch-2', name: 'Watchdog' }
      ]
    });
  });

  it('reports an ambiguous id prefix with candidates', () => {
    const r = resolveSchedule([hourly, nightly], 'qa-');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('returns not_found for an unknown query', () => {
    expect(resolveSchedule([hourly], 'nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_found for a blank query', () => {
    expect(resolveSchedule([hourly], '   ')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('prefers exact id over a colliding name', () => {
    const namedLikeId = makeTask({ id: 'other', name: 'qa-hourly' });
    const r = resolveSchedule([hourly, namedLikeId], 'qa-hourly');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.task.id).toBe('qa-hourly');
  });
});

describe('projectSchedule', () => {
  it('projects cadence + status and omits prompt, extraArgs, and run history', () => {
    const hit = projectSchedule(makeTask());
    expect(hit).toEqual({
      id: 'qa-hourly',
      name: 'Hourly QA sweep',
      enabled: true,
      projectId: 'proj-1',
      schedule: { every: '1h' },
      lastRunAt: '2026-09-01T10:00:00.000Z',
      nextRunAt: '2026-09-01T11:00:00.000Z',
      lastRunResult: 'success',
      runCount: 3
    });
    expect(hit).not.toHaveProperty('prompt');
    expect(hit).not.toHaveProperty('extraArgs');
    expect(hit).not.toHaveProperty('status');
  });

  it('includes cron + tz when present', () => {
    const hit = projectSchedule(
      makeTask({ schedule: { cron: '0 9 * * 1-5', tz: 'Europe/Paris' } })
    );
    expect(hit.schedule).toEqual({ cron: '0 9 * * 1-5', tz: 'Europe/Paris' });
  });
});

describe('formatResolveError', () => {
  it('does not list candidates on not_found', () => {
    expect(formatResolveError({ ok: false, reason: 'not_found' }, 'secret')).toBe(
      'schedule not found: secret'
    );
  });
});

describe('registerScheduleManageTools', () => {
  const local = makeTask();
  const other = makeTask({
    id: 'gift-qa',
    name: 'Gift-card QA',
    projectId: 'proj-2',
    prompt: 'other secret'
  });

  it('registers all six schedule_* tools', () => {
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, {
      projectId: 'proj-1',
      scheduleAgentApi: makeApi([local])
    });
    expect([...tools.keys()].sort()).toEqual([
      'schedule_dismiss',
      'schedule_get',
      'schedule_list',
      'schedule_reload',
      'schedule_retry',
      'schedule_run_now',
      'schedule_runs',
      'schedule_set_enabled',
      'schedule_update'
    ]);
  });

  it('schedule_list defaults to THIS project and omits internals', async () => {
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, {
      projectId: 'proj-1',
      scheduleAgentApi: makeApi([local, other])
    });
    const out = payload(await tools.get('schedule_list')!({}));
    expect(out.scope).toBe('project:proj-1');
    expect(out.count).toBe(1);
    expect(out.schedules[0].id).toBe('qa-hourly');
    expect(out.schedules[0]).not.toHaveProperty('prompt');
    expect(out.schedules.some((s: { projectId: string }) => s.projectId === 'proj-2')).toBe(false);
  });

  it('schedule_list allProjects lists every schedule', async () => {
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, {
      projectId: 'proj-1',
      scheduleAgentApi: makeApi([local, other])
    });
    const out = payload(await tools.get('schedule_list')!({ allProjects: true }));
    expect(out.scope).toBe('all-projects');
    expect(out.schedules.map((s: { id: string }) => s.id).sort()).toEqual(['gift-qa', 'qa-hourly']);
  });

  it('schedule_run_now fires by name within this project', async () => {
    const api = makeApi([local, other]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_run_now')!({ id: 'Hourly QA sweep' });
    expect(res.isError).toBeFalsy();
    expect(api.runNow).toHaveBeenCalledWith('qa-hourly');
    expect(payload(res).schedule.id).toBe('qa-hourly');
  });

  it('schedule_run_now hides a cross-project id without allProjects', async () => {
    const api = makeApi([local, other]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_run_now')!({ id: 'gift-qa' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('schedule not found: gift-qa');
    expect(api.runNow).not.toHaveBeenCalled();
  });

  it('schedule_run_now with allProjects can fire another project\'s schedule', async () => {
    const api = makeApi([local, other]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_run_now')!({ id: 'gift-qa', allProjects: true });
    expect(res.isError).toBeFalsy();
    expect(api.runNow).toHaveBeenCalledWith('gift-qa');
  });

  it('schedule_run_now reports ambiguous names without firing', async () => {
    const api = makeApi([
      makeTask({ id: 'watch-1', name: 'Watchdog' }),
      makeTask({ id: 'watch-2', name: 'Watchdog' })
    ]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_run_now')!({ id: 'Watchdog' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('ambiguous');
    expect(text(res)).toContain('watch-1');
    expect(api.runNow).not.toHaveBeenCalled();
  });

  it('schedule_set_enabled toggles by unique id prefix', async () => {
    const api = makeApi([local]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_set_enabled')!({ id: 'qa-h', enabled: false });
    expect(res.isError).toBeFalsy();
    expect(api.setEnabled).toHaveBeenCalledWith('qa-hourly', false);
    expect(payload(res).action).toBe('disable');
    expect(payload(res).schedule.enabled).toBe(false);
  });

  it('schedule_set_enabled reports a vanished id as an error', async () => {
    const api = makeApi([local], { setEnabled: vi.fn(() => null) });
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_set_enabled')!({ id: 'qa-hourly', enabled: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('schedule not found');
  });

  it('a throwing manager surfaces as isError, not an exception', async () => {
    const api = makeApi([local], {
      runNow: vi.fn(() => {
        throw new Error('overlap skip');
      })
    });
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const res = await tools.get('schedule_run_now')!({ id: 'qa-hourly' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('schedule_run_now failed: overlap skip');
  });

  it('ignores a smuggled projectId — the route id is the authority', async () => {
    const api = makeApi([local, other]);
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    const out = payload(
      await tools.get('schedule_list')!({ allProjects: false, projectId: 'proj-2' })
    );
    expect(out.scope).toBe('project:proj-1');
    expect(out.schedules.map((s: { id: string }) => s.id)).toEqual(['qa-hourly']);
  });
});

describe('schedule definition agent operations', () => {
  function fixture() {
    const task = makeTask();
    const api = makeApi([task, makeTask({ id: 'foreign', projectId: 'other' })], {
      get: vi.fn(() => task),
      update: vi.fn(async (_id, patch) => ({ ...task, ...patch })),
      reload: vi.fn(async () => ({ reloaded: false, reason: 'run worker is live', sessionIds: ['worker'], schedule: task }))
    });
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    return { task, api, tools };
  }
  it('gets the live prompt, arguments, timestamp and cadence by name', async () => {
    const { api, tools } = fixture();
    const out = payload(await tools.get('schedule_get')!({ id: 'Hourly QA sweep' }));
    expect(api.get).toHaveBeenCalledWith('qa-hourly');
    expect(out.schedule).toMatchObject({ prompt: 'Run the suite. Do not leak this.', extraArgs: ['--secret-token'], updatedAt: '2026-09-01T10:00:00.000Z', schedule: { every: '1h' } });
    expect(out.schedule).not.toHaveProperty('runs');
  });
  it('passes a strict definition patch to the UI manager and returns its acknowledgement', async () => {
    const { api, tools } = fixture(); const patch = { prompt: 'New', extraArgs: ['--effort', 'high'], every: '2h' };
    const out = payload(await tools.get('schedule_update')!({ id: 'qa-h', patch }));
    expect(api.update).toHaveBeenCalledWith('qa-hourly', patch); expect(out.schedule.prompt).toBe('New');
  });
  it('reports reload deferral and the exact blocking sessions', async () => {
    const { api, tools } = fixture();
    const out = payload(await tools.get('schedule_reload')!({ id: 'qa-hourly' }));
    expect(api.reload).toHaveBeenCalledWith('qa-hourly');
    expect(out).toMatchObject({ ok: true, reloaded: false, reason: 'run worker is live', sessionIds: ['worker'] });
  });
  it.each(['schedule_get', 'schedule_update', 'schedule_reload'])('confines %s unless explicitly widened', async name => {
    const { tools } = fixture();
    expect((await tools.get(name)!({ id: 'foreign', patch: { prompt: 'New' }, projectId: 'other' })).isError).toBe(true);
    expect((await tools.get(name)!({ id: 'foreign', patch: { prompt: 'New' }, allProjects: true })).isError).toBeFalsy();
  });
  it.each([{}, { enabled: true }, { projectId: 'forged' }, { extraArgs: [1] }, { prompt: 1 }, { every: '1h', cron: '* * * * *' }])('rejects an invalid patch before mutation: %j', async patch => {
    const { api, tools } = fixture(); expect((await tools.get('schedule_update')!({ id: 'qa-hourly', patch })).isError).toBe(true); expect(api.update).not.toHaveBeenCalled();
  });
  it.each(['schedule_get', 'schedule_reload', 'schedule_update'])('surfaces owner failures for %s', async name => {
    const { api, tools } = fixture();
    api.get = () => { throw new Error('Owner offline'); }; api.reload = async () => { throw new Error('Owner offline'); }; api.update = async () => { throw new Error('Owner offline'); };
    const result = await tools.get(name)!({ id: 'qa-hourly', patch: { prompt: 'New' } });
    expect(result.isError).toBe(true); expect(text(result)).toContain('Owner offline');
  });
});

describe('schedule_runs / schedule_retry / schedule_dismiss', () => {
  const mine = makeTask({ id: 'mine', projectId: 'proj-1' });
  const foreign = makeTask({ id: 'foreign', projectId: 'proj-2' });
  const rows = [
    { scheduleId: 'mine', run: { id: 'r1' }, manualRetry: true },
    { scheduleId: 'mine', run: { id: 'r2' }, manualRetry: false },
    { scheduleId: 'foreign', run: { id: 'r3' }, manualRetry: true },
    { scheduleId: 'mine', run: {}, manualRetry: true }
  ];
  function setup(over: Partial<ScheduleAgentApi> = {}) {
    const api = makeApi([mine, foreign], {
      queryRuns: vi.fn(async () => ({ rows: rows as never, total: rows.length, truncated: false })),
      retryRuns: vi.fn(async (refs) => refs.map((ref) => ({ ...ref, ok: true, status: 'started' as const }))),
      dismissRuns: vi.fn(async (refs) => refs.length),
      ...over
    });
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: api });
    return { api, tools };
  }

  it('schedule_runs scopes the query to the route project and never trusts a supplied projectId', async () => {
    const { api, tools } = setup();
    const out = payload(await tools.get('schedule_runs')!({ state: 'problems', limit: 5, projectId: 'proj-2' }));
    expect(api.queryRuns).toHaveBeenCalledWith({ state: 'problems', limit: 5, projectId: 'proj-1' });
    expect(out).toMatchObject({ scope: 'project:proj-1', total: 4 });
    await tools.get('schedule_runs')!({ allProjects: true });
    expect(api.queryRuns).toHaveBeenLastCalledWith({});
    expect(payload(await tools.get('schedule_runs')!({ allProjects: true })).scope).toBe('all-projects');
  });

  it('schedule_retry retries in-scope refs and rejects out-of-scope ones as not found', async () => {
    const { api, tools } = setup();
    const out = payload(await tools.get('schedule_retry')!({ refs: [{ scheduleId: 'mine', runId: 'r1' }, { scheduleId: 'foreign', runId: 'r3' }] }));
    expect(api.retryRuns).toHaveBeenCalledWith([{ scheduleId: 'mine', runId: 'r1' }]);
    // Partial success: the call worked (`ok`), but not every ref (`allOk`).
    expect(out.ok).toBe(true);
    expect(out.allOk).toBe(false);
    expect(out.results).toEqual([
      { scheduleId: 'mine', runId: 'r1', ok: true, status: 'started' },
      { scheduleId: 'foreign', runId: 'r3', ok: false, error: 'schedule not found' }
    ]);
    const widened = payload(await tools.get('schedule_retry')!({ refs: [{ scheduleId: 'foreign', runId: 'r3' }], allProjects: true }));
    expect(widened).toMatchObject({ ok: true, allOk: true });
    const nothing = payload(await tools.get('schedule_retry')!({ refs: [{ scheduleId: 'foreign', runId: 'r3' }] }));
    expect(nothing).toMatchObject({ ok: false, allOk: false });
  });

  it('schedule_retry open:true sends one ref per schedule', async () => {
    const many = [
      { scheduleId: 'mine', run: { id: 'n1' }, manualRetry: true },
      { scheduleId: 'mine', run: { id: 'n2' }, manualRetry: true },
      { scheduleId: 'mine', run: { id: 'n3' }, manualRetry: true }
    ];
    const { api, tools } = setup({ queryRuns: vi.fn(async () => ({ rows: many as never, total: 3, truncated: false })) });
    await tools.get('schedule_retry')!({ open: true });
    expect(api.retryRuns).toHaveBeenCalledWith([{ scheduleId: 'mine', runId: 'n1' }]);
  });

  it('schedule_runs returns compact rows, not full run records', async () => {
    const full = [{ scheduleId: 'mine', scheduleName: 'Nightly', projectId: 'proj-1', outcome: 'error', reason: 'exit-nonzero', open: true, manualRetry: true,
      run: { id: 'r9', at: '2026-10-14T01:00:00Z', result: 'error', message: 'x'.repeat(400), report: 'long markdown report', sessionId: 's9' } }];
    const { tools } = setup({ queryRuns: vi.fn(async () => ({ rows: full as never, total: 1, truncated: false })) });
    const out = payload(await tools.get('schedule_runs')!({}));
    expect(out.rows).toEqual([expect.objectContaining({ scheduleId: 'mine', runId: 'r9', reason: 'exit-nonzero', label: 'Exited with an error', attempt: 1, sessionId: 's9' })]);
    expect(out.rows[0].message).toHaveLength(200);
    expect(out.rows[0]).not.toHaveProperty('run');
    expect(JSON.stringify(out)).not.toContain('long markdown report');
  });

  it('schedule_retry open:true queries this project and retries only retryable rows with an id', async () => {
    const { api, tools } = setup();
    const out = payload(await tools.get('schedule_retry')!({ open: true }));
    expect(api.queryRuns).toHaveBeenCalledWith({ state: 'open', limit: 500, projectId: 'proj-1' });
    expect(api.retryRuns).toHaveBeenCalledWith([{ scheduleId: 'mine', runId: 'r1' }]);
    // The fake owner ignores projectId, so its foreign row comes back and is rejected.
    expect(out.results.map((r: { scheduleId: string; ok: boolean }) => [r.scheduleId, r.ok])).toEqual([['mine', true], ['foreign', false]]);
    await tools.get('schedule_retry')!({ open: true, allProjects: true });
    expect(api.queryRuns).toHaveBeenLastCalledWith({ state: 'open', limit: 500 });
  });

  it('schedule_retry open:true with nothing to do makes no retry call', async () => {
    const { api, tools } = setup({ queryRuns: vi.fn(async () => ({ rows: [], total: 0, truncated: false })) });
    expect(payload(await tools.get('schedule_retry')!({ open: true }))).toMatchObject({ ok: true, count: 0 });
    expect(api.retryRuns).not.toHaveBeenCalled();
  });

  it.each([{}, { open: true, refs: [{ scheduleId: 'mine', runId: 'r1' }] }, { open: false }])('schedule_retry requires exactly one of refs / open: %j', async (input) => {
    const { api, tools } = setup();
    const res = await tools.get('schedule_retry')!(input);
    expect(res.isError).toBe(true);
    expect(api.retryRuns).not.toHaveBeenCalled();
  });

  it('schedule_dismiss dismisses in-scope refs only', async () => {
    const { api, tools } = setup();
    const out = payload(await tools.get('schedule_dismiss')!({ refs: [{ scheduleId: 'mine', runId: 'r1' }, { scheduleId: 'foreign', runId: 'r3' }] }));
    expect(api.dismissRuns).toHaveBeenCalledWith([{ scheduleId: 'mine', runId: 'r1' }]);
    expect(out).toEqual({ ok: true, allOk: false, dismissed: 1, rejected: [{ scheduleId: 'foreign', runId: 'r3' }] });
    const none = payload(await tools.get('schedule_dismiss')!({ refs: [{ scheduleId: 'foreign', runId: 'r3' }] }));
    expect(none).toMatchObject({ ok: false, dismissed: 0 });
    expect(api.dismissRuns).toHaveBeenCalledTimes(1);
  });

  it.each(['schedule_runs', 'schedule_retry', 'schedule_dismiss'])('%s reports a clear error when the owner API lacks run history', async (name) => {
    const { server, tools } = fakeServer();
    registerScheduleManageTools(server as never, { projectId: 'proj-1', scheduleAgentApi: makeApi([mine]) });
    const res = await tools.get(name)!({ refs: [{ scheduleId: 'mine', runId: 'r' }], open: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Schedule run history is unavailable');
  });

  it.each(['schedule_runs', 'schedule_retry', 'schedule_dismiss'])('%s surfaces owner failures', async (name) => {
    const boom = async () => { throw new Error('Owner offline'); };
    const { tools } = setup({ queryRuns: boom, retryRuns: boom, dismissRuns: boom });
    const res = await tools.get(name)!({ refs: [{ scheduleId: 'mine', runId: 'r' }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Owner offline');
  });
});
