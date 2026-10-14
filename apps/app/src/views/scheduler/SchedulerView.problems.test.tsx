/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledTask } from '@zana-ai/zcc-domain/product';

const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  projects: [{ id: 'p1', name: 'Garden' }, { id: 'p2', name: 'Shop' }],
  panelProps: null as null | Record<string, any>,
  overviewProps: null as null | Record<string, any>,
  openLive: vi.fn()
}));

vi.mock('../../lib/product-client.js', () => ({ product: { scheduler: {}, terminals: {}, config: { get: vi.fn(), set: vi.fn() } } }));
vi.mock('@/store', () => {
  const ui = { setNav: vi.fn(), revealScheduleId: null, clearRevealSchedule: vi.fn() };
  const useUi: any = (select: (s: typeof ui) => unknown) => select(ui);
  useUi.getState = () => ui;
  return {
    useData: (select: (s: { projects: unknown[] }) => unknown) => select({ projects: h.projects }),
    useScheduler: (select: (s: { tasks: unknown[]; loading: boolean }) => unknown) => select({ tasks: h.tasks, loading: false }),
    useScheduleGroups: (select: (s: { groups: unknown[] }) => unknown) => select({ groups: [] }),
    useUi
  };
});
vi.mock('@/hooks/useCompactLayout', () => ({ useCompactLayout: () => false }));
vi.mock('@/hooks/useIsCompactViewport', () => ({ isCompactViewport: () => false }));
vi.mock('@/components/MobilePageHeader', () => ({ MobilePageHeader: () => null }));
vi.mock('@/components/AuroraGrid', () => ({ AuroraGrid: () => null }));
vi.mock('@/components/ScheduleGroupsModal', () => ({ ScheduleGroupsModal: () => null }));
vi.mock('@/components/scheduler/EmptyStateWithFeatured', () => ({ EmptyStateWithFeatured: () => <div>empty</div> }));
vi.mock('@/components/scheduler/ScheduleRow', () => ({ ScheduleRow: () => null }));
vi.mock('@/components/scheduler/DeleteConfirmModal', () => ({ DeleteConfirmModal: () => null }));
vi.mock('@/components/scheduler/TemplatePickerModal', () => ({ TemplatePickerModal: () => null }));
vi.mock('@/components/scheduler/ScheduleFilters', () => ({ ScheduleFilters: () => null }));
vi.mock('@/components/scheduler/openScheduledLive', () => ({ openScheduledLive: h.openLive }));
vi.mock('@/components/scheduler/SchedulerOverview', () => ({
  SchedulerOverview: (props: Record<string, any>) => { h.overviewProps = props; return <div data-testid="overview">overview {props.tasks.length}</div>; }
}));
vi.mock('@/components/scheduler/ProblemsPanel', () => ({
  ProblemsPanel: (props: Record<string, any>) => { h.panelProps = props; return <div data-testid="problems">problems {props.tasks.length}</div>; }
}));
vi.mock('@/components/scheduler/RecoveryOptIn', () => ({
  RecoveryDialog: ({ tasks, onClose }: { tasks: unknown[]; onClose: () => void }) => (
    <div role="dialog" aria-label="recovery">{tasks.length}<button onClick={onClose}>close</button></div>
  )
}));

import { SchedulerView } from './SchedulerView';

const task = (id: string, projectId: string) => ({ id, name: id, projectId, enabled: true, status: { runs: [], runCount: 0 } }) as unknown as ScheduledTask;
const mount = (projectId?: string) => render(<MemoryRouter><SchedulerView projectId={projectId} /></MemoryRouter>);

beforeEach(() => { h.tasks = [task('a', 'p1'), task('b', 'p2')]; h.panelProps = null; h.overviewProps = null; h.openLive.mockReset(); });
afterEach(cleanup);

describe('SchedulerView Problems segment', () => {
  it('toggles Overview · Schedules · Problems with aria-pressed', () => {
    mount();
    const group = screen.getByRole('group', { name: 'Scheduler view' });
    const button = (name: string) => group.querySelector(`button:nth-of-type(${name})`) as HTMLButtonElement;
    expect(button('1').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Problems/ }));
    expect(screen.getByTestId('problems').textContent).toBe('problems 2');
    expect(button('3').getAttribute('aria-pressed')).toBe('true');
    expect(button('1').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /Overview/ }));
    expect(screen.getByTestId('overview')).toBeTruthy();
  });

  it('scopes the workbench to the locked project', () => {
    mount('p1');
    fireEvent.click(screen.getByRole('button', { name: /Problems/ }));
    expect(screen.getByTestId('problems').textContent).toBe('problems 1');
    expect(h.panelProps!.tasks.map((t: ScheduledTask) => t.id)).toEqual(['a']);
  });

  it('wires the overview banner to Problems and opens sessions through the live route', () => {
    mount();
    h.overviewProps!.onReviewProblems();
    return vi.waitFor(() => expect(screen.getByTestId('problems')).toBeTruthy()).then(() => {
      h.panelProps!.onOpenSession('sess', 'p1');
      expect(h.openLive).toHaveBeenCalledWith('p1', 'sess', expect.any(Function));
    });
  });

  it('opens and closes the recovery dialog from the card and the Problems link', () => {
    mount();
    h.overviewProps!.onTurnOnRecovery();
    return vi.waitFor(() => expect(screen.getByRole('dialog', { name: 'recovery' }).textContent).toContain('2')).then(() => {
      fireEvent.click(screen.getByRole('button', { name: 'close' }));
      expect(screen.queryByRole('dialog', { name: 'recovery' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /Problems/ }));
      h.panelProps!.onTurnOnRecovery();
      return vi.waitFor(() => expect(screen.getByRole('dialog', { name: 'recovery' })).toBeTruthy());
    });
  });

  it('hides the segmented control when there is nothing to show', () => {
    h.tasks = [];
    mount();
    expect(screen.queryByRole('group', { name: 'Scheduler view' })).toBeNull();
  });
});
