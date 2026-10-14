/**
 * One place to interpret a schedule's cadence (`{ every }` vs `{ cron, tz }`),
 * shared by the main-process scheduler and every renderer display site so a
 * cron schedule never falls through a code path that assumed `every` is always
 * present. Pairs with {@link ./parse-every.ts} and {@link ./parse-cron.ts}.
 */
import { formatInterval, parseEvery } from './parse-every.js';
import { describeCron, isValidCron, nextCronRunAt } from './parse-cron.js';
import { Cron } from 'croner';

/** The cadence half of a schedule (subset of `ScheduledTask.schedule`). */
export interface ScheduleCadence {
  every?: string;
  cron?: string;
  tz?: string;
}

/** True when the cadence is cron-based (as opposed to interval-based). */
export function isCronCadence(s: ScheduleCadence): boolean {
  return typeof s.cron === 'string' && s.cron.trim().length > 0;
}

/**
 * Validate that a cadence sets exactly one of `every` / `cron` AND that the
 * chosen one parses. Returns null on success or a human reason on failure —
 * the single gate used by store validation and the manager's create/update.
 */
export function validateCadence(s: ScheduleCadence): string | null {
  const hasEvery = typeof s.every === 'string' && s.every.trim().length > 0;
  const hasCron = typeof s.cron === 'string' && s.cron.trim().length > 0;
  if (hasEvery && hasCron) return 'set exactly one of every / cron, not both';
  if (!hasEvery && !hasCron) return 'missing schedule cadence (every or cron)';
  if (hasEvery && parseEvery(s.every!) === null) return `invalid interval: ${s.every}`;
  if (hasCron && !isValidCron(s.cron!, s.tz)) return `invalid cron: ${s.cron}`;
  return null;
}

/**
 * Short label for a cadence, used across the rail, palette, and agent board:
 *  - cron  → a friendly paraphrase ("weekdays at 09:00") or the raw expression.
 *  - every → "every 1h 30m" via the interval formatter.
 * Never throws; degrades to the raw string it was given.
 */
export function scheduleSummary(s: ScheduleCadence): string {
  if (isCronCadence(s)) {
    const label = describeCron(s.cron!);
    return s.tz ? `${label} (${s.tz})` : label;
  }
  if (s.every) {
    const ms = parseEvery(s.every);
    return ms !== null ? `every ${formatInterval(ms)}` : s.every;
  }
  return '—';
}

/**
 * Next fire time (epoch ms) for a cadence relative to `from`, or null if it
 * can't be computed. For `every` this is `from + interval` (the scheduler's
 * `arm` applies the smarter lastRun-relative math; this is the simple preview
 * form). For `cron` it's the true next wall-clock slot.
 */
export function nextRunMsFrom(s: ScheduleCadence, from: Date): number | null {
  if (isCronCadence(s)) {
    const next = nextCronRunAt(s.cron!, s.tz, from);
    return next ? next.getTime() : null;
  }
  if (s.every) {
    const ms = parseEvery(s.every);
    return ms !== null ? from.getTime() + ms : null;
  }
  return null;
}

/** Result of {@link slotsBetween}: slot count plus the first and last slot (epoch ms). */
export interface SlotsBetween {
  /** Slots counted, at most `cap`: a display value once `capped`. */
  count: number;
  first?: number;
  /** The true newest slot in the window, even when the count was capped. */
  last?: number;
  /** More slots exist than were counted. */
  capped?: boolean;
}

/**
 * Count the cadence slots in `(afterMsExclusive, untilMsInclusive]`, stopping
 * at `cap`. Interval slots are `after + k*interval` (k >= 1); cron slots
 * iterate `nextCronRunAt` from `after`. Never throws; an invalid cadence or an
 * empty window yields `{ count: 0 }`.
 */
/**
 * The `n` newest cron slots at or before `untilMsInclusive`, oldest first.
 * Never throws; an invalid expression yields `[]`.
 */
export function previousCronSlots(expr: string, tz: string | undefined, untilMsInclusive: number, n: number): number[] {
  if (!Number.isFinite(untilMsInclusive) || n < 1) return [];
  try {
    const cron = new Cron(expr.trim(), tz ? { timezone: tz } : undefined);
    return cron.previousRuns(n, new Date(untilMsInclusive + 1_000))
      .map(date => date.getTime())
      .filter(ms => ms <= untilMsInclusive)
      .reverse();
  } catch {
    return [];
  }
}

export function slotsBetween(
  cadence: ScheduleCadence,
  afterMsExclusive: number,
  untilMsInclusive: number,
  cap = 1000
): SlotsBetween {
  if (!Number.isFinite(afterMsExclusive) || !Number.isFinite(untilMsInclusive) || untilMsInclusive <= afterMsExclusive || cap < 1) {
    return { count: 0 };
  }
  if (isCronCadence(cadence)) {
    let count = 0;
    let first: number | undefined;
    let last: number | undefined;
    let cursor = afterMsExclusive;
    let cron: Cron;
    try {
      // One parse for the whole walk, not one per slot.
      cron = new Cron(cadence.cron!.trim(), cadence.tz ? { timezone: cadence.tz } : undefined);
    } catch {
      return { count: 0 };
    }
    const nextAfter = (ms: number): number | undefined => {
      try {
        const next = cron.nextRun(new Date(ms));
        return next && next.getTime() > ms && next.getTime() <= untilMsInclusive ? next.getTime() : undefined;
      } catch {
        return undefined;
      }
    };
    for (let next = nextAfter(cursor); next !== undefined && count < cap; next = nextAfter(cursor)) {
      cursor = next;
      first ??= cursor;
      last = cursor;
      count++;
    }
    if (count === 0) return { count: 0 };
    if (count === cap && nextAfter(cursor) !== undefined) {
      // Capped: report the true newest slot so callers never mistake an old one for it.
      try {
        const newest = cron.previousRuns(1, new Date(untilMsInclusive + 1_000))[0];
        if (newest && newest.getTime() > cursor && newest.getTime() <= untilMsInclusive) last = newest.getTime();
      } catch { /* keep the capped walk's last slot */ }
      return { count, first, last, capped: true };
    }
    return { count, first, last };
  }
  const interval = cadence.every ? parseEvery(cadence.every) : null;
  if (!interval || interval <= 0) return { count: 0 };
  const total = Math.floor((untilMsInclusive - afterMsExclusive) / interval);
  if (total < 1) return { count: 0 };
  const count = Math.min(total, cap);
  return {
    count,
    first: afterMsExclusive + interval,
    last: afterMsExclusive + total * interval,
    ...(total > cap ? { capped: true } : {})
  };
}
