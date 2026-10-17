# Zana Mobile

Zana Mobile is an Expo / React Native iOS and Android shell around the existing Zana web application. Threads, composer, approvals, projects, files and plugin panels use the same renderer and product API as desktop. Agent execution stays on the computer.

## What BB does, and what we adopted

Inspected `/Users/grebmann/zcc-workspace/bb` at commit `9e1641114`, especially `apps/mobile/README.md`, `apps/mobile/src/screens/webview/ProfileWebViewScreen.tsx`, `useShellBridge.ts`, the profile/session/link modules, `packages/mobile-bridge`, `packages/connect-client`, and the mobile plans.

BB's **current implementation** is its WebView shell (#2515). Its older `plans/bb-mobile-expo.md` / progress log describes an earlier effort to recreate product screens natively; that is not the current app architecture. Copying those historical plans would produce the wrong implementation.

| Concern | BB | Zana implementation |
| --- | --- | --- |
| Product UI | Server's web app in React Native WebView | Existing Zana renderer and `/api/v1` + `/ws` |
| Native shell | Expo 57, Router, native server/device screens | `apps/mobile` with the same shell structure |
| Phone authentication | BB Connect account machine enrollment and desktop-session cookie | Zana Connect account/device enrollment and per-computer sessions over HTTPS |
| Saved servers | SecureStore profiles | Serialized, validated SecureStore profiles, max 12 |
| Device bridge | Versioned, schema-validated messages | MIT-licensed BB bridge adapted as `@zana-ai/zcc-mobile-bridge`; original license retained |
| Deep links | BB scheme / hosted universal links | `zana://connect` and `zana://open`; only saved servers open automatically |
| Navigation | Phone web layout | Drawer through 1024px on web/mobile, keyboard viewport sizing, full-width file panel; desktop layout preserved. A cold start opens the new-thread page unless a deep link or notification requests a path; the last visited page is held in memory only (never persisted) so a cookie refresh, Reload or WebView process recovery restores where the user is, while a new deep link still wins |
| Inbox and main views | Shared responsive renderer | Inbox opens Feed/Saved reports as a full-width detail with Back; filters and list position survive. Documents and agent sessions open as full-width screens with Back navigation; page controls wrap on narrow screens. |
| Composer | Responsive product UI | Model and Send/Stop stay visible; an expandable options panel holds mode, thinking effort and send behavior. Phone controls and picker rows have 44px touch targets; drafts survive resizing. |
| Push | Expo push registration and backend plugin | Connect background push is not available; notification route handling remains for compatibility |
| Builds | EAS and native Xcode/Android builds | Local native commands and EAS development, preview and production profiles |

The host-tunnel status plugin is separate from **Zana Connect** phone accounts. The BB-style account flow lives in the website front door and Remote access settings; see [Zana Connect](mobile-connect.md) for architecture and deployment. It uses Zana's own service and signing identities.

## Mobile browser setup in Settings → Mobile

The native mobile app is marked **Coming soon**. Settings does not offer TestFlight invitations, installation QR codes, USB installation, or native-app readiness verification while distribution is deferred, even if a TestFlight URL was previously configured.

Use the mobile browser flow now:

1. **Set up your domain.** Choose **Set up my domain** to open **Settings → Remote access** on the desktop. Get a connect code from the account page, sign in with GitHub, and paste the code into Zana. Choose a personal address such as `my-domain.zana-ide.com` on the account page. An existing address can be copied from Remote access.
2. **Open your domain on your phone.** Enter your chosen address in Safari, Chrome, or another mobile browser. `my-domain` is an example; use the address you claimed.
3. **Sign in and start working.** Use the same GitHub account and choose **Open Zana** to access projects and agents. Bookmark the address for later.

