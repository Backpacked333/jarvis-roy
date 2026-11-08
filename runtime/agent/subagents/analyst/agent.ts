import { defineAgent } from "eve";
import { modelSelection } from "../../lib/model.ts";

export default defineAgent({
  description: "Analyze a supplied problem or draft a document in the background. No live web access or desktop actions.",
  model: modelSelection,
  defaultTools: false,
});
