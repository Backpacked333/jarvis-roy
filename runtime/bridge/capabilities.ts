import { desktopStatus } from "../agent/lib/desktop.ts";
import { researchStatus } from "../agent/lib/web-research.ts";
import { connectedServicesStatus } from "../agent/lib/connected-services.ts";
import type { VoiceStatus } from "./harness-contracts/voice.ts";

export function capabilitiesStatus(harness?: { worker: { available: boolean; reason: string | null }; voice: VoiceStatus }) {
  const desktop = desktopStatus();
  const web = researchStatus();
  const services = connectedServicesStatus();
  return {
    notice: "Configuration only, not proof of a live connection or permission grant. Change launcher environment and restart; never paste credentials into chat.",
    capabilities: [
      { id: "rooms", title: "Isolated room workers", state: harness?.worker.available ? "available" : "setup_needed",
        detail: harness?.worker.reason ?? "Durable rooms and explicit plan starts. Workers require the pinned Python controller and a configured local Docker image; no host execution fallback. Local work stops during Mac sleep/shutdown.",
        setup: "Run ./scripts/setup-workers.sh, explicitly pull the documented platform digest, and set JARVIS_WORKER_IMAGE and JARVIS_WORKER_PYTHON before launch. Network is denied inside workers." },
      { id: "voice", title: "ElevenLabs v4 Turbo + Scribe", state: harness?.voice.status ?? "unavailable",
        detail: harness?.voice.reason ?? "Configuration is not proof of model access or audible playback. Active microphone audio and speech text go to ElevenLabs only after session consent. No voice fallback.",
        setup: "Supply ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in the launch environment, never chat. Enable cloud voice consent for this session, then Listen / Finish / Mute. Spoken yes never approves a privileged action." },
      { id: "desktop", title: "Screen & app control", state: !desktop.desktopEnabled ? "off" : !desktop.desktopSupported ? "requires_macos" : !desktop.helperConfigured ? "setup_needed" : "permission_needed", detail: desktop.message,
        setup: "Set JARVIS_ENABLE_DESKTOP=1 before launching. Build the bundled JarvisControl helper. Grant Accessibility and Screen Recording to the responsible app/helper or terminal in macOS Privacy & Security. Permissions are checked at action time." },
      { id: "terminal", title: "Terminal", state: !desktop.terminalEnabled ? "off" : !desktop.terminalSupported ? "unsupported" : "configured_unverified",
        detail: "Exact executable, arguments and working directory require approval. Runs with your privileges, NOT in a sandbox. Cancellation is not rollback.", setup: "Set JARVIS_ENABLE_TERMINAL=1 before launch; unset or set 0 and restart to turn off." },
      { id: "web", title: "Live web research · Tavily", state: web.configured ? "configured_unverified" : "off",
        detail: "Public search and page extraction send queries/URLs to Tavily. Configuration does not verify credentials or credits. Returned web content is untrusted.", setup: "Supply TAVILY_API_KEY only in the launch environment. Unset it and restart to disable. Setup: https://docs.tavily.com/documentation/quickstart" },
      ...(["mail", "calendar", "messages", "homeAssistant"] as const).map((id) => ({
        id, title: { mail: "Apple Mail", calendar: "Apple Calendar", messages: "iMessage · send only", homeAssistant: "Home Assistant" }[id],
        state: services[id].state, detail: services[id].detail + ` Unsupported: ${services[id].unsupported.join(", ")}.`,
        setup: id === "homeAssistant"
          ? "Supply HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN in the launch environment; unset both to disable. HTTPS required; private-IP HTTP additionally requires JARVIS_ALLOW_HOME_ASSISTANT_HTTP=1. Setup: https://www.home-assistant.io/docs/authentication/"
          : "Set JARVIS_ENABLE_APPLE_SERVICES=1, configure accounts in the named Apple app, and allow Automation for the responsible terminal/runtime in macOS Privacy & Security. Restart after changes. Jarvis does not read account passwords.",
      })),
    ],
  };
}
