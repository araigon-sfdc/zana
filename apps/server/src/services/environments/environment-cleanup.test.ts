import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveThread,
  destroyEnvironment,
  destroyEnvironmentIfIdle,
  disposeEnvironmentRetireTimers,
  ENVIRONMENT_RETIRE_GRACE_MS,
  scheduleEnvironmentRetire
} from './environment-cleanup.js';
import type { ProductHttpContext, ProductTerminalRecord } from '../../http/product-context.js';
import {
  getThread,
  updateThreadStatus,
  getEnvironment,
  countLiveThreadsForEnvironment,
  updateEnvironmentStatus
} from '@zana-ai/zcc-db';

vi.mock('@zana-ai/zcc-db', () => ({
  getThread: vi.fn(),
  updateThreadStatus: vi.fn(),
  countLiveThreadsForEnvironment: vi.fn(() => 0),
  getEnvironment: vi.fn(() => null),
  updateEnvironmentStatus: vi.fn()
}));

const thread = {
  id: 'thr-1',
  projectId: 'proj-1',
  hostId: 'host-1',
  environmentId: 'env-1',
  providerId: 'claude',
  status: 'running' as const,
  title: 'Hello',
  createdAt: 1,
  updatedAt: 1
};

beforeEach(() => {
  vi.mocked(getThread).mockReset();
  vi.mocked(updateThreadStatus).mockReset();
  vi.mocked(getEnvironment).mockReset();
  vi.mocked(countLiveThreadsForEnvironment).mockReset();
  vi.mocked(updateEnvironmentStatus).mockReset();
  vi.mocked(countLiveThreadsForEnvironment).mockReturnValue(0);
});

describe('archiveThread', () => {
  it('marks the thread completed before stop, even when the host throws', async () => {
    const order: string[] = [];
    vi.mocked(getThread).mockReturnValue(thread);
    vi.mocked(updateThreadStatus).mockImplementation((_db, id, status) => {
      order.push('complete');
      return { ...thread, id, status };
    });
    const emit = vi.fn();
    const callHostOnlineRpc = vi.fn(async () => {
      order.push('stop');
      throw new Error('host down');
    });
    const ctx = {
      db: {},
      hub: { emit },
      hostHub: { callHostOnlineRpc },
      pendingInteractions: {
        interruptPendingInteractionsForThreadIds: vi.fn(() => [])
      }
    } as unknown as ProductHttpContext;

    expect(await archiveThread(ctx, thread.id)).toBe(true);
    expect(order).toEqual(['complete', 'stop']);
    expect(updateThreadStatus).toHaveBeenCalledWith(ctx.db, thread.id, 'completed');
    expect(emit).toHaveBeenCalledWith(
      'threads:updated',
      expect.objectContaining({ id: thread.id, status: 'completed' })
    );
    expect(callHostOnlineRpc).toHaveBeenCalledWith({
      hostId: thread.hostId,
      command: { type: 'thread.stop', threadId: thread.id }
    });
  });

  it('returns false for an unknown thread without calling the host', async () => {
    vi.mocked(getThread).mockReturnValue(null);
    const callHostOnlineRpc = vi.fn();
    const ctx = {
      db: {},
      hub: { emit: vi.fn() },
      hostHub: { callHostOnlineRpc },
      pendingInteractions: {
        interruptPendingInteractionsForThreadIds: vi.fn(() => [])
      }
    } as unknown as ProductHttpContext;

    expect(await archiveThread(ctx, 'missing')).toBe(false);
    expect(callHostOnlineRpc).not.toHaveBeenCalled();
    expect(updateThreadStatus).not.toHaveBeenCalled();
  });
});

