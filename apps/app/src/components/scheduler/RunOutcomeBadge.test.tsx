/**
 * @vitest-environment happy-dom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ScheduleRun } from '@zana-ai/zcc-domain/product';
import { RunOutcomeBadge } from './RunOutcomeBadge.js';

afterEach(cleanup);

const run = (over: Partial<ScheduleRun>): ScheduleRun => ({ at: '2026-10-14T08:00:00.000Z', result: 'success', ...over });

function word(container: HTMLElement) {
  return container.querySelector('.run-outcome-word')!;
}
const chip = (c: HTMLElement) => c.querySelector('.run-outcome-chip') as HTMLElement | null;
const badges = (c: HTMLElement) => Array.from(c.querySelectorAll('.run-outcome-badge')).map((n) => n.textContent);

describe('RunOutcomeBadge', () => {
  it.each([
    [run({ result: 'success' }), 'Success', 'success'],
    [run({ result: 'error', reasonCode: 'exit-nonzero' }), 'Error', 'error'],
    [run({ result: 'skipped', reasonCode: 'concurrency-cap' }), 'Skipped', 'skipped'],
    [run({ result: 'incomplete' }), 'Incomplete', 'incomplete'],
    [run({ result: 'skipped', reasonCode: 'missed-asleep', marker: true }), 'Missed', 'missed']
  ])('renders the outcome word %#', (r, text, cls) => {
    const { container } = render(<RunOutcomeBadge run={r} />);
    expect(word(container).textContent).toBe(text);
    expect(word(container).className).toContain(`run-outcome-word--${cls}`);
  });

  it('shows no chip for a plain success', () => {
    const { container } = render(<RunOutcomeBadge run={run({})} />);
    expect(chip(container)).toBeNull();
    expect(badges(container)).toEqual([]);
  });

  it('chip title is the hint, then the message on a new line', () => {
    const { container } = render(<RunOutcomeBadge run={run({ result: 'error', reasonCode: 'exit-nonzero', message: 'exit 1' })} />);
    expect(chip(container)!.textContent).toBe('Exited with an error');
    expect(chip(container)!.getAttribute('title')).toBe('Open the session to see the output.\nexit 1');
  });

  it('infers the chip for a legacy run with only a message', () => {
    const { container } = render(<RunOutcomeBadge run={run({ result: 'error', message: 'exceeded maximum duration (30m)' })} />);
    expect(chip(container)!.textContent).toBe('Hit max duration');
  });

  it('shows no chip for an unexplained legacy error', () => {
    const { container } = render(<RunOutcomeBadge run={run({ result: 'error', message: 'weird' })} />);
    expect(chip(container)).toBeNull();
  });

  it('title is just the hint when there is no message', () => {
    const { container } = render(<RunOutcomeBadge run={run({ result: 'skipped', reasonCode: 'queue-full' })} />);
    expect(chip(container)!.getAttribute('title')).toBe('The run queue was full.');
  });

  it('Attempt badge appears from attempt 2, with an optional max', () => {
    expect(badges(render(<RunOutcomeBadge run={run({ attempt: 1 })} />).container)).toEqual([]);
    cleanup();
    expect(badges(render(<RunOutcomeBadge run={run({ attempt: 2 })} />).container)).toEqual(['Attempt 2']);
    cleanup();
    expect(badges(render(<RunOutcomeBadge run={run({ attempt: 3 })} maxAttempts={3} />).container)).toEqual(['Attempt 3/3']);
  });

  it('Catch-up badge', () => {
    expect(badges(render(<RunOutcomeBadge run={run({ trigger: 'catch-up' })} />).container)).toEqual(['Catch-up']);
  });

  it('late badge names the cause', () => {
    expect(badges(render(<RunOutcomeBadge run={run({ lateByMs: 3 * 3_600_000, lateCause: 'asleep' })} />).container))
      .toEqual(['Ran 3h 0m late · Laptop asleep']);
    cleanup();
    expect(badges(render(<RunOutcomeBadge run={run({ lateByMs: 90_000, lateCause: 'app-closed' })} />).container))
      .toEqual(['Ran 1m 30s late · Zana closed']);
    cleanup();
    expect(badges(render(<RunOutcomeBadge run={run({ lateByMs: 90_000 })} />).container)).toEqual([]);
  });

  it('slots badge shows count and range, singular for one', () => {
    const from = '2026-10-14T06:00:00.000Z';
    const to = '2026-10-14T08:00:00.000Z';
    const { container } = render(
      <RunOutcomeBadge run={run({ result: 'skipped', reasonCode: 'missed-app-closed', missed: { count: 3, from, to } })} />
    );
    const [text] = badges(container);
    expect(text).toMatch(/^3 slots \d{2}:\d{2}.*-\d{2}:\d{2}/);
    cleanup();
    const one = render(<RunOutcomeBadge run={run({ result: 'skipped', reasonCode: 'missed-asleep', missed: { count: 1, from: 'bad', to: 'bad' } })} />);
    expect(badges(one.container)).toEqual(['1 slot']);
  });
});
