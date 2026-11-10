// What approving a tool call sets in motion, stated from the tool's own fixed behaviour
// rather than guessed from its arguments. The native authorization screen shows this
// beside the exact arguments. It informs a decision; it never makes one.

export type ImpactRisk = "contained" | "changes_this_mac" | "leaves_this_mac" | "irreversible" | "unclassified";
export type EgressScope = "local" | "automation" | "external";

export interface ApprovalImpact {
  tool: string;
  /** The operation inside a multi-purpose tool, when the arguments name one. */
  operation?: string;
  risk: ImpactRisk;
  /** True or false only where the tool's behaviour settles it; null when it depends on what is run. */
  reversible: boolean | null;
  /** Where the approved content travels, in order. The model provider is listed when the result returns to it. */
  egress: { label: string; scope: EgressScope }[];
  facts: string[];
}

const MAC = { label: "This Mac", scope: "local" } as const;
const MODEL = { label: "Cloud model (result returns to it)", scope: "external" } as const;

function operationOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>).action ?? (input as Record<string, unknown>).operation;
  return typeof value === "string" && /^[a-z_]{1,40}$/.test(value) ? value : undefined;
}

const unclassified = (tool: string, operation?: string): ApprovalImpact => ({
  tool, ...(operation ? { operation } : {}), risk: "unclassified", reversible: null, egress: [MAC],
  facts: ["Jarvis has no impact description for this action. Read the exact arguments before deciding."],
});

/** Returns undefined when there is no tool name to describe. */
export function approvalImpact(name: string | undefined, input: unknown): ApprovalImpact | undefined {
  if (!name || !/^[a-z_]{1,64}$/.test(name)) return undefined;
  const operation = operationOf(input);
  const base = { tool: name, ...(operation ? { operation } : {}) };
  switch (name) {
    case "remember":
      return { ...base, risk: "contained", reversible: true, egress: [MAC],
        facts: ["Saves one preference on this Mac.", "You can delete it later in Memory.", "Saved preferences can be recalled into later conversations with the cloud model."] };
    case "save_note":
      return { ...base, risk: "contained", reversible: true, egress: [MAC],
        facts: ["Writes one new plain-text file in the Jarvis notes folder.", "It cannot overwrite an existing file."] };
    case "open_url":
      return { ...base, risk: "leaves_this_mac", reversible: null, egress: [MAC, { label: "Default browser", scope: "automation" }, { label: "The website", scope: "external" }],
        facts: ["Opens the address in your default browser.", "The site receives a normal visit from your browser, with your cookies for it.", "Jarvis does not read the page."] };
    case "read_screen":
      return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, MODEL],
        facts: ["Captures the main screen in memory and extracts its text.", "Everything visible, including private content, is sent to the cloud model.", "No screenshot file is kept."] };
    case "inspect_app":
      return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, MODEL],
        facts: ["Reads the named app's controls and their labels and values.", "What it reads is sent to the cloud model."] };
    case "control_app":
      return { ...base, risk: "changes_this_mac", reversible: null, egress: [MAC, { label: "The named app", scope: "automation" }],
        facts: ["Brings the named app to the front, then performs exactly one interaction in it.", "Whether that can be undone depends on the app and the control.", "Cancelling afterwards does not roll it back."] };
    case "run_terminal":
      return { ...base, risk: "irreversible", reversible: null, egress: [MAC],
        facts: ["Runs the exact program and arguments with your account's privileges.", "It is not sandboxed: it can read and change your files and use the network.", "Its output is sent to the cloud model.", "Cancelling afterwards does not roll it back."] };
    case "research_start":
      return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, { label: "Research sources", scope: "external" }, MODEL],
        facts: ["Starts a research run within the budget shown.", "The public query is sent to the selected search sources.", "The budget is an estimate, not a billing cap."] };
    case "email_service":
      if (operation === "send") return { ...base, risk: "irreversible", reversible: false, egress: [MAC, { label: "Mail", scope: "automation" }, { label: "The recipients", scope: "external" }],
        facts: ["Sends this exact message from the named account.", "A sent email cannot be recalled.", "Delivery is submitted, not confirmed."] };
      if (operation && ["list_accounts", "list_inbox", "read_message"].includes(operation)) return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, { label: "Mail", scope: "automation" }, MODEL],
        facts: ["Reads from Mail on this Mac.", "What it reads is sent to the cloud model.", "Nothing is sent or changed in your mailbox."] };
      return unclassified(name, operation);
    case "message_service":
      if (operation === "send") return { ...base, risk: "irreversible", reversible: false, egress: [MAC, { label: "Messages", scope: "automation" }, { label: "The recipient", scope: "external" }],
        facts: ["Sends this exact iMessage to one recipient.", "A sent message cannot be recalled.", "Delivery is submitted, not confirmed."] };
      if (operation === "list_services") return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, { label: "Messages", scope: "automation" }, MODEL],
        facts: ["Lists the iMessage accounts configured on this Mac.", "Their identifiers are sent to the cloud model.", "No message is read or sent."] };
      return unclassified(name, operation);
    case "calendar_service":
      if (operation === "create_event") return { ...base, risk: "changes_this_mac", reversible: true, egress: [MAC, { label: "Calendar", scope: "automation" }, { label: "Your calendar account, if it syncs", scope: "external" }],
        facts: ["Creates one event in the named calendar.", "You can delete it in Calendar.", "No invitations are sent."] };
      if (operation && ["list_calendars", "list_events"].includes(operation)) return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, { label: "Calendar", scope: "automation" }, MODEL],
        facts: ["Reads from Calendar on this Mac.", "What it reads is sent to the cloud model.", "Nothing in your calendar is changed."] };
      return unclassified(name, operation);
    case "home_service":
      if (operation === "call_service") return { ...base, risk: "leaves_this_mac", reversible: null, egress: [MAC, { label: "Home Assistant", scope: "external" }, { label: "The device", scope: "external" }],
        facts: ["Sends one command to a device through your Home Assistant.", "It acts in the physical world.", "Cancelling afterwards does not undo it."] };
      if (operation && ["list_entities", "read_state"].includes(operation)) return { ...base, risk: "leaves_this_mac", reversible: false, egress: [MAC, { label: "Home Assistant", scope: "external" }, MODEL],
        facts: ["Reads device state from your Home Assistant.", "What it reads is sent to the cloud model.", "No device is changed."] };
      return unclassified(name, operation);
    case "google_action":
      return { ...base, risk: "irreversible", reversible: false, egress: [MAC, { label: "Your Jarvis cloud", scope: "external" }, { label: "Google", scope: "external" }],
        facts: ["Sends one Gmail message or creates one Calendar event from the connected account.", "A sent email cannot be recalled.", "It is submitted once and never retried automatically."] };
    default:
      return unclassified(name, operation);
  }
}
