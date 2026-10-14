import { describe, expect, it, vi } from 'vitest';
import { formatRunsTable, parseRefs, parseRunsArgs, parseSince, runScheduleRunsCommand, type LiveCall } from '../lib/commands/schedule-runs.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  scheduleId: 's1', scheduleName: 'Nightly', projectId: 'p', run: { id: 'r1', at: '2026-10-14T01:30:00.000Z', result: 'error', attempt: 2 },
  outcome: 'error', reason: 'exit-nonzero', problem: true, open: true, manualRetry: true, ...over
});
const mockCall = (value: unknown): LiveCall & ReturnType<typeof vi.fn> => vi.fn(async () => ({ value })) as never;

describe('parseSince', () => {
  it('accepts relative units and ISO, rejects junk', () => {
    expect(parseSince('24h', NOW)).toBe('2026-10-13T12:00:00.000Z');
    expect(parseSince('7d', NOW)).toBe('2026-10-07T12:00:00.000Z');
    expect(parseSince('30m', NOW)).toBe('2026-10-14T11:30:00.000Z');
    expect(parseSince('2w', NOW)).toBe('2026-09-30T12:00:00.000Z');
    expect(parseSince('2026-10-01T00:00:00Z', NOW)).toBe('2026-10-01T00:00:00.000Z');
    expect(parseSince('soon', NOW)).toBeUndefined();
    expect(parseSince('99999999d', NOW)).toBeUndefined();
  });
});

describe('parseRunsArgs', () => {
  it('defaults to an empty query', () => {
    expect(parseRunsArgs([], NOW)).toEqual({ ok: true, value: {} });
  });
  it('parses every flag, in both forms', () => {
    const parsed = parseRunsArgs(['--problems', '--outcome', 'error,missed', '--reason=timeout,exit-nonzero', '--since', '24h', '--project', 'p1',
      '--schedule', 'a', '--schedule=b', '--limit', '20'], NOW);
    expect(parsed).toEqual({ ok: true, value: {
      state: 'problems', outcomes: ['error', 'missed'], reasonCodes: ['timeout', 'exit-nonzero'], since: '2026-10-13T12:00:00.000Z',
      projectId: 'p1', scheduleIds: ['a', 'b'], limit: 20
    } });
    expect(parseRunsArgs(['--all'], NOW)).toMatchObject({ value: { state: 'all' } });
    expect(parseRunsArgs(['--open', '--open'], NOW)).toMatchObject({ value: { state: 'open' } });
  });
  it.each([
    [['--open', '--all']], [['--bogus']], [['positional']], [['--outcome']], [['--outcome', 'nope']], [['--outcome', ',']], [['--reason', 'nope']],
    [['--since', 'yesterday']], [['--limit', '0']], [['--limit', '501']], [['--limit', 'x']], [['--project']], [['--schedule', '--all']],
    [Array.from({ length: 51 }, (_, i) => ['--schedule', `s${i}`]).flat()]
  ])('rejects %j', args => {
    expect(parseRunsArgs(args, NOW).ok).toBe(false);
  });
});

describe('parseRefs', () => {
  it('splits on the last colon (schedule ids may contain colons) and enforces bounds', () => {
    expect(parseRefs(['acme:nightly:uuid-1'], 50)).toEqual({ ok: true, value: [{ scheduleId: 'acme:nightly', runId: 'uuid-1' }] });
    for (const bad of [[], ['nocolon'], [':x'], ['x:'], ['--open']]) expect(parseRefs(bad, 50).ok).toBe(false);
    expect(parseRefs(Array.from({ length: 51 }, () => 'a:b'), 50).ok).toBe(false);
    expect(parseRefs(Array.from({ length: 50 }, () => 'a:b'), 50).ok).toBe(true);
  });
});

describe('formatRunsTable', () => {
  it('prints an aligned table and a truncation footer', () => {
    const out = formatRunsTable({ rows: [row() as never, row({ scheduleName: 'Hourly', reason: undefined, outcome: 'success', run: { id: 'r2', at: 'garbage' } }) as never], total: 5, truncated: true });
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toMatch(/^WHEN +SCHEDULE +OUTCOME +REASON +ATTEMPT +REF$/);
    expect(lines[1]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} +Nightly +error +Exited with an error +2 +s1:r1$/);
    expect(lines[2]).toMatch(/garbage +Hourly +success +1 +s1:r2$/);
    expect(lines[3]).toBe('2 of 5');
  });
  it('says so when empty', () => {
    expect(formatRunsTable({ rows: [], total: 0, truncated: false })).toBe('No runs.\n');
  });
});

