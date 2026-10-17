import {
  countLiveThreadsForEnvironment,
  getEnvironment,
  getThread,
  updateEnvironmentStatus,
  updateThreadStatus,
  type ZccDatabase
} from '@zana-ai/zcc-db';
import type { WorkspaceStatus } from '@zana-ai/zcc-domain';
import { isWithin } from '@zana-ai/zcc-path-confine';
import type { ProductHttpContext } from '../../http/product-context.js';
import { ThreadCreateError, threadView } from '../../http/thread-create.js';

async function closeDestroyedEnvironmentTerminals(
  ctx: ProductHttpContext,
  directory: string,
  hostId: string
): Promise<void> {
  for (const session of ctx.terminalSessions.values()) {
    if (session.status === 'exited') continue;
    if (session.hostId !== hostId) continue;
    if (!isWithin(session.cwd, directory)) continue;
    try {
      await ctx.hostHub.callHostOnlineRpc({
        hostId: session.hostId,
        command: { type: 'terminal.stop', sessionId: session.id }
      });
    } catch {
      // Directory destroy still proceeds if a product PTY is already gone.
    }
    session.status = 'exited';
    session.finishedAt = Date.now();
    ctx.terminalSessions.set(session.id, session);
    const { hostId: _hostId, outputText: _outputText, outputTruncated: _outputTruncated, ...publicSession } = session;
    ctx.hub.emit('terminals:updated', publicSession);
  }
}

/**
 * Automatic cleanup must not discard work. A managed worktree is kept when it
 * has uncommitted or untracked changes, or when the host cannot confirm it is
 * clean (offline, or an untracked scan that is not fresh). An explicit
 * destroy still removes it.
 */
async function worktreeMayHoldUnsavedWork(
  ctx: ProductHttpContext,
  environment: NonNullable<ReturnType<typeof getEnvironment>>
): Promise<boolean> {
  if (environment.workspaceProvisionType !== 'managed-worktree' || !environment.path) return false;
  let status: WorkspaceStatus;
  try {
    status = await ctx.hostHub.callHostOnlineRpc<WorkspaceStatus>({
      hostId: environment.hostId,
      command: {
        type: 'workspace.status',
        workspacePath: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType
      }
    });
  } catch {
    return true;
  }
  if (!status.isGitRepo) return false;
  if (status.dirty) return true;
  return status.untracked !== undefined && status.untracked.state !== 'fresh';
}

export async function destroyEnvironmentIfIdle(ctx: ProductHttpContext, environmentId: string): Promise<void> {
  const environment = getEnvironment(ctx.db, environmentId);
  if (!environment) return;
  if (countLiveThreadsForEnvironment(ctx.db, environmentId) > 0) return;
  if (countLiveCliSessionsForEnvironment(ctx, environmentId) > 0) return;
  if (!environment.managed || environment.status === 'destroyed') return;
  try {
    if (await worktreeMayHoldUnsavedWork(ctx, environment)) return;
    await destroyEnvironment(ctx, environmentId);
  } catch {
    // Last-session cleanup is best-effort; a host blip must not block archive/close.
  }
}

/**
 * Same default as BB's retire grace: a thread resumed or un-archived within
 * this window keeps its environment, because the idle check runs again when
 * the timer fires.
 */
export const ENVIRONMENT_RETIRE_GRACE_MS = 5 * 60_000;

// Keyed by the store, which is shared by every view of one server context.
const retireTimers = new WeakMap<object, Map<string, ReturnType<typeof setTimeout>>>();

export function scheduleEnvironmentRetire(
  ctx: ProductHttpContext,
  environmentId: string,
  delayMs = ENVIRONMENT_RETIRE_GRACE_MS
): void {
  let timers = retireTimers.get(ctx.db);
  if (!timers) {
    timers = new Map();
    retireTimers.set(ctx.db, timers);
  }
  clearTimeout(timers.get(environmentId));
  const pending = timers;
  const timer = setTimeout(() => {
    pending.delete(environmentId);
    destroyEnvironmentIfIdle(ctx, environmentId).catch(() => {
      // The store may already be closed during shutdown; the worktree stays.
    });
  }, delayMs);
  timer.unref?.();
  timers.set(environmentId, timer);
}

/** Pending retires are dropped on shutdown; their worktrees stay on disk. */
export function disposeEnvironmentRetireTimers(ctx: Pick<ProductHttpContext, 'db'>): void {
  const timers = retireTimers.get(ctx.db);
  if (!timers) return;
  for (const timer of timers.values()) clearTimeout(timer);
  retireTimers.delete(ctx.db);
}

function countLiveCliSessionsForEnvironment(ctx: ProductHttpContext, environmentId: string): number {
  let count = 0;
  for (const session of ctx.terminalSessions.values()) {
    if (session.status === 'exited') continue;
    if (session.workspaceEnvironmentId === environmentId) count += 1;
  }
  return count;
}

export async function destroyEnvironment(ctx: ProductHttpContext, environmentId: string): Promise<void> {
  const environment = getEnvironment(ctx.db, environmentId);
  if (!environment || environment.status === 'destroyed') {
    throw new ThreadCreateError(404, 'unknown-environment', 'environment is not registered');
  }
  if (countLiveThreadsForEnvironment(ctx.db, environmentId) > 0) {
    throw new ThreadCreateError(409, 'environment_in_use', 'environment still has live threads');
  }
  if (countLiveCliSessionsForEnvironment(ctx, environmentId) > 0) {
    throw new ThreadCreateError(409, 'environment_in_use', 'environment still has live CLI agents');
  }
  if (!environment.path || environment.workspaceProvisionType === 'unmanaged') {
    updateEnvironmentStatus(ctx.db, environmentId, 'destroyed');
    return;
  }
  updateEnvironmentStatus(ctx.db, environmentId, 'destroying');
  await closeDestroyedEnvironmentTerminals(ctx, environment.path, environment.hostId);
  try {
    await ctx.hostHub.callHostOnlineRpc({
      hostId: environment.hostId,
      command: {
        type: 'environment.destroy',
        environmentId: environment.id,
        workspacePath: environment.path,
        workspaceProvisionType: environment.workspaceProvisionType
      }
    });
    updateEnvironmentStatus(ctx.db, environmentId, 'destroyed');
  } catch (error) {
    updateEnvironmentStatus(ctx.db, environmentId, 'failed');
    throw error;
  }
}

export async function archiveThread(ctx: ProductHttpContext, threadId: string): Promise<boolean> {
  const thread = getThread(ctx.db as ZccDatabase, threadId);
  if (!thread) return false;
  // Complete first so a hydrate during stop cannot re-list this row as live.
  const completed = updateThreadStatus(ctx.db, threadId, 'completed') ?? { ...thread, status: 'completed' as const };
  ctx.hub.emit('threads:updated', threadView(ctx, completed));
  try {
    await ctx.hostHub.callHostOnlineRpc({
      hostId: thread.hostId,
      command: { type: 'thread.stop', threadId }
    });
  } catch {
    // Host may already have dropped the PTY (exit, disconnect). Archive anyway.
  }
  if (thread.environmentId) scheduleEnvironmentRetire(ctx, thread.environmentId);
  return true;
}
