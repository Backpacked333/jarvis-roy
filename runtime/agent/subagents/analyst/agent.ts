import { defineAgent } from "eve";

export default defineAgent({
  description: "Analyze a supplied problem or draft a document in the background. No live web access or desktop actions.",
  model: process.env.JARVIS_MODEL || "openai/gpt-4.1-mini",
  defaultTools: false,
});
