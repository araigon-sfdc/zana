import { SCHEDULE_REASONS, openRetryRefs, reasonLabel } from '@zana-ai/zcc-domain/schedule-health';
import type {
  ScheduleRetryResult,
  ScheduleRunOutcome,
  ScheduleRunQuery,
  ScheduleRunQueryResult,
  ScheduleRunReasonCode,
  ScheduleRunRef
} from '@zana-ai/zcc-domain/product';
import { errResult, jsonResult, textResult, type CliResult } from '../cli-result.js';

/** Result of one control-plane call: the raw value, or a ready-made CLI error. */
export type LiveCall = (op: string, args: Record<string, unknown>) => Promise<{ value: unknown } | { error: CliResult }>;

export const MAX_RETRY_REFS = 50;
export const MAX_DISMISS_REFS = 200;
const OUTCOMES: readonly ScheduleRunOutcome[] = ['success', 'error', 'skipped', 'incomplete', 'missed'];
const REASONS = Object.keys(SCHEDULE_REASONS) as ScheduleRunReasonCode[];
const MAX_LIMIT = 500;

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** `24h` / `7d` / `30m` / `2w` relative to now, or an ISO timestamp. */
export function parseSince(raw: string, nowMs: number): string | undefined {
  const rel = /^(\d+)([mhdw])$/.exec(raw);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as 'm' | 'h' | 'd' | 'w'];
    const ms = nowMs - Number(rel[1]) * unit;
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
  }
  const abs = Date.parse(raw);
  return Number.isFinite(abs) ? new Date(abs).toISOString() : undefined;
}

function splitList<T extends string>(raw: string, allowed: readonly T[], what: string): Parsed<T[]> {
  const items = raw.split(',').map(item => item.trim()).filter(Boolean);
  if (!items.length) return bad(`${what} needs at least one value`);
  const unknown = items.find(item => !allowed.includes(item as T));
  if (unknown) return bad(`unknown ${what} "${unknown}" (use ${allowed.join(', ')})`);
  return { ok: true, value: [...new Set(items)] as T[] };
}

/** Parse `schedule runs` flags into a query. Pure. */
export function parseRunsArgs(args: string[], nowMs = Date.now()): Parsed<ScheduleRunQuery> {
  const query: ScheduleRunQuery = {};
  const valued = new Set(['--outcome', '--reason', '--since', '--project', '--schedule', '--limit']);
  const states: string[] = [];
  const scheduleIds: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--open' || token === '--problems' || token === '--all') { states.push(token.slice(2)); continue; }
    const eq = token.indexOf('=');
    const flag = eq > 0 ? token.slice(0, eq) : token;
    if (!valued.has(flag)) return bad(`unknown option "${token}"`);
    let value: string | undefined;
    if (eq > 0) value = token.slice(eq + 1);
    else { value = args[i + 1]; if (value !== undefined && !value.startsWith('--')) i += 1; else value = undefined; }
    if (!value) return bad(`${flag} requires a value`);
    if (flag === '--outcome') {
      const list = splitList(value, OUTCOMES, 'outcome');
      if (!list.ok) return list;
      // Repeated flags accumulate, like --schedule.
      query.outcomes = [...new Set([...(query.outcomes ?? []), ...list.value])];
    } else if (flag === '--reason') {
      const list = splitList(value, REASONS, 'reason');
      if (!list.ok) return list;
      query.reasonCodes = [...new Set([...(query.reasonCodes ?? []), ...list.value])];
    } else if (flag === '--since') {
      const since = parseSince(value, nowMs);
      if (!since) return bad(`invalid --since "${value}" (use 24h, 7d or an ISO time)`);
      query.since = since;
    } else if (flag === '--project') {
      query.projectId = value;
    } else if (flag === '--schedule') {
      scheduleIds.push(value);
    } else {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return bad(`--limit must be an integer 1-${MAX_LIMIT}`);
      query.limit = limit;
    }
  }
  if (new Set(states).size > 1) return bad('use only one of --open, --problems, --all');
  if (states.length) query.state = states[0] as ScheduleRunQuery['state'];
  if (scheduleIds.length > 50) return bad('at most 50 --schedule values');
  if (scheduleIds.length) query.scheduleIds = scheduleIds;
  return { ok: true, value: query };
}

/** Parse `scheduleId:runId` references. Split on the LAST colon: run ids are
 *  UUIDs, but hand-written schedule ids may contain colons. */
export function parseRefs(tokens: string[], max: number): Parsed<ScheduleRunRef[]> {
  if (!tokens.length) return bad('at least one <scheduleId:runId> is required');
  if (tokens.length > max) return bad(`at most ${max} runs per call`);
  const refs: ScheduleRunRef[] = [];
  for (const token of tokens) {
    const colon = token.lastIndexOf(':');
    if (token.startsWith('--') || colon < 1 || colon === token.length - 1) return bad(`invalid run reference "${token}" (use <scheduleId>:<runId>)`);
    refs.push({ scheduleId: token.slice(0, colon), runId: token.slice(colon + 1) });
  }
  return { ok: true, value: refs };
}

