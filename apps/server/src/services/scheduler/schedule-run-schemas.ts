import { z } from 'zod';
import { SCHEDULE_REASONS } from '@zana-ai/zcc-domain/schedule-health';
import type { ScheduleRunOutcome, ScheduleRunQueryResult, ScheduleRunReasonCode } from '@zana-ai/zcc-domain/product';

const OUTCOMES = ['success', 'error', 'skipped', 'incomplete', 'missed'] as const satisfies readonly ScheduleRunOutcome[];
const REASON_CODES = Object.keys(SCHEDULE_REASONS) as [ScheduleRunReasonCode, ...ScheduleRunReasonCode[]];
const id = z.string().min(1).max(256);
const isoTime = z.string().max(64).refine(value => !Number.isNaN(Date.parse(value)), 'Must be an ISO timestamp');

/** Cross-schedule run query. Every field is optional and bounded; main re-validates what the renderer sends. */
export const scheduleRunQuerySchema = z.object({
  state: z.enum(['open', 'problems', 'all']).optional(),
  outcomes: z.array(z.enum(OUTCOMES)).max(OUTCOMES.length).optional(),
  reasonCodes: z.array(z.enum(REASON_CODES)).max(50).optional(),
  since: isoTime.optional(),
  until: isoTime.optional(),
  projectId: id.optional(),
  scheduleIds: z.array(id).max(50).optional(),
  limit: z.number().int().min(1).max(500).optional()
}).strict();

/** A batch of run references for retry (max 50) or dismiss (max 200). */
export const scheduleRunRefsSchema = (max: number) =>
  z.array(z.object({ scheduleId: id, runId: id }).strict()).min(1).max(max);

/**
 * Drop each run's `report` (agent-written markdown, unbounded) from a query
 * result before it leaves main: rows are for triage, and up to 500 of them must
 * stay a small payload for the CLI, MCP and web clients.
 */
export function slimRunQueryResult(result: ScheduleRunQueryResult): ScheduleRunQueryResult {
  return {
    ...result,
    rows: result.rows.map(row => {
      if (row.run.report === undefined) return row;
      const { report: _report, ...run } = row.run;
      void _report;
      return { ...row, run };
    })
  };
}
