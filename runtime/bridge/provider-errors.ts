// Turns a model provider's failure into something a person can act on. The
// original text is already redacted by the caller and is kept when no known
// cause matches, so nothing is hidden or invented.

const CAUSES: { test: RegExp; explain: string }[] = [
  { test: /rejected the provided api key|authentication failed|invalid api key|unauthori[sz]ed|\b401\b/i,
    explain: "The Vercel AI Gateway rejected the model key. Save a valid key in Settings → Provider credentials, then ask again." },
  { test: /insufficient (?:funds|credits?|balance)|out of credits?|payment required|no credits?|\b402\b/i,
    explain: "The Vercel AI Gateway account has no credits left. Add credits in the Vercel dashboard, then ask again." },
  { test: /rate.?limit|too many requests|\b429\b/i,
    explain: "The model provider is limiting requests right now. Wait a moment, then ask again." },
  { test: /model .*(?:not found|does not exist|is not available|unavailable)|unknown model|no such model|cannot select model/i,
    explain: "The configured model is not available from the gateway. Check the interactive model in Settings → Provider preferences, or clear it to use the default." },
  { test: /\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b|fetch failed|network (?:error|is unreachable)|socket hang up/i,
    explain: "Jarvis could not reach the Vercel AI Gateway. Check your internet connection, then ask again." },
  { test: /overloaded|service unavailable|bad gateway|gateway timeout|\b50[234]\b/i,
    explain: "The model provider is temporarily unavailable. Try again in a moment." },
];

/** A short cause and its fix for a known provider failure; otherwise the text unchanged. */
export function explainModelFailure(message: string): string {
  const text = message.trim();
  if (!text) return "The model call failed without giving a reason. Try again; if it repeats, copy diagnostics from the banner or Settings.";
  return CAUSES.find((cause) => cause.test.test(text))?.explain ?? text;
}
