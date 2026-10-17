export const MOBILE_INSTALL_PROMPT = `Install or update the Zana mobile app on my connected physical phone and connect it to this running Zana desktop app. Carry out the installation, not just a list of instructions.

Work from this computer. Inspect the connected physical devices and identify the intended phone; distinguish USB devices, wireless devices, and simulators. If the target is ambiguous, ask me which phone before installing.

Find the existing Zana source checkout and read docs/mobile-app.md and apps/mobile/README.md. If it is unavailable, locate the official Zana source and installation instructions from https://github.com/salesforce/zana. Do not assume the current project is the Zana repository or overwrite unrelated work.

Check the required tools and prepare a standalone build with bundled JavaScript. For iPhone, use macOS, Xcode, and the existing Apple signing account; verify the provisioning profile includes this exact device. For Android, use the Android SDK and target the exact device with adb. Preserve existing app data when updating. Prefer a verified existing release artifact. Verify its SHA-256, actual signed native version, build number and bundle identifier before installing; app.json alone is not proof. Generated iOS metadata has previously remained at version 0.1.0 / build 1 despite a newer Expo version. Do not uninstall or clear data.

Guide me only through steps that require my interaction: unlocking the phone, trusting this computer, Apple sign-in, enabling iPhone Developer Mode (Settings → Privacy & Security → Developer Mode, restart, then Turn On), or enabling Android USB debugging and accepting its authorization prompt. Never ask me to paste passwords or signing credentials into chat. Continue the build and installation once the phone is ready.

Install and launch Zana, then use Settings → Remote access in the desktop app to connect this computer to my GitHub account through Zana Connect. On the phone, open Continue with GitHub, let me sign in and approve the phone in the browser, then return to Zana Mobile and choose this computer. Use the authenticated online gateway; a shared local network is not required. Keep this computer awake and Zana running. Local-network and direct connections are retired. Keep existing saved data, but connect only through Zana Connect. Do not publish to an app store, expose the desktop server publicly, or restart the desktop app and interrupt running agents without asking.

Verify the installed app launches and the phone connects to this desktop. Tell me what was installed, which phone received it, and any remaining action I need to take.`;

/** Only bounded diagnostic facts enter the prompt: no QR, URLs, labels or errors. */
export function mobileRecoveryPrompt(context: {
  step: number; enabled: boolean; running: boolean; connectionMode: string;
  hasInvitation: boolean; hasLivePhone: boolean;
}): string {
  const mode = ['unconfigured', 'connect'].includes(context.connectionMode) ? context.connectionMode : 'unknown';
  return `Help me finish Zana's guided phone setup. Diagnose the failed step and continue from the current state.

Setup step: ${Math.min(4, Math.max(1, Math.trunc(context.step) || 1))}/4.
Phone access enabled: ${context.enabled === true}. Gateway running: ${context.running === true}.
Connection method: ${mode}. TestFlight invitation configured: ${context.hasInvitation === true}.
Authenticated phone app recently reported ready: ${context.hasLivePhone === true}.

Read docs/mobile-app.md in the existing Zana checkout. Use the normal TestFlight installation and Settings → Phone online flow where available: the same GitHub account on both devices, phone approval, then choose the computer. Use Zana Connect through Heroku; no shared Wi-Fi or local-network permission is required. Do not rebuild or switch to a development installation unless I request it. Inspect the actual current state; these facts are only a snapshot. Never request passwords or signing credentials in chat. Do not include pairing codes, credentials, or private URLs in reports. Preserve existing app data. Do not publish to an app store, expose the desktop server publicly, or restart Zana and interrupt running agents without asking. Verify the phone can load this desktop's projects before reporting success.`;
}
