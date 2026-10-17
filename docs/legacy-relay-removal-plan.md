# Plan: remove the legacy shared-token relays

Status: steps 1 and 2 desktop side done, with the step 3 phone docs (2026-10-17). The Heroku code removal for both steps is drafted (2026-10-17); merge it only after a desktop release without the relay clients has shipped. Still pending: the release note and unsetting the Heroku config vars after that deploy. Opened 2026-10-17 for 2.3.6.

Zana Connect now handles phone access, previews and machine enrollment, with a separate credential for each account and server. Two older relays are still in the tree. Both authenticate with **one shared token**:

| Relay | Token | Purpose |
| --- | --- | --- |
| Machine pairing relay | `ZCC_RELAY_TOKEN` | A remote machine joins this laptop through `wss://<heroku>/_zcc/relay` and `/t/<sessionId>` |
| Phone relay (`mode: 'relay'`) | `MOBILE_RELAY_TOKEN` | Older clients reach one computer through a Heroku relay, using `pnpm mobile:serve` |

A shared token baked into a public download is not a secret. Anyone who unpacks the app can read it, and isolation rests only on the random session id. No release has shipped with `ZCC_RELAY_TOKEN`, so the machine pairing relay has never worked in a packaged app. Pairing uses Zana Connect or the SSH tunnel instead (`apps/server/src/services/hosts/host-bootstrap.ts`).

## Interim state (2.3.6)

PR #340 made a release build fail when it baked `ZCC_APP_URL` without `ZCC_RELAY_TOKEN`. That check now only warns (`scripts/relay-bake.ts`), so releases build without the token, as 2.3.5 and earlier did. Do not add `ZCC_RELAY_TOKEN` to GitHub secrets to work around this. The steps below remove the need for it.

## Keep

These pieces are shared with Zana Connect. Removing the relays must not break them:

- `services/mobile-relay/client.mjs`, `protocol.mjs`, `machine-routes.mjs`, `preview-policy.mjs` and `protected-ports.mjs`. They are used by `apps/server/src/mobile/gateway.ts`, `apps/server/src/services/previews/preview-service.ts`, `apps/host-daemon/src/preview-tunnel.ts` and the Connect host transport.
- `mode: 'connect'` in `apps/server/src/mobile/connection.ts` and `manager.ts`.
- The SSH reverse tunnel and copy-paste join. These are how machines pair when Zana Connect is unavailable.
- The `public-app-url` origin. Remotes download `/install.sh` from it, so it has to stay even without the relay.

## Steps

### 1. Machine pairing relay (`ZCC_RELAY_TOKEN`)

Desktop and build side done. Without Zana Connect every remote now joins through an SSH reverse tunnel to the loopback pairing forwarder. The public app URL is the shared website door (`/install.sh` and the Host allowlist), never a join target. The `direct` install path went with it: `pairing-target.ts`, the `pairing-target` utility-runtime operation, the `PairingTarget` contract, `pairingMode` on preferred join codes, the desktop PTY pairing handoff (`hosts-pairing.ts`, `ssh-pairing-pty.ts`, `PairingTerminal`, `hosts.pairing` IPC) and the direct install, restart-first repair and curl `pairingCommand` in `host-bootstrap.ts`. `pairing-allowlist.ts` stays (renamed tests in `pairing-allowlist.test.ts`) because the SSH-tunnel pairing forwarder uses it. Saved `relayToken` / `relaySessionId` config fields are dropped by `normalizeConfig` on the next read and write. The Heroku front-door bullet below is drafted; see "Heroku side (drafted)".

- **Desktop server.** Delete `pairing-relay-client.ts`, `pairing-relay-controller.ts`, `pairing-relay-protocol.ts`, `pairing-session-url.ts` and `pairing-allowlist.ts` from `apps/server/src/http/`, together with their tests, including `pairing-relay-live.test.ts` and `pairing-relay-allowlist.guard.test.ts`. Remove `attachPairingRelay` from `product-server.ts` and `static-host.ts`, and `pairingRelay` from `product-context.ts`.
- **Pairing target.** Delete `pairing-target.ts` and the `PairingTarget` contract. Pairing without Connect is tunnel-only, so no target needs resolving.
- **Build.** Remove `bundledRelayToken`, `__ZCC_BUNDLED_RELAY_TOKEN__` and `relayBakeWarning` from `electron.vite.config.ts`, `apps/server/src/bundled-relay-globals.d.ts` and `apps/server/vitest.config.ts`. Delete `scripts/relay-bake.ts` and its test, the `ZCC_RELAY_TOKEN` seeding in `scripts/dev-local.mjs`, and the three `ZCC_RELAY_TOKEN` env lines in `.github/workflows/release.yml`.
- **Config.** Drop the persisted `relayToken` and `relaySessionId` from `packages/domain/src/product.ts`, `services/projects/store.ts`, `services/config/config-store.ts`, `http/public-app-url.ts` and `packages/desktop-contract/src/cc-api.ts`. Keep a store migration that deletes the old fields. Remove the Settings → Machines "Relay pairing URL" field, its settings-search entry and `relay-token-renderer.guard.test.ts`. If `publicAppUrl` remains as a "Public app URL" setting, relabel it rather than delete it.
- **Heroku front door.** Remove the `/_zcc/relay` and `/t/<id>` handling from `website/relay/front-door.mjs`. Delete `pairing-hub.mjs`, `pairing-session.mjs`, `session-path.mjs`, `token.mjs` and `echo-laptop.mjs`, with their tests, once nothing imports them. Remove the `ZCC_RELAY_TOKEN` notes from `website/heroku.yml`, `website/Dockerfile` and `website/README.md`, then unset the Heroku config var.
- **E2E.** Update or remove `docker/remote-machine/pairing-session.e2e.test.ts`.

