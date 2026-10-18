import { IPC } from '@zana-ai/zcc-desktop-contract';
import { ctx } from './ctx.js';
import { store } from '@zana-ai/zcc-server/services/projects/store';

/**
 * Zana Mobile gateway IPC. The gateway is a live main-process object
 * (`ctx.mobileGateway`, owned by host.ts) — enable/disable rides the
 * `mobileGatewayEnabled` AppConfig toggle, so these handlers only read status
 * and mint/read/revoke pairing state. `status` is best-effort (never throws);
 * `pair` rejects when the gateway is not running so the panel can prompt to
 * enable phone access first.
 */
export function registerMobileIpc(): void {
  ctx.safeHandle(IPC.mobile.enroll, (address: unknown) => ctx.mobileGateway.enroll(address), err => { throw err; });
  ctx.safeHandle(IPC.mobile.pollEnrollment, () => ctx.mobileGateway.pollEnrollment(store.getConfig().mobileGatewayEnabled === true), err => { throw err; });
  ctx.safeHandle(IPC.mobile.cancelEnrollment, () => ctx.mobileGateway.cancelEnrollment(), err => { throw err; });
  ctx.safeHandle(IPC.mobile.disconnectAccount, () => ctx.mobileGateway.disconnectAccount(store.getConfig().mobileGatewayEnabled === true), err => { throw err; });
  ctx.safeHandle(IPC.mobile.browserAddress, () => ctx.mobileGateway.browserAddress(), err => { throw err; });
  ctx.safeHandle(IPC.mobile.redeemComputerCode, (address: unknown, code: unknown) => ctx.mobileGateway.redeemComputerCode(address, code), err => { throw err; });
  ctx.safeHandle(
    IPC.mobile.status,
    () => ctx.mobileGateway.status(),
    () => ({ running: false, publicUrl: null, host: null, port: null, boundLan: false, error: null })
  );
  ctx.safeHandle(
    IPC.mobile.pair,
    () => ctx.mobileGateway.pair(),
    (err) => {
      throw err;
    }
  );
  ctx.safeHandle(
    IPC.mobile.devices,
    () => ctx.mobileGateway.devices(),
    () => []
  );
  ctx.safeHandle(
    IPC.mobile.revoke,
    (id: string) => ctx.mobileGateway.revoke(id),
    () => false
  );
}
