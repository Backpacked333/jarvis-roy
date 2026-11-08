import { desktopStatus } from "../agent/lib/desktop.ts";
import { researchStatus } from "../agent/lib/web-research.ts";
import { connectedServicesStatus } from "../agent/lib/connected-services.ts";
import type { VoiceStatus } from "./harness-contracts/voice.ts";

export function capabilitiesStatus(harness?: { worker: { available: boolean; reason: string | null }; voice: VoiceStatus }) {
  const desktop = desktopStatus();
  const web = researchStatus();
  const services = connectedServicesStatus();
  // The standalone app passes settings from its native Settings window; the developer launcher uses shell variables.
  const app = process.env.JARVIS_LAUNCH_MODE === "app";
  return {
    notice: app
      ? "Configuration only, not proof of a live connection or permission grant. Change settings in Jarvis → Settings and restart services; never paste credentials into chat."
      : "Configuration only, not proof of a live connection or permission grant. Change launcher environment and restart; never paste credentials into chat.",
    capabilities: [
      { id: "rooms", title: "Isolated room workers", state: harness?.worker.available ? "available" : "setup_needed",
        detail: harness?.worker.reason ?? "Durable rooms and explicit plan starts. Workers require the pinned Python controller and a configured local Docker image; no host execution fallback. Local work stops during Mac sleep/shutdown.",
        setup: app
          ? "Create the pinned worker Python environment at ~/Library/Application Support/JarvisRoy/workers-venv and install a local Docker engine (see the worker setup documentation), explicitly pull the documented platform digest, then set the worker image in Jarvis → Settings and restart services. Network is denied inside workers."
          : "Run ./scripts/setup-workers.sh, explicitly pull the documented platform digest, and set JARVIS_WORKER_IMAGE and JARVIS_WORKER_PYTHON before launch. Network is denied inside workers." },
      { id: "voice", title: "ElevenLabs v4 Turbo + Scribe", state: harness?.voice.status ?? "unavailable",
        detail: harness?.voice.reason ?? "Configuration is not proof of model access or audible playback. Active microphone audio and speech text go to ElevenLabs only after session consent. No voice fallback.",
        setup: (app ? "Save the ElevenLabs API key and voice ID in Jarvis → Settings, never chat, and restart services." : "Supply ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in the launch environment, never chat.") + " Enable cloud voice consent for this session, then Listen / Finish / Mute. Spoken yes never approves a privileged action." },
      { id: "desktop", title: "Screen & app control", state: !desktop.desktopEnabled ? "off" : !desktop.desktopSupported ? "requires_macos" : !desktop.helperConfigured ? "setup_needed" : "permission_needed", detail: desktop.message,
        setup: app
          ? "Turn on screen & app control in Jarvis → Settings and restart services. Enabling it does not grant macOS permissions: grant Accessibility and Screen Recording to Jarvis and its JarvisControl helper in macOS Privacy & Security. Permissions are checked at action time."
          : "Set JARVIS_ENABLE_DESKTOP=1 before launching. Build the bundled JarvisControl helper. Grant Accessibility and Screen Recording to the responsible app/helper or terminal in macOS Privacy & Security. Permissions are checked at action time." },
      { id: "terminal", title: "Terminal", state: !desktop.terminalEnabled ? "off" : !desktop.terminalSupported ? "unsupported" : "configured_unverified",
        detail: "Exact executable, arguments and working directory require approval. Runs with your privileges, NOT in a sandbox. Cancellation is not rollback.", setup: app
          ? "Turn on Terminal in Jarvis → Settings and restart services; turn it off there and restart to disable. It is not sandboxed."
          : "Set JARVIS_ENABLE_TERMINAL=1 before launch; unset or set 0 and restart to turn off." },
      { id: "web", title: "Live web research · Tavily", state: web.configured ? "configured_unverified" : "off",
        detail: "Public search and page extraction send queries/URLs to Tavily. Configuration does not verify credentials or credits. Returned web content is untrusted.", setup: (app
          ? "Save a Tavily API key in Jarvis → Settings (stored in the macOS Keychain on this Mac) and restart services. Remove it there and restart to disable."
          : "Supply TAVILY_API_KEY only in the launch environment. Unset it and restart to disable.") + " Setup: https://docs.tavily.com/documentation/quickstart" },
      ...(["mail", "calendar", "messages", "homeAssistant"] as const).map((id) => ({
        id, title: { mail: "Apple Mail", calendar: "Apple Calendar", messages: "iMessage · send only", homeAssistant: "Home Assistant" }[id],
        state: services[id].state, detail: services[id].detail + ` Unsupported: ${services[id].unsupported.join(", ")}.`,
        setup: id === "homeAssistant"
          ? (app
            ? "Set the Home Assistant URL and save its token in Jarvis → Settings, then restart services; clear both to disable. HTTPS required; private-IP HTTP additionally requires allowing HTTP in Settings."
            : "Supply HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN in the launch environment; unset both to disable. HTTPS required; private-IP HTTP additionally requires JARVIS_ALLOW_HOME_ASSISTANT_HTTP=1.") + " Setup: https://www.home-assistant.io/docs/authentication/"
          : app
            ? "Turn on Apple services in Jarvis → Settings, configure accounts in the named Apple app, and allow Automation for Jarvis in macOS Privacy & Security. Restart services after changes. Jarvis does not read account passwords."
            : "Set JARVIS_ENABLE_APPLE_SERVICES=1, configure accounts in the named Apple app, and allow Automation for the responsible terminal/runtime in macOS Privacy & Security. Restart after changes. Jarvis does not read account passwords.",
      })),
    ],
  };
}
