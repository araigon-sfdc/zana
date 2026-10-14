import { describe, expect, it } from 'vitest';
import { slotsBetween } from './schedule-spec.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 12, 0, 0, 0); // Monday 2026-10-12 00:00 UTC

describe('slotsBetween', () => {
  it('interval: 0 slots when less than one interval has passed', () => {
    expect(slotsBetween({ every: '1h' }, T0, T0 + H - 1)).toEqual({ count: 0 });
  });
  it('interval: exactly 1 slot at the boundary (inclusive)', () => {
    expect(slotsBetween({ every: '1h' }, T0, T0 + H)).toEqual({ count: 1, first: T0 + H, last: T0 + H });
  });
  it('interval: many slots with first/last', () => {
    expect(slotsBetween({ every: '30m' }, T0, T0 + 3 * H + 1)).toEqual({ count: 6, first: T0 + H / 2, last: T0 + 3 * H });
  });
  it('interval: caps the count but reports the true newest slot', () => {
    expect(slotsBetween({ every: '1m' }, T0, T0 + 10 * H, 5)).toEqual({ count: 5, first: T0 + 60_000, last: T0 + 10 * H, capped: true });
  });
  it('cron: caps the count but reports the true newest slot', () => {
    const r = slotsBetween({ cron: '* * * * *', tz: 'UTC' }, T0, T0 + 2 * H, 10);
    expect(r).toMatchObject({ count: 10, first: T0 + 60_000, capped: true });
    expect(r.last).toBe(T0 + 2 * H);
  });
  it('cron: an exact fill of the cap is not reported as capped', () => {
    expect(slotsBetween({ cron: '0 * * * *', tz: 'UTC' }, T0, T0 + 3 * H, 3)).toEqual({ count: 3, first: T0 + H, last: T0 + 3 * H });
  });
  it('empty or inverted window, bad numbers and bad cadence give 0', () => {
    expect(slotsBetween({ every: '1h' }, T0, T0)).toEqual({ count: 0 });
    expect(slotsBetween({ every: '1h' }, T0, T0 - 1)).toEqual({ count: 0 });
    expect(slotsBetween({ every: '1h' }, NaN, T0)).toEqual({ count: 0 });
    expect(slotsBetween({ every: '1h' }, T0, T0 + H, 0)).toEqual({ count: 0 });
    expect(slotsBetween({ every: 'nonsense' }, T0, T0 + H)).toEqual({ count: 0 });
    expect(slotsBetween({}, T0, T0 + H)).toEqual({ count: 0 });
  });
  it('cron: hourly across 5 hours', () => {
    const r = slotsBetween({ cron: '0 * * * *', tz: 'UTC' }, T0 + 1, T0 + 5 * H);
    expect(r).toEqual({ count: 5, first: T0 + H, last: T0 + 5 * H });
  });
  it('cron: the after bound is exclusive', () => {
    expect(slotsBetween({ cron: '0 * * * *', tz: 'UTC' }, T0, T0 + H).count).toBe(1);
  });
  it('cron: weekdays across a weekend', () => {
    // Fri 2026-10-16 09:00 UTC handled; until Tue 2026-10-20 12:00 -> Mon + Tue only.
    const after = Date.UTC(2026, 9, 16, 9, 0, 0);
    const until = Date.UTC(2026, 9, 20, 12, 0, 0);
    const r = slotsBetween({ cron: '0 9 * * 1-5', tz: 'UTC' }, after, until);
    expect(r).toEqual({ count: 2, first: Date.UTC(2026, 9, 19, 9), last: Date.UTC(2026, 9, 20, 9) });
  });
  it('cron: honours the time zone', () => {
    // 09:00 Asia/Tokyo (UTC+9) is 00:00 UTC.
    const r = slotsBetween({ cron: '0 9 * * *', tz: 'Asia/Tokyo' }, T0 - 1, T0 + 2 * 24 * H);
    expect(r.count).toBe(3);
    expect(r.first).toBe(T0);
  });
  it('cron: caps the count', () => {
    expect(slotsBetween({ cron: '* * * * *', tz: 'UTC' }, T0, T0 + 10 * H, 7).count).toBe(7);
  });
  it('cron: an unparseable expression yields 0', () => {
    expect(slotsBetween({ cron: 'not a cron' }, T0, T0 + H)).toEqual({ count: 0 });
  });
});