describe('destroyEnvironment', () => {
  const environment = {
    id: 'env-1',
    projectId: 'proj-1',
    hostId: 'host-1',
    path: '/tmp/worktree',
    managed: true,
    status: 'ready' as const,
    workspaceProvisionType: 'managed-worktree' as const
  };

  it('stops product terminals whose cwd sits under a disposable workspace, then destroys', async () => {
    vi.mocked(getEnvironment).mockReturnValue(environment as never);
    vi.mocked(countLiveThreadsForEnvironment).mockReturnValue(0);
    const inside: ProductTerminalRecord = {
      id: 'term-in',
      projectId: 'proj-1',
      title: 'dev',
      profile: 'shell',
      cwd: '/tmp/worktree/app',
      status: 'running',
      createdAt: 1,
      hostId: 'host-1'
    };
    const outside: ProductTerminalRecord = {
      id: 'term-out',
      projectId: 'proj-1',
      title: 'other',
      profile: 'shell',
      cwd: '/tmp/other',
      status: 'running',
      createdAt: 1,
      hostId: 'host-1'
    };
    const callHostOnlineRpc = vi.fn(async () => ({ destroyed: true }));
    const foreign = { ...inside, id: 'same-path-foreign-host', hostId: 'host-2' };
    const emit = vi.fn();
    const ctx = {
      db: {},
      hub: { emit },
      hostHub: { callHostOnlineRpc },
      terminalSessions: new Map([
        [inside.id, inside],
        [outside.id, outside],
        [foreign.id, foreign]
      ])
    } as unknown as ProductHttpContext;

    await destroyEnvironment(ctx, environment.id);
    expect(foreign.status).toBe('running');
    expect(callHostOnlineRpc).not.toHaveBeenCalledWith(expect.objectContaining({ hostId: 'host-2' }));
    expect(callHostOnlineRpc).toHaveBeenCalledWith({
      hostId: 'host-1',
      command: { type: 'terminal.stop', sessionId: inside.id }
    });
    expect(callHostOnlineRpc).toHaveBeenCalledWith({
      hostId: 'host-1',
      command: {
        type: 'environment.destroy',
        environmentId: environment.id,
        workspacePath: environment.path,
        workspaceProvisionType: 'managed-worktree'
      }
    });
    expect(inside.status).toBe('exited');
    expect(outside.status).toBe('running');
  });

  it('does not sweep terminals or processes for an unmanaged checkout', async () => {
    vi.mocked(getEnvironment).mockReturnValue({
      ...environment,
      managed: false,
      workspaceProvisionType: 'unmanaged'
    } as never);
    const callHostOnlineRpc = vi.fn();
    const session: ProductTerminalRecord = {
      id: 'term-in',
      projectId: 'proj-1',
      title: 'dev',
      profile: 'shell',
      cwd: '/tmp/worktree',
      status: 'running',
      createdAt: 1,
      hostId: 'host-1'
    };
    const ctx = {
      db: {},
      hub: { emit: vi.fn() },
      hostHub: { callHostOnlineRpc },
      terminalSessions: new Map([[session.id, session]])
    } as unknown as ProductHttpContext;

    await destroyEnvironment(ctx, environment.id);
    expect(callHostOnlineRpc).not.toHaveBeenCalled();
    expect(session.status).toBe('running');
    expect(updateEnvironmentStatus).toHaveBeenCalledWith(ctx.db, environment.id, 'destroyed');
  });

  it('refuses to destroy while a live CLI Agent occupies the environment', async () => {
    vi.mocked(getEnvironment).mockReturnValue(environment as never);
    vi.mocked(countLiveThreadsForEnvironment).mockReturnValue(0);
    const session: ProductTerminalRecord = {
      id: 'cli-1',
      projectId: 'proj-1',
      title: 'inspect the checkout',
      profile: 'claude',
      cwd: '/tmp/worktree',
      status: 'running',
      createdAt: 1,
      hostId: 'host-1',
      workspaceEnvironmentId: environment.id
    };
    const callHostOnlineRpc = vi.fn();
    const ctx = {
      db: {},
      hub: { emit: vi.fn() },
      hostHub: { callHostOnlineRpc },
      terminalSessions: new Map([[session.id, session]])
    } as unknown as ProductHttpContext;

    await expect(destroyEnvironment(ctx, environment.id)).rejects.toMatchObject({
      code: 'environment_in_use'
    });
    expect(callHostOnlineRpc).not.toHaveBeenCalled();
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(callHostOnlineRpc).not.toHaveBeenCalled();
  });
});

