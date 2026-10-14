import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { product } from '../../lib/product-client.js';
import type { ScheduleCatchUp, ScheduledTask, ScheduleRetryPolicy } from '@zana-ai/zcc-domain/product';
import { isRecoveryMode } from '@zana-ai/zcc-domain/schedule-health';
import { RETRY_CHOICES, missedRunChoices } from './schedulerUtils.js';
import { Modal } from '../Modal.js';
import './scheduler-problems.css';

/**
 * Native schedules still on their original timing rules (no recovery). With
 * `projectIds`, only those whose project still exists: a schedule whose
 * project is missing can't be saved, so it is never offered.
 */
export const classicSchedules = (tasks: readonly ScheduledTask[], projectIds?: { has(id: string): boolean }): ScheduledTask[] =>
  tasks.filter((t) => !t.external && !isRecoveryMode(t) && (!projectIds || projectIds.has(t.projectId)));

/** A failed update's reason in plain words. */
function failureReason(message: string | undefined): string {
  if (!message) return 'it could not be saved';
  if (/unknown metadata project|project not found|unknown_project/i.test(message)) return 'its project is missing';
  return message.replace(/^Error:\s*/, '');
}

/**
 * One-time offer to turn on missed/failed run recovery. Starts hidden and shows
 * only once the config confirms it was neither dismissed nor applied, so it never flashes.
 */
export function RecoveryCard({ tasks, onReview, refreshKey, projectIds }: { tasks: readonly ScheduledTask[]; onReview: () => void; refreshKey?: unknown; projectIds?: { has(id: string): boolean } }) {
  const [unanswered, setUnanswered] = useState(false);

  useEffect(() => {
    let active = true;
    product.config
      .get()
      .then((c) => { if (active) setUnanswered(!c.schedulerRecoveryIntro); })
      .catch(() => {});
    // "Not now" or "applied" in another window hides the card here too.
    const off = product.config.onChanged?.((c) => { if (active) setUnanswered(!c.schedulerRecoveryIntro); });
    return () => { active = false; off?.(); };
  }, [refreshKey]);

  if (!unanswered || classicSchedules(tasks, projectIds).length === 0) return null;

  const notNow = () => {
    setUnanswered(false);
    product.config.set({ schedulerRecoveryIntro: 'dismissed' }).catch(() => {});
  };

  return (
    <section className="recovery-card" role="region" aria-label="Run recovery">
      <RotateCcw size={16} aria-hidden />
      <div className="recovery-card-text">
        <strong>New: missed and failed run recovery.</strong>
        <span>
          Your schedules still run exactly as before. Turn on recovery to catch up missed runs, queue runs over the limit, and optionally retry temporary failures.
        </span>
      </div>
      <div className="recovery-card-actions">
        <button type="button" className="settings-btn settings-btn--primary" onClick={onReview}>Review</button>
        <button type="button" className="settings-btn" onClick={notNow}>Not now</button>
      </div>
    </section>
  );
}

type MissedChoice = 'once' | 'skip' | 'all';

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : min));
/** Number fields keep the raw text while typing and are clamped only on apply. */
const clampText = (text: string, min: number, max: number) => clamp(parseInt(text, 10), min, max);

