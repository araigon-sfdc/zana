/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@zana-ai/zcc-domain/product';

const h = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), update: vi.fn(), onChanged: vi.fn(),
  modal: { onClose: undefined as undefined | (() => void), closeOnBackdrop: undefined as undefined | boolean, hideClose: undefined as undefined | boolean }
}));
vi.mock('../../lib/product-client.js', () => ({ product: { config: { get: h.get, set: h.set, onChanged: h.onChanged }, scheduler: { update: h.update } } }));
vi.mock('../Modal.js', () => ({
  Modal: ({ title, children, footer, onClose, closeOnBackdrop, hideClose }: {
    title: string; children: React.ReactNode; footer?: React.ReactNode; onClose: () => void; closeOnBackdrop?: boolean; hideClose?: boolean;
  }) => {
    h.modal = { onClose, closeOnBackdrop, hideClose };
    return <div role="dialog" aria-label={title}>{children}{footer}</div>;
  }
}));
import { RecoveryCard, RecoveryDialog } from './RecoveryOptIn.js';

const task = (id: string, over: Partial<ScheduledTask> = {}) => ({ id, name: id, projectId: 'p', ...over }) as unknown as ScheduledTask;
const classic = [task('Alpha'), task('Beta')];

beforeEach(() => {
  h.get.mockReset().mockResolvedValue({});
  h.set.mockReset().mockResolvedValue(undefined);
  h.update.mockReset().mockResolvedValue({ ok: true, value: {} });
  h.onChanged.mockReset().mockReturnValue(() => {});
});
afterEach(cleanup);

