import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { createConnectedServices, homeServiceSchema } from "../lib/connected-services.ts";

export default defineTool({
  description: "Optional operator-configured Home Assistant connector (HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN), not HomeKit. Every read/control requires approval. List up to 50 states or read one light/switch/fan/climate/media_player entity; attributes are withheld. Exact service allowlist: light turn_on with optional brightness/turn_off; switch turn_on/off; fan turn_on/off/set_percentage; climate set_temperature (-20..50 in the configured instance's units)/set_hvac_mode; media_player turn_on/off/media_play/media_pause/media_stop/volume_set. Service data must contain only the applicable parameter, or {}. Entity domain must match. No locks, alarms, doors, scripts, automations, arbitrary URLs/services or credential overrides. A submitted service is not proof of device state; never retry an uncertain control.",
  inputSchema: homeServiceSchema,
  approval: always(),
  availableInSubagents: false,
  async execute(input, ctx) {
    return createConnectedServices().home(input, { signal: ctx.abortSignal, sessionId: ctx.session.id });
  },
});