### 2. Phone relay (`MOBILE_RELAY_TOKEN`, `mode: 'relay'`)

Desktop side done. A saved `mode: 'relay'` connection loads as `unconfigured`, and `validateMobileConnection` rejects it with a Zana Connect sign-in message. `MobileGatewayManager.configure`, the `mobile.configure` IPC channel and its preload/contract entries are gone, since Connect enrollment uses enroll and redeem. The gateway always starts behind the Connect tunnel and pairs only through the account service. Deleted: `scripts/mobile-serve.ts` and the `mobile:serve` script, `services/mobile-relay/start.mjs`, `Procfile`, `app.json`, `Dockerfile`, `package.json`, `package-lock.json`, `e2e/phone-heroku-relay.live.spec.ts` and `e2e/fixtures/mobile-relay-service.ts`. `e2e/phone-network-connections.spec.ts` now checks the saved-relay fallback. `services/mobile-relay/server.mjs` stays: it is the in-process test peer for `client.mjs` (unit tests and `e2e/mobile-relay-upload.spec.ts`), and `website/scripts/sync-mobile-relay.mjs` still copies it into the front door. The Heroku bullets below are drafted; see "Heroku side (drafted)".

- Done: remove `mode: 'relay'` from `apps/server/src/mobile/connection.ts`, along with its migration of the previous token. Remove the relay branch in `manager.ts` and the related wiring in `apps/desktop/src/host.ts`. Saved relay connections should load as `unconfigured` and ask the user to sign in to Zana Connect.
- **Heroku front door.** Delete `website/relay/mobile-routing.mjs` and its test, and stop syncing `server.mjs` into `website/relay/mobile/` once the front door no longer serves the one-computer relay.
- Unset `MOBILE_RELAY_TOKEN` and `MOBILE_RELAY_PUBLIC_URL` on Heroku.

### 3. Docs

- Done: `docs/multiple-devices.md`: delete "Legacy machine relay reachability". Make sure "Other ways to connect a machine" describes only Zana Connect, the SSH tunnel and copy-paste join. Mirror these changes in `website/content/docs/multiple-devices.md`.
- Done: `docs/mobile-app.md`: delete "Legacy relay development utility" and "Heroku relay". Shorten "Retired connection methods" and "Previously saved connections" to a one-line upgrade note.
- Done: `services/mobile-relay/README.md`: describe only what Connect uses.
- Add release notes saying that saved phone relay connections need a Zana Connect sign-in.

## Heroku side (drafted)

Drafted on 2026-10-17. Merge only after a desktop release without the relay clients has shipped, because older desktop builds still dial these routes.

- `website/relay/front-door.mjs` now routes Zana Connect hosts first and proxies everything else to Next. The retired machine-relay paths (`/_zcc/relay`, `/t/<id>`, `/install.sh`, `/install/*`, `/internal/hosts/*`, `/internal/plugins/*`) answer `410 {"error":"relay_removed"}` instead of reaching Next's `trailingSlash` 308. Every non-Connect WebSocket upgrade gets `404`. The phone relay routing is gone.
- Deleted: `pairing-hub.mjs`, `pairing-session.mjs`, `session-path.mjs`, `token.mjs`, `echo-laptop.mjs`, `mobile-routing.mjs`, `allowlist.mjs` / `allowlist.json`, `protocol.mjs`, `headers.mjs` and `ws-raw.mjs`, with their tests. Only the relay used them.
- Kept: `website/relay/mobile/server.mjs`. `website/connect/gateway.mjs` builds Connect's laptop tunnels with its `createRelay`. The drift check that used to live in `mobile-routing.test.ts` is now `website/relay/mobile/snapshot.test.ts` and covers all four synced files.
- `website/heroku.yml`, `website/Dockerfile` and `website/README.md` no longer mention `ZCC_RELAY_TOKEN`, `MOBILE_RELAY_TOKEN`, `MOBILE_RELAY_PUBLIC_URL` or the deleted live spec.
- Manual step once the image is deployed (not done here): `heroku config:unset ZCC_RELAY_TOKEN MOBILE_RELAY_TOKEN MOBILE_RELAY_PUBLIC_URL -a zcc`.

## Order and verification

1. Ship steps 1 and 2 in separate PRs. Each PR removes the desktop side first. The Heroku side follows once a release without the client is out, because older desktop builds still try to connect.
2. For each PR, run the touched unit tests, `pnpm verify:fast`, `pnpm test:e2e -- e2e/packaged-provider-startup.spec.ts`, and the remote-machine pairing E2E. Check that Add Machine still pairs over Zana Connect and over the SSH tunnel, and that phone access and previews still work over Connect.
3. Once both are done, `rg 'ZCC_RELAY_TOKEN|MOBILE_RELAY_TOKEN|pairing-relay|_zcc/relay'` should return only release notes.
