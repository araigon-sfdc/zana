# Mobile relay transport

Shared tunnel modules for [Zana Connect](../../docs/mobile-connect.md). The computer opens one outbound, authenticated WebSocket to the Connect gateway. HTTP and WebSocket traffic for the phone gateway and shared previews is multiplexed over it. The phone gateway and the product server stay on loopback.

This directory is not a deployable service. The one-computer Heroku relay that `MOBILE_RELAY_TOKEN` authenticated has been retired; saved desktop connections to it load as unconfigured until the computer signs in to Zana Connect.

| Module | Used by |
| --- | --- |
| `client.mjs` | Desktop tunnel (`apps/server/src/mobile/manager.ts`) and the host-daemon preview tunnel |
| `protocol.mjs` | Frame encoding and transfer limits on both ends of the tunnel |
| `machine-routes.mjs` | Routes the gateway accepts or blocks for machine traffic ([shared-instance contracts](../../docs/shared-instance-contracts.md)) |
| `preview-policy.mjs`, `protected-ports.mjs` | Header filtering and port rules for [shared previews](../../docs/shared-previews.md) |
| `server.mjs` | The relay end of the tunnel. Tests here and `e2e/mobile-relay-upload.spec.ts` use it as the in-process peer of `client.mjs`. `website/scripts/sync-mobile-relay.mjs` still copies it into the website front door until that deployment is cleaned up. |

## Transport behavior

- Heartbeats keep the tunnel below proxy idle windows, and the client reconnects with capped backoff.
- Pending HTTP requests fail on disconnect and are **never automatically replayed**. Check whether an action completed before retrying a send.
- Transfers are bounded: 64 concurrent streams, 32 MiB request bodies, 64 MiB responses, 1 MiB application WebSocket messages and 4 MiB outbound buffer ceilings. Slow peers are disconnected rather than buffered without limit.
- Requests fail after 25 seconds without response traffic. Long operations should acknowledge promptly and stream updates over the application's WebSocket.

## Verification

From the repository root, run `pnpm exec vitest run services/mobile-relay --exclude '.pnpm-store/**'` for protocol and real HTTP/WebSocket tests, and `pnpm test:e2e -- e2e/phone-connect-account.spec.ts e2e/mobile-relay-upload.spec.ts` for the built-Electron Connect path.
