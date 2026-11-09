import { defineAgent } from "eve";
import { modelSelection } from "./lib/model.ts";

export default defineAgent({
  model: modelSelection,
  defaultTools: false,
  // Recall is replaced independently; Eve compacts ordinary conversation history.
  compaction: { threshold: 0.75 },
});
