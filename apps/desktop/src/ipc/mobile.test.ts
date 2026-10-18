import { beforeEach, expect, it, vi } from 'vitest';
import { IPC } from '@zana-ai/zcc-desktop-contract';

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, { invoke: (...args: any[]) => any; fallback: (...args: any[]) => any }>(),
  enabled: false,
  gateway: Object.fromEntries(['enroll', 'pollEnrollment', 'cancelEnrollment', 'disconnectAccount', 'browserAddress', 'redeemComputerCode', 'status', 'pair', 'devices', 'revoke'].map(name => [name, vi.fn()]))
}));
vi.mock('./ctx.js', () => ({ ctx: {
  mobileGateway: fixture.gateway,
  safeHandle: (channel: string, invoke: (...args: any[]) => any, fallback: (...args: any[]) => any) => {
    if (fixture.handlers.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
    fixture.handlers.set(channel, { invoke, fallback });
  }
} }));
vi.mock('@zana-ai/zcc-server/services/projects/store', () => ({ store: { getConfig: () => ({ mobileGatewayEnabled: fixture.enabled }) } }));
import { registerMobileIpc } from './mobile.js';

beforeEach(() => { vi.clearAllMocks(); fixture.handlers.clear(); fixture.enabled = false; });

it('registers each mobile operation once and forwards to the main-owned gateway', async () => {
  registerMobileIpc();
  expect([...fixture.handlers.keys()]).toEqual(expect.arrayContaining(Object.values(IPC.mobile)));
  expect(fixture.handlers.size).toBe(Object.values(IPC.mobile).length);
  for (const [name, args] of [
    ['enroll', ['https://account.example']], ['cancelEnrollment', []], ['browserAddress', []],
    ['redeemComputerCode', ['https://account.example', 'code']], ['status', []], ['pair', []], ['devices', []], ['revoke', ['phone']]
  ] as const) {
    await fixture.handlers.get(IPC.mobile[name])!.invoke(...args);
    expect(fixture.gateway[name]).toHaveBeenCalledWith(...args);
  }
  for (const enabled of [false, true]) {
    fixture.enabled = enabled;
    await fixture.handlers.get(IPC.mobile.pollEnrollment)!.invoke();
    expect(fixture.gateway.pollEnrollment).toHaveBeenLastCalledWith(enabled);
    await fixture.handlers.get(IPC.mobile.disconnectAccount)!.invoke();
    expect(fixture.gateway.disconnectAccount).toHaveBeenLastCalledWith(enabled);
  }
});

it('returns safe status/read fallbacks and preserves mutation errors', () => {
  registerMobileIpc();
  expect(fixture.handlers.get(IPC.mobile.status)!.fallback()).toMatchObject({ running: false, error: null });
  expect(fixture.handlers.get(IPC.mobile.devices)!.fallback()).toEqual([]);
  expect(fixture.handlers.get(IPC.mobile.revoke)!.fallback()).toBe(false);
  const error = new Error('gateway unavailable');
  for (const name of ['enroll', 'pollEnrollment', 'cancelEnrollment', 'disconnectAccount', 'browserAddress', 'redeemComputerCode', 'pair'] as const) {
    expect(() => fixture.handlers.get(IPC.mobile[name])!.fallback(error)).toThrow(error);
  }
});