describe('destroyEnvironmentIfIdle unsaved-work guard', () => {
  const environment = {
    id: 'env-1',
    projectId: 'proj-1',
    hostId: 'host-1',
    path: '/tmp/worktree',
    managed: true,
    status: 'ready' as const,
    workspaceProvisionType: 'managed-worktree' as const
  };
  const cleanStatus = {
    isGitRepo: true,
    dirty: false,
    untracked: { state: 'fresh', scannedAt: 1, durationMs: 1, slow: false }
  };

  function contextWithStatus(status: (() => Promise<unknown>) | Record<string, unknown>) {
    const callHostOnlineRpc = vi.fn(async ({ command }: { command: { type: string } }) => {
      if (command.type !== 'workspace.status') return { destroyed: true };
      return typeof status === 'function' ? status() : status;
    });
    const ctx = {
      db: {},
      hub: { emit: vi.fn() },
      hostHub: { callHostOnlineRpc },
      terminalSessions: new Map()
    } as unknown as ProductHttpContext;
    return { ctx, callHostOnlineRpc };
  }

  function destroyCalls(rpc: ReturnType<typeof vi.fn>) {
    return rpc.mock.calls.filter(([call]) => (call as { command: { type: string } }).command.type === 'environment.destroy');
  }

  beforeEach(() => {
    vi.mocked(getEnvironment).mockReturnValue(environment as never);
  });

  it('destroys a clean worktree after a fresh status read', async () => {
    const { ctx, callHostOnlineRpc } = contextWithStatus(cleanStatus);
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(callHostOnlineRpc).toHaveBeenCalledWith({
      hostId: 'host-1',
      command: { type: 'workspace.status', workspacePath: '/tmp/worktree', workspaceProvisionType: 'managed-worktree' }
    });
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(1);
    expect(updateEnvironmentStatus).toHaveBeenCalledWith(ctx.db, environment.id, 'destroyed');
  });

  it('destroys a worktree reported by an older host without untracked scan info', async () => {
    const { ctx, callHostOnlineRpc } = contextWithStatus({ isGitRepo: true, dirty: false });
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(1);
  });

  it('destroys a checkout that is no longer a git repository', async () => {
    const { ctx, callHostOnlineRpc } = contextWithStatus({ isGitRepo: false, dirty: false });
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(1);
  });

  it.each([
    ['uncommitted changes', { ...cleanStatus, dirty: true }],
    ['a stale untracked scan', { ...cleanStatus, untracked: { ...cleanStatus.untracked, state: 'stale' } }],
    ['a pending untracked scan', { ...cleanStatus, untracked: { ...cleanStatus.untracked, state: 'pending' } }]
  ])('keeps a worktree with %s', async (_label, status) => {
    const { ctx, callHostOnlineRpc } = contextWithStatus(status);
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(0);
    expect(updateEnvironmentStatus).not.toHaveBeenCalled();
  });

  it('keeps a worktree when the host cannot report its status', async () => {
    const { ctx, callHostOnlineRpc } = contextWithStatus(async () => {
      throw new Error('host offline');
    });
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(0);
    expect(updateEnvironmentStatus).not.toHaveBeenCalled();
  });

  it('removes a personal workspace without a status check', async () => {
    vi.mocked(getEnvironment).mockReturnValue({ ...environment, workspaceProvisionType: 'personal' } as never);
    const { ctx, callHostOnlineRpc } = contextWithStatus(cleanStatus);
    await destroyEnvironmentIfIdle(ctx, environment.id);
    expect(callHostOnlineRpc).toHaveBeenCalledTimes(1);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(1);
  });

  it('still lets an explicit destroy remove a dirty worktree', async () => {
    const { ctx, callHostOnlineRpc } = contextWithStatus({ ...cleanStatus, dirty: true });
    await destroyEnvironment(ctx, environment.id);
    expect(destroyCalls(callHostOnlineRpc)).toHaveLength(1);
  });
});

