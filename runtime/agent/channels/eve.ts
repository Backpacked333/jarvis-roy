import { eveChannel } from "eve/channels/eve";
import { localBearerAuth } from "../lib/local-auth.ts";

export default eveChannel({
  auth: [localBearerAuth],
});