Keep the computer awake, Zana running, and Remote access enabled. Wi-Fi and cellular internet are supported. Browser access needs no native app installation. See [personal browser addresses](mobile-connect.md#personal-browser-addresses) for authentication and domain details. Native development and release tooling remain available for future work; see the [TestFlight release guide](mobile-testflight-release.md).

## Development and phone connection

Prerequisites: pnpm, Xcode with an iOS simulator and CocoaPods for iOS, or the Android SDK for Android.

```sh
pnpm install
pnpm mobile:ios
# Or: pnpm mobile:android
```

`pnpm mobile:dev` starts Metro for a development client. Metro serves development JavaScript; it is not the phone's product connection. Standalone builds bundle JavaScript and need no Metro server.

Simulators and physical phones use the same account flow: connect the running desktop in **Settings → Remote access**, then choose **Continue with GitHub** in Zana Mobile, approve the phone and select the computer. Both need internet access; Wi-Fi and cellular are supported. Keep the computer awake and Zana running. See [Zana Connect](mobile-connect.md) for service deployment.

The native app sends credentials only to validated HTTPS Connect gateway hosts. There is no manual server form, QR pairing, direct mode, LAN listener or local-network permission. The computer maintains an outbound authenticated tunnel to Heroku; its gateway and product server stay on loopback. Internal host enrollment, MCP, installer routes and host credentials are blocked at the gateway. The connection credential stays in main-owned `mobile/connection.json`, atomically written with mode `0600`, and never enters renderer configuration or status responses.

### Previously saved connections

Desktop connections saved with Local network or Tailscale stay offline with a migration message. A saved Heroku relay connection loads as unconfigured. In both cases, sign in to Zana Connect in **Settings → Remote access** to reconnect. Native profiles from older builds stay listed so they can be forgotten, but cannot open a session; sign in with GitHub to reconnect.

## Notifications and device features

The navigation menu header has a **…** button beside Close for **Share**, **Reload**, and **This device**. In an agent, the header keeps the side-panel button at the far right, with the agent’s **…** actions beside it. Older native bridge versions use a connection action sheet for the device actions. Reload renews the native session and restores the current page. If the desktop serves an older interface, or the page cannot load, a compact native header keeps these actions accessible. The integrated menu requires mobile bridge v3 on the phone and the updated desktop renderer.

The phone navigation drawer fills the screen. **New agent** sits above compact **Agents**, **Inbox**, and **More** shortcuts and a searchable agent list with project names and live status. **Agents** opens the overview with kanban, list and optional Canvas views, preserving the selected view. **More** opens a full-screen, searchable picker for History, Scheduler, installed plugins, and other destinations. Share, Reload, and This device are available through the menu header’s **…** button. Selecting an agent opens its conversation or terminal at full width; secondary panels open only when requested as a full-screen page with a Close button, a searchable view picker and compact workspace details. The phone navigation does not change the saved desktop sidebar layout.

Background push is not yet available for Zana Connect accounts. The current native app does not register legacy gateway push tokens or present a notification toggle. Existing notification links are still validated against saved profiles; retired connections cannot resume through a notification.

Native functionality includes saved-computer switching, appearance/haptic preferences, external links, share requests, badge updates, Android back navigation, a home-screen device-settings shortcut and WebView process recovery. Device credentials never travel through the JavaScript bridge.

## Validation

```sh
pnpm mobile:test
pnpm --filter @zana-ai/zcc-mobile typecheck
pnpm --filter @zana-ai/zcc-mobile exec expo install --check
pnpm --filter @zana-ai/zcc-mobile export
pnpm typecheck
pnpm test:e2e -- e2e/mobile-shell.spec.ts e2e/sidebar-shell.spec.ts
```

`e2e/phone-connect-account.spec.ts` verifies account enrollment, authenticated HTTP/WebSocket traffic, live readiness and revocation against the built Electron app and an isolated HTTPS service. `e2e/phone-network-connections.spec.ts` checks that Settings offers only Zana Connect and that a saved Heroku relay connection stays offline without exposing its secret. `e2e/phone-settings-pairing.spec.ts` checks the coming-soon notice and the mobile browser guide’s link to Remote access.

`e2e/mobile-shell.spec.ts` uses a test-only loopback gateway to verify the shared renderer at phone sizes, sends a deterministic fake-provider message and checks navigation and revocation. This browser fixture does not provide a native direct-connection mode. `e2e/mobile-views.spec.ts` checks the main views at 320, 390 and 820 pixels. Gateway integration tests use real HTTP and WebSocket sockets.

Native Maestro flows are under `apps/mobile/e2e/flows`. With the current app installed on a dedicated test simulator and Maestro / Java 17+ available:

```sh
maestro --device <device-id> test apps/mobile/e2e/flows/online-onboarding.yaml
maestro --device <device-id> test apps/mobile/e2e/flows/retired-pairing.yaml
```

These smoke checks verify the online entry point and that an old QR deep link cannot expose or redeem its payload. They do not complete GitHub sign-in. `demo.yaml` clears app state and must only run on an isolated test simulator.

For full native acceptance, approve a dedicated test phone through GitHub and select an enrolled test computer through the real HTTPS service. `online-thread.yaml` accepts a `THREAD_LINK` for a seeded test conversation and checks sending, keyboard visibility, scrolling and device settings. Its fixture requirements are listed in that flow. It does not bypass authentication or create a local port reverse. After deployment, verify Wi-Fi-to-cellular switching and account revocation on a physical phone. Source tests and bundle exports alone cannot establish that result.

Native mobile builds and distribution are outside GitHub CI. Run the mobile package's typecheck, bundle exports, and native acceptance checks locally when working on the native app. Android, iOS, and TestFlight workflows have been removed.

## Installable builds

Run EAS commands from `apps/mobile`. Copy `.env.example` to `.env.local` for local identity settings, then configure the same project ID and owner in the selected EAS environment. Neither value is a secret. Signing credentials are managed separately by EAS.

| Profile | Result | Use |
| --- | --- | --- |
| `development` | iOS simulator development client / Android development client | Metro development |
| `development-device` | Physical-device development client | Metro over a reachable network |
| `preview` | Signed iOS ad hoc app / Android APK | Install on registered iPhones or Android phones without Metro |
| `preview-simulator` | Standalone iOS simulator app | Native acceptance without Metro |
| `production` | Store-signed iOS app / Android AAB | TestFlight / store upload, separate from building |

After the Zana-owned EAS project and signing accounts are configured:

```sh
cd apps/mobile
pnpm dlx eas-cli@latest build --profile preview --platform android
pnpm dlx eas-cli@latest build --profile preview --platform ios
```

Physical iOS preview builds require registered device UDIDs (`eas device:create`) and a provisioning profile containing them. `production` uses EAS-managed build numbers and increments them for each build. Building does not submit to either store. Keep the enrolled computer awake and its Zana Connect tunnel running.

A local Android Release APK can also be built without EAS:

```sh
pnpm --filter @zana-ai/zcc-mobile exec expo prebuild --platform android
cd apps/mobile/android
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a
adb -s <device-serial> install -r app/build/outputs/apk/release/app-release.apk
```

Expo's generated local Release variant uses its development keystore until a signing configuration is supplied. It is suitable for local acceptance, not store upload. Do not distribute that test key as Zana's release identity. Native build folders and local credentials are ignored by Git.

## Release boundaries and remaining parity

The app source and build profiles are present. Zana 2.3.0 (3), with the refreshed fairy icon, is available to the invited internal TestFlight release tester; physical TestFlight installation is still awaiting verification. No public TestFlight invitation, App Store release or Play publication is available yet. See [the release status](mobile-testflight-release.md). `ai.zana.mobile` is the project bundle identifier and must be registered with the account used for signing. BB's hosted account discovery, universal links and inbound OS share-extension target are not implemented by this change. BB’s share-intent handler is optional as well: its current package manifest does not install the share-extension module. Arbitrary plugin panels inherit their existing web responsiveness; native desktop-only affordances remain unavailable on a phone. Local native Release builds are available for both platforms. Android uses the repository's version-pinned cookie-library compatibility patch; a JavaScript export alone cannot catch its Gradle and manifest requirements. Connect background push remains unavailable.

Skills, MCP management and the plugin catalogue currently require desktop APIs. Their mobile/web pages explain where to manage them instead of attempting unavailable calls. Installed plugins remain visible. The responsive view audit checks layout and navigation; it does not imply that every desktop action or third-party plugin is available on mobile.

References: [Expo monorepos](https://docs.expo.dev/guides/monorepos/), [Expo WebView](https://docs.expo.dev/versions/latest/sdk/webview/), [React Native WebView reference](https://github.com/react-native-webview/react-native-webview/blob/master/docs/Reference.md).

Release references: [Expo Android APK builds](https://docs.expo.dev/build-reference/apk/), [FCM credentials and native client configuration](https://docs.expo.dev/push-notifications/fcm-credentials/), [EAS environment variables](https://docs.expo.dev/eas/environment-variables/), [EAS app versions](https://docs.expo.dev/build-reference/app-versions/).