describe('environment retire grace period', () => {
  const environment = {
    id: 'env-1',
    projectId: 'proj-1',
    hostId: 'host-1',
    path: '/tmp/worktree',
    managed: true,
    status: 'ready' as const,
    workspaceProvisionType: 'managed-worktree' as const
  };
  const cleanStatus = {
    isGitRepo: true,
    dirty: false,
    untracked: { state: 'fresh', scannedAt: 1, durationMs: 1, slow: false }
  };

  function retireContext() {
    const callHostOnlineRpc = vi.fn(async ({ command }: { command: { type: string } }) =>
      command.type === 'workspace.status' ? cleanStatus : { destroyed: true }
    );
    const ctx = {
      db: {},
      hub: { emit: vi.fn() },
      hostHub: { callHostOnlineRpc },
      terminalSessions: new Map(),
      pendingInteractions: { interruptPendingInteractionsForThreadIds: vi.fn(() => []) }
    } as unknown as ProductHttpContext;
    const destroys = () => callHostOnlineRpc.mock.calls
      .filter(([call]) => (call as { command: { type: string } }).command.type === 'environment.destroy');
    return { ctx, destroys };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getEnvironment).mockReturnValue(environment as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the same five minutes as BB', () => {
    expect(ENVIRONMENT_RETIRE_GRACE_MS).toBe(300_000);
  });

  it('waits for the grace period after archive before destroying the worktree', async () => {
    vi.mocked(getThread).mockReturnValue(thread);
    vi.mocked(updateThreadStatus).mockImplementation((_db, id, status) => ({ ...thread, id, status }));
    const { ctx, destroys } = retireContext();

    await archiveThread(ctx, thread.id);
    expect(destroys()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(ENVIRONMENT_RETIRE_GRACE_MS - 1);
    expect(destroys()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(destroys()).toHaveLength(1);
  });

  it('keeps the worktree when a thread uses it again within the grace period', async () => {
    const { ctx, destroys } = retireContext();
    scheduleEnvironmentRetire(ctx, environment.id);
    vi.mocked(countLiveThreadsForEnvironment).mockReturnValue(1);
    await vi.advanceTimersByTimeAsync(ENVIRONMENT_RETIRE_GRACE_MS);
    expect(destroys()).toHaveLength(0);
  });

  it('restarts the grace period when retire is scheduled again', async () => {
    const { ctx, destroys } = retireContext();
    scheduleEnvironmentRetire(ctx, environment.id, 1_000);
    await vi.advanceTimersByTimeAsync(600);
    scheduleEnvironmentRetire(ctx, environment.id, 1_000);
    await vi.advanceTimersByTimeAsync(600);
    expect(destroys()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(destroys()).toHaveLength(1);
  });

  it('drops pending retires on dispose', async () => {
    const { ctx, destroys } = retireContext();
    scheduleEnvironmentRetire(ctx, environment.id, 1_000);
    disposeEnvironmentRetireTimers(ctx);
    disposeEnvironmentRetireTimers(ctx);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(destroys()).toHaveLength(0);
  });

  it('swallows a store failure when the timer fires', async () => {
    const { ctx, destroys } = retireContext();
    vi.mocked(getEnvironment).mockImplementation(() => {
      throw new Error('database closed');
    });
    scheduleEnvironmentRetire(ctx, environment.id, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(destroys()).toHaveLength(0);
  });
});
