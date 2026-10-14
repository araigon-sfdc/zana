import type { ScheduleRun } from '@zana-ai/zcc-domain/product';
import { SCHEDULE_REASONS, reasonHint, reasonLabel, runOutcome, runReason } from '@zana-ai/zcc-domain/schedule-health';
import { formatDuration } from './schedulerUtils.js';
import './run-outcome.css';

const OUTCOME_LABEL = {
  success: 'Success',
  error: 'Error',
  skipped: 'Skipped',
  incomplete: 'Incomplete',
  missed: 'Missed'
} as const;

function clock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface RunOutcomeBadgeProps {
  run: ScheduleRun;
  /** Total attempts allowed by the schedule's retry policy; renders "Attempt n/max". */
  maxAttempts?: number;
}

/** The run's outcome word, a reason chip (hint + message on hover) and context badges. */
export function RunOutcomeBadge({ run, maxAttempts }: RunOutcomeBadgeProps) {
  const outcome = runOutcome(run);
  const reason = runReason(run);
  const chipTitle = [reason ? reasonHint(reason) : '', run.message ?? ''].filter(Boolean).join('\n');
  const attempt = typeof run.attempt === 'number' && run.attempt > 1 ? run.attempt : undefined;
  const late = typeof run.lateByMs === 'number' && run.lateByMs > 0 && run.lateCause
    ? `Ran ${formatDuration(run.lateByMs)} late · ${run.lateCause === 'asleep' ? 'Laptop asleep' : 'Zana closed'}`
    : undefined;
  const missed = run.missed && run.missed.count > 0 ? run.missed : undefined;
  const range = missed ? [clock(missed.from), clock(missed.to)].filter(Boolean) : [];

  return (
    <span className="run-outcome">
      <span className={`run-outcome-word run-outcome-word--${outcome}`}>{OUTCOME_LABEL[outcome]}</span>
      {reason && reason in SCHEDULE_REASONS ? (
        <span className="run-outcome-chip" title={chipTitle || undefined}>{reasonLabel(reason)}</span>
      ) : null}
      {attempt ? (
        <span className="run-outcome-badge">{maxAttempts ? `Attempt ${attempt}/${maxAttempts}` : `Attempt ${attempt}`}</span>
      ) : null}
      {run.trigger === 'catch-up' ? <span className="run-outcome-badge">Catch-up</span> : null}
      {late ? <span className="run-outcome-badge">{late}</span> : null}
      {missed ? (
        <span className="run-outcome-badge">
          {`${missed.count} ${missed.count === 1 ? 'slot' : 'slots'}`}
          {range.length === 2 ? ` ${range[0]}-${range[1]}` : ''}
        </span>
      ) : null}
    </span>
  );
}