describe('RecoveryCard', () => {
  it('stays hidden until the config resolves, then shows', async () => {
    let resolve!: (v: unknown) => void;
    h.get.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
    resolve({});
    expect(await screen.findByText('New: missed and failed run recovery.')).toBeTruthy();
  });

  it.each([['dismissed'], ['applied']])('stays hidden when %s', async (value) => {
    h.get.mockResolvedValue({ schedulerRecoveryIntro: value });
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });

  it('stays hidden with no Classic native schedules, or when config fails', async () => {
    const recovery = task('R', { catchUp: { mode: 'once' } });
    const external = task('E', { external: { kind: 'claude-loop' } as ScheduledTask['external'] });
    render(<RecoveryCard tasks={[recovery, external]} onReview={vi.fn()} />);
    await vi.waitFor(() => expect(h.get).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
    cleanup();
    h.get.mockRejectedValue(new Error('offline'));
    render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    await Promise.resolve();
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });

  it('hides itself after the dialog applied recovery to only some schedules', async () => {
    const { rerender } = render(<RecoveryCard tasks={classic} onReview={vi.fn()} refreshKey={false} />);
    expect(await screen.findByText('New: missed and failed run recovery.')).toBeTruthy();
    h.get.mockResolvedValue({ schedulerRecoveryIntro: 'applied' });
    rerender(<RecoveryCard tasks={classic} onReview={vi.fn()} refreshKey={true} />);
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull());
  });

  it('hides when another window answers the offer, and unsubscribes on unmount', async () => {
    const off = vi.fn();
    let push!: (config: Record<string, unknown>) => void;
    h.onChanged.mockImplementation((cb: typeof push) => { push = cb; return off; });
    const { unmount } = render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    expect(await screen.findByText('New: missed and failed run recovery.')).toBeTruthy();
    act(() => push({ schedulerRecoveryIntro: 'dismissed' }));
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
    unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  it('ignores a config read that resolves after unmount', async () => {
    let resolve!: (v: unknown) => void;
    h.get.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { unmount } = render(<RecoveryCard tasks={classic} onReview={vi.fn()} />);
    unmount();
    await act(async () => { resolve({}); });
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });

  it('Review opens the dialog and Not now persists dismissal', async () => {
    const onReview = vi.fn();
    render(<RecoveryCard tasks={classic} onReview={onReview} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'dismissed' });
    expect(screen.queryByRole('region', { name: 'Run recovery' })).toBeNull();
  });
});

describe('RecoveryDialog', () => {
  it('applies the chosen policy to checked schedules only, then marks applied', async () => {
    const onClose = vi.fn();
    render(<RecoveryDialog tasks={[...classic, task('Gamma', { catchUp: { mode: 'skip' } })]} onClose={onClose} />);
    expect(screen.queryByLabelText('Gamma')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Beta' }));
    fireEvent.click(screen.getByRole('radio', { name: /Run each missed time/ }));
    // Number fields keep the typed text and are clamped on apply.
    const max = screen.getByRole('spinbutton', { name: 'Missed runs to catch up' }) as HTMLInputElement;
    fireEvent.change(max, { target: { value: '50' } });
    expect(max.value).toBe('50');
    fireEvent.click(screen.getByRole('radio', { name: /Retry failed runs/ }));
    const attempts = screen.getByRole('spinbutton', { name: 'Retry attempts' }) as HTMLInputElement;
    const delay = screen.getByRole('spinbutton', { name: 'Minutes to wait between retries' }) as HTMLInputElement;
    expect(attempts.value).toBe('1');
    expect(delay.value).toBe('10');
    expect(attempts.className).toBe('settings-input');
    fireEvent.change(attempts, { target: { value: '9' } });
    fireEvent.change(delay, { target: { value: '' } });
    expect(delay.value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 1 schedule' }));
    expect(await screen.findByText('1 turned on')).toBeTruthy();
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith('Alpha', { catchUp: { mode: 'all', max: 10 }, retry: { attempts: 5, delayMinutes: 1 } });
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'applied' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('omits retry when off and uses Run once by default; skip is selectable', async () => {
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    await screen.findByText('2 turned on');
    expect(h.update.mock.calls).toEqual([['Alpha', { catchUp: { mode: 'once' } }], ['Beta', { catchUp: { mode: 'once' } }]]);
    cleanup();
    h.update.mockClear();
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('radio', { name: /Don't catch up/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    await screen.findByText('2 turned on');
    expect(h.update.mock.calls[0]![1]).toEqual({ catchUp: { mode: 'skip' } });
  });

  it('reports each failure by name with its reason in plain words, and still marks applied', async () => {
    h.update.mockResolvedValueOnce({ ok: true, value: {} }).mockResolvedValueOnce({ ok: false, message: 'Error: Unknown metadata project' });
    render(<RecoveryDialog tasks={[...classic, task('Gamma')]} onClose={vi.fn()} />);
    h.update.mockRejectedValueOnce(new Error('disk full'));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 3 schedules' }));
    expect(await screen.findByText('1 turned on')).toBeTruthy();
    expect(screen.getByText('Could not turn on recovery for Beta: its project is missing.')).toBeTruthy();
    expect(screen.getByText('Could not turn on recovery for Gamma: disk full.')).toBeTruthy();
    expect(h.set).toHaveBeenCalledWith({ schedulerRecoveryIntro: 'applied' });
  });

  it('never offers a schedule whose project is missing (it cannot be saved)', () => {
    render(<RecoveryDialog tasks={[...classic, task('Orphan', { projectId: 'gone' })]} projectIds={new Set(['p'])} onClose={vi.fn()} />);
    expect(screen.queryByRole('checkbox', { name: 'Orphan' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on for 2 schedules' })).toBeTruthy();
  });

  it('does not mark applied when everything fails', async () => {
    h.update.mockResolvedValue({ ok: false, message: 'x' });
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 2 schedules' }));
    expect(await screen.findByText('0 turned on')).toBeTruthy();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('disables apply with nothing checked, and Cancel changes nothing', () => {
    const onClose = vi.fn();
    render(<RecoveryDialog tasks={[task('Solo')]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Solo' }));
    expect((screen.getByRole('button', { name: 'Turn on for 0 schedules' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('cannot be cancelled while writing, and stops writing once unmounted', async () => {
    const pending: Array<(v: unknown) => void> = [];
    h.update.mockImplementation(() => new Promise((r) => { pending.push(r); }));
    const onClose = vi.fn();
    const { unmount } = render(<RecoveryDialog tasks={[...classic, task('Gamma')]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on for 3 schedules' }));
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.modal.closeOnBackdrop).toBe(false);
    expect(h.modal.hideClose).toBe(true);
    h.modal.onClose?.();
    expect(onClose).not.toHaveBeenCalled();
    // The parent unmounts the dialog mid-loop: no further schedule is written.
    unmount();
    await act(async () => { pending[0]!({ ok: true, value: {} }); });
    expect(h.update).toHaveBeenCalledTimes(1);
    // Interrupted: not marked applied, so the card can offer the schedules not yet turned on.
    expect(h.set).not.toHaveBeenCalledWith({ schedulerRecoveryIntro: 'applied' });
  });

  it('uses the same cards as the editor: titles with plain descriptions', () => {
    render(<RecoveryDialog tasks={classic} onClose={vi.fn()} />);
    for (const title of ['Run once', 'Run each missed time', "Don't catch up", "Don't retry", 'Retry failed runs']) {
      expect(screen.getByRole('radio', { name: new RegExp(title) })).toBeTruthy();
    }
    expect((screen.getByRole('radio', { name: /^Run once/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Don't retry/ }) as HTMLInputElement).checked).toBe(true);
    // The dialog only turns recovery ON: the original-rules choice isn't offered.
    expect(screen.queryByText(/unless several were missed|skip when busy/)).toBeNull();
  });

  it('shows a note when no Classic schedules remain', () => {
    render(<RecoveryDialog tasks={[task('R', { catchUp: { mode: 'once' } })]} onClose={vi.fn()} />);
    expect(screen.getByText('Every schedule already has recovery turned on.')).toBeTruthy();
  });
});
