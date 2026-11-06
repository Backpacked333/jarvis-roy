import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.JARVIS_MODEL || "openai/gpt-4.1-mini",
  defaultTools: false,
});