function pad(n: number) { return String(n).padStart(2, '0'); }
/** Local `YYYY-MM-DD HH:MM`. */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human table for a run query result. */
export function formatRunsTable(result: ScheduleRunQueryResult): string {
  if (!result.rows.length) return 'No runs.\n';
  const header = ['WHEN', 'SCHEDULE', 'OUTCOME', 'REASON', 'ATTEMPT', 'REF'];
  const body = result.rows.map(row => [
    localTime(row.run.at),
    row.scheduleName,
    row.outcome,
    row.reason ? reasonLabel(row.reason) : '',
    String(row.run.attempt ?? 1),
    row.run.id ? `${row.scheduleId}:${row.run.id}` : '-'
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map(r => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  const footer = result.truncated ? `\n${result.rows.length} of ${result.total}\n` : '\n';
  return [line(header), ...body.map(line)].join('\n') + footer;
}

function formatRetryLines(refs: ScheduleRunRef[], results: ScheduleRetryResult[]): string {
  return results.map((r, i) => {
    const ref = `${r.scheduleId ?? refs[i]?.scheduleId}:${r.runId ?? refs[i]?.runId}`;
    return r.ok ? `${r.status ?? 'started'}  ${ref}` : `error  ${ref}  ${r.error ?? 'failed'}`;
  }).join('\n') + '\n';
}

/** `zcc schedule runs|retry|dismiss`. */
export async function runScheduleRunsCommand(
  sub: 'runs' | 'retry' | 'dismiss',
  args: string[],
  json: boolean,
  call: LiveCall,
  nowMs = Date.now()
): Promise<CliResult> {
  if (sub === 'runs') {
    const parsed = parseRunsArgs(args, nowMs);
    if (!parsed.ok) return errResult(`schedule runs: ${parsed.error}`, 2);
    const res = await call('sched.runs', { query: parsed.value });
    if ('error' in res) return res.error;
    return json ? jsonResult(res.value) : textResult(formatRunsTable(res.value as ScheduleRunQueryResult));
  }
  if (sub === 'dismiss') {
    const refs = parseRefs(args, MAX_DISMISS_REFS);
    if (!refs.ok) return errResult(`schedule dismiss: ${refs.error}`, 2);
    const res = await call('sched.dismiss', { refs: refs.value });
    if ('error' in res) return res.error;
    const dismissed = Number(res.value);
    // Like retry: any ref that wasn't dismissed makes the command fail.
    if (dismissed < refs.value.length) {
      return json ? { ...jsonResult(res.value), exitCode: 1 } : { ...textResult(`Dismissed ${dismissed} of ${refs.value.length}.`), exitCode: 1 };
    }
    return json ? jsonResult(res.value) : textResult(`Dismissed ${dismissed} of ${refs.value.length}.`);
  }

  const dryRun = args.includes('--dry-run');
  const open = args.includes('--open');
  const positional = args.filter(arg => arg !== '--dry-run' && arg !== '--open');
  if (open && positional.length) return errResult('schedule retry: use either --open or run references, not both', 2);
  if (dryRun && !open) return errResult('schedule retry: --dry-run only applies with --open', 2);
  let refs: ScheduleRunRef[];
  if (open) {
    const found = await call('sched.runs', { query: { state: 'open', limit: MAX_LIMIT } });
    if ('error' in found) return found.error;
    const rows = (found.value as ScheduleRunQueryResult).rows.filter(row => row.manualRetry && row.run.id);
    // One per schedule: each retry re-runs the schedule once.
    refs = openRetryRefs(rows, MAX_RETRY_REFS);
    if (dryRun) {
      return json ? jsonResult({ dryRun: true, refs, total: rows.length })
        : textResult(refs.length ? `${refs.map(ref => `would retry  ${ref.scheduleId}:${ref.runId}`).join('\n')}${rows.length > refs.length ? `\n${refs.length} of ${rows.length}` : ''}` : 'Nothing to retry.');
    }
    if (!refs.length) return json ? jsonResult([]) : textResult('Nothing to retry.');
  } else {
    const parsed = parseRefs(positional, MAX_RETRY_REFS);
    if (!parsed.ok) return errResult(`schedule retry: ${parsed.error}`, 2);
    refs = parsed.value;
  }
  const res = await call('sched.retry', { refs });
  if ('error' in res) return res.error;
  const results = res.value as ScheduleRetryResult[];
  const out = json ? jsonResult(results) : textResult(formatRetryLines(refs, results));
  // Any ref that could not be retried makes the whole call exit 1 (output is still complete).
  return results.some(r => !r.ok) ? { ...out, exitCode: 1 } : out;
}
