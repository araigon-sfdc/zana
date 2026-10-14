/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask, TerminalSession } from '@zana-ai/zcc-domain/product';

const setEnabled = vi.fn();
const runNow = vi.fn();
const retryRuns = vi.fn();
const dismissRuns = vi.fn();
const close = vi.fn();
const pushToast = vi.fn();

const terminals: Record<string, TerminalSession[]> = {};

vi.mock('../../lib/product-client.js', () => ({
  product: {
    scheduler: {
      setEnabled: (...args: unknown[]) => setEnabled(...args),
      runNow: (...args: unknown[]) => runNow(...args),
      retryRuns: (...args: unknown[]) => retryRuns(...args),
      dismissRuns: (...args: unknown[]) => dismissRuns(...args)
    },
    terminals: { close: (...args: unknown[]) => close(...args) }
  }
}));

vi.mock('../../store.js', () => ({
  useData: (selector: (s: { terminals: Record<string, TerminalSession[]> }) => unknown) =>
    selector({ terminals }),
  useUi: Object.assign(
    (selector: (s: { pushToast: typeof pushToast }) => unknown) => selector({ pushToast }),
    { getState: () => ({ pushToast }) }
  )
}));

import { ScheduleInfoPanel, retryAtLabel } from './ScheduleInfoPanel.js';

const baseTask = {
  id: 'sched-1',
  name: 'Morning digest',
  enabled: true,
  projectId: 'p1',
  profile: 'claude',
  schedule: { every: '1h' },
  overlap: 'skip',
  history: { retain: 10 },
  status: { runCount: 0, runs: [], lastRunAt: undefined, nextRunAt: undefined },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z'
} as ScheduledTask;