describe('runScheduleRunsCommand', () => {
  const result = { rows: [row()], total: 1, truncated: false };

  it('runs: queries sched.runs and renders table or JSON', async () => {
    const call = mockCall(result);
    const human = await runScheduleRunsCommand('runs', ['--problems'], false, call, NOW);
    expect(call).toHaveBeenCalledWith('sched.runs', { query: { state: 'problems' } });
    expect(human.stdout).toContain('Nightly');
    expect(JSON.parse((await runScheduleRunsCommand('runs', [], true, call, NOW)).stdout)).toEqual(result);
    expect((await runScheduleRunsCommand('runs', ['--limit', '0'], false, call, NOW)).exitCode).toBe(2);
  });

  it('passes control-plane errors through', async () => {
    const error = { exitCode: 1, stdout: '', stderr: 'Error: nope\n' };
    const call = vi.fn(async () => ({ error })) as never as LiveCall;
    for (const sub of ['runs', 'dismiss', 'retry'] as const) {
      expect(await runScheduleRunsCommand(sub, sub === 'runs' ? [] : ['a:b'], false, call, NOW)).toEqual(error);
    }
    expect(await runScheduleRunsCommand('retry', ['--open'], false, call, NOW)).toEqual(error);
  });

  it('retry: explicit refs print one line each', async () => {
    const call = mockCall([{ scheduleId: 'a', runId: 'b', ok: true, status: 'started' }, { scheduleId: 'c', runId: 'd', ok: false, error: 'run not found' }, { scheduleId: 'e', runId: 'f', ok: true }]);
    const out = await runScheduleRunsCommand('retry', ['a:b', 'c:d', 'e:f'], false, call);
    expect(call).toHaveBeenCalledWith('sched.retry', { refs: [{ scheduleId: 'a', runId: 'b' }, { scheduleId: 'c', runId: 'd' }, { scheduleId: 'e', runId: 'f' }] });
    expect(out.stdout).toBe('started  a:b\nerror  c:d  run not found\nstarted  e:f\n');
    expect(out.exitCode).toBe(1);
    const asJson = await runScheduleRunsCommand('retry', ['a:b'], true, call);
    expect(JSON.parse(asJson.stdout)).toHaveLength(3);
    expect(asJson.exitCode).toBe(1);
    const ok = await runScheduleRunsCommand('retry', ['a:b'], false, mockCall([{ scheduleId: 'a', runId: 'b', ok: true, status: 'queued' }]));
    expect(ok).toMatchObject({ exitCode: 0, stdout: 'queued  a:b\n' });
  });

  it('retry: usage errors exit 2', async () => {
    const call = mockCall([]);
    for (const args of [[], ['bad'], ['--open', 'a:b'], ['--dry-run'], ['--dry-run', 'a:b'], Array.from({ length: 51 }, () => 'a:b')]) {
      expect((await runScheduleRunsCommand('retry', args, false, call)).exitCode).toBe(2);
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('retry --open only retries rows with manualRetry, capped at 50', async () => {
    const rows = [row({ run: { id: 'r1', at: '2026-10-14T01:00:00Z', result: 'error' } }), row({ manualRetry: false, run: { id: 'r2', at: '2026-10-14T01:00:00Z', result: 'error' } }), row({ run: { at: 'x', result: 'error' } })];
    const call = vi.fn(async (op: string) => ({ value: op === 'sched.runs' ? { rows, total: 3, truncated: false } : [{ scheduleId: 's1', runId: 'r1', ok: true, status: 'queued' }] })) as never as LiveCall & ReturnType<typeof vi.fn>;
    const out = await runScheduleRunsCommand('retry', ['--open'], false, call);
    expect(call).toHaveBeenNthCalledWith(1, 'sched.runs', { query: { state: 'open', limit: 500 } });
    expect(call).toHaveBeenNthCalledWith(2, 'sched.retry', { refs: [{ scheduleId: 's1', runId: 'r1' }] });
    expect(out.stdout).toBe('queued  s1:r1\n');
  });

  it('retry --open --dry-run only prints', async () => {
    const many = Array.from({ length: 52 }, (_, i) => row({ scheduleId: `s${i}`, run: { id: `r${i}`, at: '2026-10-14T01:00:00Z', result: 'error' } }));
    const call = mockCall({ rows: many, total: 52, truncated: false });
    const out = await runScheduleRunsCommand('retry', ['--open', '--dry-run'], false, call);
    expect(call).toHaveBeenCalledTimes(1);
    expect(out.stdout.split('\n')[0]).toBe('would retry  s0:r0');
    expect(out.stdout).toContain('50 of 52');
    // One retry per schedule: further open rows of the same schedule would only replace it.
    const sameSchedule = Array.from({ length: 4 }, (_, i) => row({ run: { id: `r${i}`, at: '2026-10-14T01:00:00Z', result: 'error' } }));
    const one = await runScheduleRunsCommand('retry', ['--open', '--dry-run'], false, mockCall({ rows: sameSchedule, total: 4, truncated: false }));
    expect(one.stdout).toBe('would retry  s1:r0\n1 of 4\n');
    expect(JSON.parse((await runScheduleRunsCommand('retry', ['--open', '--dry-run'], true, call)).stdout)).toMatchObject({ dryRun: true, total: 52 });
    const none = mockCall({ rows: [], total: 0, truncated: false });
    expect((await runScheduleRunsCommand('retry', ['--open', '--dry-run'], false, none)).stdout).toBe('Nothing to retry.\n');
    expect((await runScheduleRunsCommand('retry', ['--open'], false, none)).stdout).toBe('Nothing to retry.\n');
    expect(JSON.parse((await runScheduleRunsCommand('retry', ['--open'], true, none)).stdout)).toEqual([]);
    expect(none).not.toHaveBeenCalledWith('sched.retry', expect.anything());
  });

  it('dismiss: sends refs, reports the count, enforces 200', async () => {
    const call = mockCall(2);
    const out = await runScheduleRunsCommand('dismiss', ['a:b', 'c:d'], false, call);
    expect(call).toHaveBeenCalledWith('sched.dismiss', { refs: [{ scheduleId: 'a', runId: 'b' }, { scheduleId: 'c', runId: 'd' }] });
    expect(out.stdout).toBe('Dismissed 2 of 2.\n');
    expect(JSON.parse((await runScheduleRunsCommand('dismiss', ['a:b'], true, call)).stdout)).toBe(2);
    expect((await runScheduleRunsCommand('dismiss', [], false, call)).exitCode).toBe(2);
    expect((await runScheduleRunsCommand('dismiss', Array.from({ length: 201 }, () => 'a:b'), false, call)).exitCode).toBe(2);
    expect((await runScheduleRunsCommand('dismiss', Array.from({ length: 200 }, () => 'a:b'), false, mockCall(200))).exitCode).toBe(0);
    // Like retry, any ref that wasn't dismissed fails the command.
    const partial = await runScheduleRunsCommand('dismiss', ['a:b', 'c:d'], false, mockCall(1));
    expect(partial.exitCode).toBe(1);
    expect(partial.stdout).toBe('Dismissed 1 of 2.\n');
    expect((await runScheduleRunsCommand('dismiss', ['a:b', 'c:d'], true, mockCall(0))).exitCode).toBe(1);
  });

  it('accumulates repeated --outcome / --reason flags', () => {
    const parsed = parseRunsArgs(['--outcome', 'error', '--outcome', 'missed,error', '--reason', 'timeout', '--reason', 'no-report'], Date.now());
    expect(parsed).toMatchObject({ ok: true, value: { outcomes: ['error', 'missed'], reasonCodes: ['timeout', 'no-report'] } });
  });

  it('prints "-" as the REF of a run without an id', () => {
    const out = formatRunsTable({ rows: [row({ run: { at: '2026-10-14T01:00:00Z', result: 'error' } }) as never], total: 1, truncated: false });
    expect(out.trimEnd().split('\n')[1]).toMatch(/ -$/);
  });
});