export function RecoveryDialog({ tasks, onClose, projectIds }: { tasks: readonly ScheduledTask[]; onClose: () => void; projectIds?: { has(id: string): boolean } }) {
  const classic = useMemo(() => classicSchedules(tasks, projectIds), [tasks, projectIds]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(classic.map((t) => t.id)));
  const [missed, setMissed] = useState<MissedChoice>('once');
  const [missedMax, setMissedMax] = useState('3');
  const [retryOn, setRetryOn] = useState(false);
  const [attempts, setAttempts] = useState('1');
  const [delay, setDelay] = useState('10');
  const [applying, setApplying] = useState(false);
  // Set on unmount: an apply loop still running must stop writing.
  const cancelledRef = useRef(false);
  // Reset on (re)mount, flag on unmount: a remount must not start out cancelled.
  useEffect(() => { cancelledRef.current = false; return () => { cancelledRef.current = true; }; }, []);
  const [outcome, setOutcome] = useState<{ done: number; failed: Array<{ name: string; reason: string }> } | null>(null);

  const targets = classic.filter((t) => checked.has(t.id));
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (!next.delete(id)) next.add(id);
    setChecked(next);
  };

  const apply = async () => {
    if (targets.length === 0 || applying) return;
    setApplying(true);
    const catchUp: ScheduleCatchUp = missed === 'all' ? { mode: 'all', max: clampText(missedMax, 1, 10) } : { mode: missed };
    const retry: ScheduleRetryPolicy | null = retryOn
      ? { attempts: clampText(attempts, 1, 5), delayMinutes: clampText(delay, 1, 1440) }
      : null;
    let done = 0;
    const failed: Array<{ name: string; reason: string }> = [];
    for (const task of targets) {
      if (cancelledRef.current) break;
      try {
        const result = await product.scheduler.update(task.id, { catchUp, ...(retry ? { retry } : {}) });
        if (result.ok) done++;
        else failed.push({ name: task.name, reason: failureReason(result.message) });
      } catch (error) {
        failed.push({ name: task.name, reason: failureReason(error instanceof Error ? error.message : undefined) });
      }
    }
    // Interrupted mid-loop: the card stays, so it can offer the schedules not yet turned on.
    if (cancelledRef.current) return;
    if (done > 0) await product.config.set({ schedulerRecoveryIntro: 'applied' }).catch(() => {});
    setOutcome({ done, failed });
    setApplying(false);
  };
  // While writing, the dialog can't be dismissed: Cancel would look like it undid the writes.
  const close = applying ? () => {} : onClose;

  return (
    <Modal
      title="Turn on recovery"
      onClose={close}
      closeOnBackdrop={!applying}
      hideClose={applying}
      className="recovery-dialog"
      footer={
        outcome ? (
          <button type="button" className="btn primary" onClick={onClose} autoFocus>Done</button>
        ) : (
          <>
            <button type="button" className="btn" disabled={applying} onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={targets.length === 0 || applying} onClick={() => void apply()}>
              {applying ? 'Turning on…' : `Turn on for ${targets.length} ${targets.length === 1 ? 'schedule' : 'schedules'}`}
            </button>
          </>
        )
      }
    >
      {outcome ? (
        <div role="status" className="recovery-dialog-result">
          <p>{outcome.done} turned on</p>
          {outcome.failed.map((f) => (
            <p key={f.name} className="modal-error">Could not turn on recovery for {f.name}: {f.reason}.</p>
          ))}
        </div>
      ) : (
        <div className="recovery-dialog-body">
          <fieldset>
            <legend>Schedules</legend>
            {classic.length === 0 ? (
              <p className="modal-hint">Every schedule already has recovery turned on.</p>
            ) : classic.map((t) => (
              <label key={t.id} className="scheduler-checkbox-row">
                <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
                <span>{t.name}</span>
              </label>
            ))}
          </fieldset>
          <div className="scheduler-form-field">
            <label>Missed runs</label>
            <div className="scheduler-scope-picker" role="radiogroup" aria-label="Missed runs">
              {missedRunChoices('interval', false).map(({ value, title, hint }) => (
                <label key={value} className={`scheduler-scope-option ${missed === value ? 'is-active' : ''}`}>
                  <input type="radio" name="recovery-missed" value={value} checked={missed === value}
                    onChange={() => setMissed(value as MissedChoice)} />
                  <div className="scheduler-scope-option-body">
                    <span className="scheduler-scope-title">{title}</span>
                    <span className="scheduler-scope-hint">{hint}</span>
                  </div>
                </label>
              ))}
            </div>
            {missed === 'all' && (
              <div className="recovery-inline">
                <span aria-hidden>Up to</span>
                <input id="recovery-missed-max" className="settings-input" type="number" min={1} max={10} value={missedMax}
                  aria-label="Missed runs to catch up" onChange={(e) => setMissedMax(e.target.value)} />
                <span aria-hidden>missed times</span>
              </div>
            )}
          </div>
          <div className="scheduler-form-field">
            <label>Auto-retry</label>
            <div className="scheduler-scope-picker" role="radiogroup" aria-label="Auto-retry">
              {RETRY_CHOICES.map(({ value, title, hint }) => (
                <label key={value} className={`scheduler-scope-option ${(retryOn ? 'on' : 'off') === value ? 'is-active' : ''}`}>
                  <input type="radio" name="recovery-retry" value={value} checked={(retryOn ? 'on' : 'off') === value}
                    onChange={() => setRetryOn(value === 'on')} />
                  <div className="scheduler-scope-option-body">
                    <span className="scheduler-scope-title">{title}</span>
                    <span className="scheduler-scope-hint">{hint}</span>
                  </div>
                </label>
              ))}
            </div>
            {retryOn && (
              <div className="recovery-inline">
                <span aria-hidden>Up to</span>
                <input id="recovery-attempts" className="settings-input" type="number" min={1} max={5} value={attempts}
                  aria-label="Retry attempts" onChange={(e) => setAttempts(e.target.value)} />
                <span aria-hidden>times, waiting</span>
                <input id="recovery-delay" className="settings-input" type="number" min={1} max={1440} value={delay}
                  aria-label="Minutes to wait between retries" onChange={(e) => setDelay(e.target.value)} />
                <span aria-hidden>minutes first</span>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