describe('ScheduleInfoPanel', () => {
  it('shows a pending worker and disables actions that would start more work', () => {
    render(<ScheduleInfoPanel task={{ ...baseTask, enabled: false, status: { runCount: 0, runs: [{ at: new Date().toISOString(), launchState: 'pending', sessionId: 'reserved', result: 'skipped' }] } }} />);
    expect(screen.getByTestId('pending-worker-recovery')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Run now/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Resume/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('lists the cause of a failed run and hides messages on successful runs', () => {
    render(<ScheduleInfoPanel task={{ ...baseTask, status: { runCount: 2, runs: [
      { id: 'r2', at: new Date().toISOString(), result: 'error', message: 'Squad requirements are unavailable' },
      { id: 'r1', at: new Date().toISOString(), result: 'success', message: 'all good' }
    ] } }} />);
    expect(screen.queryByText('Squad requirements are unavailable')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'View run details' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'View run details' }));
    expect(within(screen.getByRole('dialog')).getByText('Squad requirements are unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  afterEach(() => {
    cleanup();
    setEnabled.mockReset();
    runNow.mockReset();
    retryRuns.mockReset();
    dismissRuns.mockReset();
    close.mockReset();
    pushToast.mockReset();
    for (const key of Object.keys(terminals)) delete terminals[key];
  });

  it('asks the user to save before showing run history', () => {
    render(<ScheduleInfoPanel task={null} />);
    expect(screen.getByTestId('schedule-info-panel').textContent).toContain(
      'Save this schedule to start recording runs.'
    );
  });

  it('shows status, run history, and mutating footer actions', async () => {
    const onDuplicate = vi.fn();
    const onAskDelete = vi.fn();
    runNow.mockResolvedValue({ ok: true });
    setEnabled.mockResolvedValue({ ok: true });
    const task = {
      ...baseTask,
      status: {
        runCount: 1,
        lastRunAt: '2026-01-01T00:00:00Z',
        lastRunResult: 'success',
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
        runs: [
          {
            at: '2026-01-01T00:00:00Z',
            result: 'success',
            durationMs: 1200,
            report: '# Done'
          }
        ]
      }
    } as ScheduledTask;
    render(
      <ScheduleInfoPanel
        task={task}
        onDuplicate={onDuplicate}
        onAskDelete={onAskDelete}
      />
    );
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByTestId('schedule-run-report').textContent).toContain('Done');
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await vi.waitFor(() => expect(runNow).toHaveBeenCalledWith('sched-1'));
    fireEvent.click(screen.getByRole('button', { name: /Pause/ }));
    await vi.waitFor(() => expect(setEnabled).toHaveBeenCalledWith('sched-1', false));
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/ }));
    expect(onDuplicate).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));
    expect(onAskDelete).toHaveBeenCalled();
  });

  it('shows a running pill without peek or live-split controls', () => {
    terminals.p1 = [{ id: 'sess-1', status: 'running' } as TerminalSession];
    const task = {
      ...baseTask,
      status: {
        runCount: 1,
        runs: [{ at: '2026-01-01T00:00:00Z', result: 'success', sessionId: 'sess-1' }]
      }
    } as ScheduledTask;
    render(<ScheduleInfoPanel task={task} />);
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open live in split' })).toBeNull();
    expect(screen.queryByLabelText('Peek running terminal')).toBeNull();
    expect(screen.getByLabelText('Stop running terminal')).toBeTruthy();
  });

  it('hides mutating actions for external claude-loop schedules', () => {
    const task = {
      ...baseTask,
      external: { kind: 'claude-loop' }
    } as ScheduledTask;
    render(
      <ScheduleInfoPanel
        task={task}
        onDuplicate={() => undefined}
        onAskDelete={() => undefined}
      />
    );
    expect(screen.queryByRole('button', { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pause/ })).toBeNull();
  });

  it('stops a live session and surfaces failures', async () => {
    terminals.p1 = [{ id: 'sess-1', status: 'running' } as TerminalSession];
    close.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const task = {
      ...baseTask,
      status: {
        runCount: 1,
        runs: [{ at: '2026-01-01T00:00:00Z', result: 'success', sessionId: 'sess-1' }]
      }
    } as ScheduledTask;
    const { rerender } = render(<ScheduleInfoPanel task={task} />);
    fireEvent.click(screen.getByLabelText('Stop running terminal'));
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith('sess-1'));
    expect(pushToast).toHaveBeenCalledWith('Stopped "Morning digest"', 'info');

    rerender(<ScheduleInfoPanel task={task} />);
    fireEvent.click(screen.getByLabelText('Stop running terminal'));
    await vi.waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith('Failed to stop "Morning digest"', 'error')
    );
  });

  it('toasts when run-now or pause fail', async () => {
    runNow.mockResolvedValue({ ok: false, message: 'busy' });
    setEnabled.mockResolvedValue({ ok: false, message: 'denied' });
    render(<ScheduleInfoPanel task={{ ...baseTask, enabled: false } as ScheduledTask} />);
    expect(screen.getByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: busy', 'error'));
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('denied', 'error'));
  });

  it('toasts the recorded cause when run-now was accepted but the launch was refused, and fired otherwise', async () => {
    const withRun = (result: string, message?: string) => ({
      ...baseTask,
      status: { runCount: 1, runs: [{ id: 'r', at: new Date().toISOString(), result, message }] }
    }) as unknown as ScheduledTask;
    runNow.mockResolvedValueOnce({ ok: true, value: withRun('error', 'Squad requirements are unavailable') });
    render(<ScheduleInfoPanel task={baseTask} />);
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: Squad requirements are unavailable', 'error'));
    expect(pushToast).not.toHaveBeenCalledWith('Fired "Morning digest"', 'info');
    runNow.mockResolvedValueOnce({ ok: true, value: withRun('success') });
    fireEvent.click(screen.getByRole('button', { name: /Run now/ }));
    await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Fired "Morning digest"', 'info'));
  });

  describe('run reasons and actions', () => {
    const failedRun = { id: 'run-1', at: new Date(Date.now() - 60_000).toISOString(), result: 'error', reasonCode: 'exit-nonzero' } as const;
    const withRuns = (runs: unknown[], extra: Partial<ScheduledTask> = {}) => ({
      ...baseTask, catchUp: { mode: 'once' }, ...extra,
      status: { ...baseTask.status, runCount: runs.length, runs, ...(extra.status ?? {}) }
    }) as ScheduledTask;

    it('shows the outcome badge and Retry/Dismiss for an open problem', async () => {
      retryRuns.mockResolvedValue({ ok: true, value: [{ scheduleId: 'sched-1', runId: 'run-1', ok: true, status: 'started' }] });
      dismissRuns.mockResolvedValue({ ok: true, value: 1 });
      render(<ScheduleInfoPanel task={withRuns([failedRun])} />);
      expect(screen.getByText('Error')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect(retryRuns).toHaveBeenCalledWith([{ scheduleId: 'sched-1', runId: 'run-1' }]));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Fired "Morning digest"', 'info'));
      await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss Morning digest run' }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss Morning digest run' }));
      await vi.waitFor(() => expect(dismissRuns).toHaveBeenCalledWith([{ scheduleId: 'sched-1', runId: 'run-1' }]));
    });

    it('labels the action Run now for a missed run', () => {
      render(<ScheduleInfoPanel task={withRuns([{ ...failedRun, reasonCode: 'missed-asleep', result: 'skipped' }])} />);
      expect(screen.getByRole('button', { name: 'Run now Morning digest run' })).toBeTruthy();
    });

    it('disables both buttons while the action is pending', async () => {
      let release!: (v: unknown) => void;
      retryRuns.mockReturnValue(new Promise((resolve) => { release = resolve; }));
      render(<ScheduleInfoPanel task={withRuns([failedRun])} />);
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss Morning digest run' }) as HTMLButtonElement).disabled).toBe(true));
      release({ ok: true, value: [{ scheduleId: 'sched-1', runId: 'run-1', ok: true }] });
      await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss Morning digest run' }) as HTMLButtonElement).disabled).toBe(false));
    });

    it('shows failure notices for transport, per-run and dismiss errors', async () => {
      render(<ScheduleInfoPanel task={withRuns([failedRun])} />);
      retryRuns.mockResolvedValueOnce({ ok: false, message: 'offline' });
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: offline', 'error'));
      retryRuns.mockResolvedValueOnce({ ok: true, value: [{ scheduleId: 'sched-1', runId: 'run-1', ok: false, error: 'Previous run still active' }] });
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: Previous run still active', 'error'));
      retryRuns.mockResolvedValueOnce({ ok: true, value: [{ scheduleId: 'sched-1', runId: 'run-1', ok: false }] });
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: not started', 'error'));
      dismissRuns.mockResolvedValueOnce({ ok: false, message: 'denied' });
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Dismiss failed: denied', 'error'));
    });

    it('hides actions for successes, dismissed or old problems, id-less runs and external rows', () => {
      const old = { ...failedRun, id: 'old', at: new Date(Date.now() - 30 * 86_400_000).toISOString() };
      const { rerender } = render(<ScheduleInfoPanel task={withRuns([
        { id: 'ok', at: new Date().toISOString(), result: 'success' },
        { ...failedRun, id: 'd', dismissedAt: new Date().toISOString() },
        old,
        { ...failedRun, id: undefined }
      ])} />);
      expect(screen.queryByRole('button', { name: /Retry Morning digest run/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Dismiss Morning digest run/ })).toBeNull();
      rerender(<ScheduleInfoPanel task={withRuns([{ ...failedRun, reasonCode: 'overlap' }])} />);
      expect(screen.queryByRole('button', { name: /Retry Morning digest run/ })).toBeNull();
      rerender(<ScheduleInfoPanel task={withRuns([failedRun], { external: { kind: 'claude-loop' } as ScheduledTask['external'] })} />);
      expect(screen.queryByRole('button', { name: /Retry Morning digest run/ })).toBeNull();
      expect(screen.queryByText('Recovery off')).toBeNull();
    });

    it('shows only history.retain rows', () => {
      const runs = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, at: new Date(Date.now() - i * 1000).toISOString(), result: 'success' }));
      const { container } = render(<ScheduleInfoPanel task={withRuns(runs, { history: { retain: 2 } })} />);
      expect(container.querySelectorAll('.scheduler-run-row')).toHaveLength(2);
    });

    it('hides actions for a failure a later finished success closed, even without resolvedBy', () => {
      const ok = { id: 'ok', at: new Date().toISOString(), result: 'success', durationMs: 5 };
      render(<ScheduleInfoPanel task={withRuns([ok, failedRun])} />);
      expect(screen.queryByRole('button', { name: 'Retry Morning digest run' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Dismiss Morning digest run' })).toBeNull();
    });

    it('shows the attempt alone once manual retries pass the policy', () => {
      render(<ScheduleInfoPanel task={withRuns([{ ...failedRun, attempt: 4 }], { retry: { attempts: 1, delayMinutes: 10 } })} />);
      expect(screen.getByText('Attempt 4')).toBeTruthy();
      expect(screen.queryByText('Attempt 4/2')).toBeNull();
    });

    it('reports a thrown retry or dismiss call', async () => {
      render(<ScheduleInfoPanel task={withRuns([failedRun])} />);
      retryRuns.mockRejectedValueOnce(new Error('ipc down'));
      fireEvent.click(screen.getByRole('button', { name: 'Retry Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Run failed: ipc down', 'error'));
      await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Dismiss Morning digest run' }) as HTMLButtonElement).disabled).toBe(false));
      dismissRuns.mockRejectedValueOnce('nope');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss Morning digest run' }));
      await vi.waitFor(() => expect(pushToast).toHaveBeenCalledWith('Dismiss failed: nope', 'error'));
    });

    it('formats Retry at with the date when the retry is not today', () => {
      const now = new Date(2026, 9, 14, 9, 0);
      expect(retryAtLabel(new Date(2026, 9, 14, 14, 30).toISOString(), now)).not.toMatch(/,/);
      expect(retryAtLabel(new Date(2026, 9, 16, 14, 30).toISOString(), now)).toMatch(/16.*,/);
      expect(retryAtLabel('garbage', now)).toBe('');
    });

    it('shows Queued, Retry at and Recovery off chips', () => {
      const due = new Date(2026, 0, 1, 14, 30).toISOString();
      const { rerender } = render(<ScheduleInfoPanel task={withRuns([], { catchUp: undefined, status: { runCount: 0, runs: [], queuedAt: '2026-01-01T00:00:00Z', pendingRetry: { rootRunId: 'x', attempt: 1, dueAt: due } } })} />);
      expect(screen.getByText('Queued')).toBeTruthy();
      expect(screen.getByText(/^Retry at /)).toBeTruthy();
      expect(screen.getByText('Recovery off').getAttribute('title')).toContain("follow this schedule's original rules");
      rerender(<ScheduleInfoPanel task={withRuns([])} />);
      expect(screen.queryByText('Queued')).toBeNull();
      expect(screen.queryByText(/^Retry at /)).toBeNull();
      expect(screen.queryByText('Recovery off')).toBeNull();
    });
  });
});
