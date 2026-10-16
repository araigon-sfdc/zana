# Plugin deep links

A deep link routes a click or paste to one plugin inside the running app. It never performs an action: it carries `(pluginId, route, payload)` to the plugin, which must confirm with the user itself.

## Link format

```
<scheme>://plugin/<pluginId>/<route>?d=<payload>
```

- `pluginId`: `[a-z0-9-]+`.
- `route`: one or more `[a-z0-9-]+` segments joined by `/` (required; a trailing slash is tolerated).
- `d`: optional opaque payload, percent-encoded, at most 4096 characters decoded. It is the only query parameter allowed. Whitespace and control characters are rejected.
- Whole link: at most 8192 characters.

Parsing is strict and total. Anything else is dropped in main (never thrown) and logged.

## Schemes per channel

| Build | Scheme | Registered with the OS |
| --- | --- | --- |
| Packaged | `zana` | Yes (electron-builder `protocols`, plus `setAsDefaultProtocolClient`) |
| `pnpm dev` | `zana-dev` | Only with `ZCC_REGISTER_DEV_PROTOCOL=1`, and only on Windows/Linux |
| E2E (`ZCC_E2E_HOME` set) | none | Never |

macOS resolves scheme handlers from the app bundle, so an unpackaged dev Electron cannot own a scheme there. Use `pnpm dev:open-link "<url>"` instead: it launches (or reaches, via the single-instance lock) the dev app with the link as an argument.

Env vars: `ZCC_REGISTER_DEV_PROTOCOL=1` (dev OS registration), `ZCC_E2E_DEEP_LINK_SCHEME` (E2E-only scheme override, honoured only under `ZCC_E2E_HOME`), `ZCC_DATA_DIR` (dev data dir; its presence enables the single-instance lock for unpackaged runs).

## Plugin API

```ts
import { useZccDeepLinks } from '@zana-ai/zcc-plugin-sdk/app';

const links = useZccDeepLinks();
links.base();                         // 'zana://' | 'zana-dev://' | null (unknown yet / E2E)
const off = links.on('peer/join', (payload: string | null) => { /* confirm with the user first */ });
await links.open(pastedText);         // { ok: true, pluginId, route } | { ok: false, reason }
```

`on` queues links that arrive before the handler registers (16 entries, 60 s) and delivers them in order on registration. `open` re-validates in main and accepts every known scheme, so a user can paste a link from another channel.

## Host behaviour

- Main holds the single-instance lock, handles `second-instance` and `open-url`, and queues links before the window is ready (8 entries). Subscriptions are made once at app init.
- The renderer waits up to 8 s for the plugin to register. An unknown or not-installed plugin shows a toast and does nothing. Otherwise the plugin's first nav panel opens (or its project tab for the selected project) and the payload is delivered.

Tests: `packages/desktop-contract/src/deep-link.test.ts`, `apps/desktop/src/deep-link-host.test.ts`, `apps/desktop/src/__tests__/deep-link-registration.guard.test.ts` (never registers under `ZCC_E2E_HOME`), `apps/app/src/plugins/plugin-deep-links.test.tsx`, `e2e/deep-link.spec.ts`.
