# Premium voice boundary

This module is the outbound ElevenLabs transport, not an agent, permission broker
or public callback server. It never invokes Eve, answers a question, or submits
an approval. The native coordinator emits a final utterance with its original
typed room/question context; the harness question router owns validation and
atomic consumption. A spoken yes cannot authorize an approval.

## Integration

The integrator owns dependency manifests and shared bridge/native wiring. Add
exact runtime dependency `ws@8.22.1` and dev dependency `@types/ws@8.18.1`. The
implementation was typechecked and exercised with these pins and Node 24.22.2.
The older 8.18.3 install audit reported a high-severity issue; 8.22.1 reported no
vulnerabilities. Do not lower this pin to satisfy older type declarations.

```ts
import { createVoiceBridge } from "./harness-voice/index.ts";
const voice = createVoiceBridge({
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: process.env.ELEVENLABS_VOICE_ID,
});
// GET /v1/voice/status: return voice.status() through existing authenticated JSON.
// HTTP upgrade: first enforce the existing loopback remote address, Host,
// no-Origin and constant-time bearer-token checks, then:
voice.handleUpgrade(request, socket, head);
// Application shutdown:
await voice.close();
```

`handleUpgrade` checks the exact path, rejects Origins/query strings, bounds
connections, and delegates WebSocket framing to ws. **It is not an authentication
replacement**: the frozen constructor does not receive the local token. Never
attach it to an unauthenticated or publicly bound server. The optional frozen
`fetch` argument is unused: this integration uses outbound TLS WebSockets.

Native `VoiceController` conforms to `HarnessVoiceControlling` and retains the
legacy `onCommand`, `speak(_:)`, `stopSpeaking()` and wake controls. Wire:

```swift
voice.contextProvider = { /* capture selected room/conversation/question */ }
voice.onUtterance = { utterance in /* route the captured context, not UI focus */ }
voice.onAudioLevels = { levels in /* RoomsModel.updateAudioLevels */ }
voice.onStateChange = { state in /* RoomsModel.updateVoiceState */ }
voice.speak(questionText, context: exactQuestionContext)
```

Before any cloud voice, the user must explicitly opt in for the current session:
`voice.setCloudConsent(true)`. Show that microphone audio and spoken-reply text
go to ElevenLabs; discourage speaking secrets. Consent defaults off, is not
persisted, and is never inferred from a provider key. Use
`voice.setCloudConsent(false)` to revoke and immediately stop all audio. Keep
text usable when credentials, models, hardware or consent are unavailable.

`startListening()` snapshots context **before** async status/permission checks.
An explicitly spoken question supplies the next capture's exact binding until
muted or consumed. `finishListening()` commits a captured turn. `stopListening()`
is full mute/cancel and discards unfinished recognition. `interrupt()` and
`stopSpeaking()` drain playback and stop capture; starting another listening turn
is an explicit barge-in action. By default capture is paused throughout playback.
The separately opted-in acoustic mode below instead uses Apple's same-engine AEC.

If `onUtterance` is set, it is the sole final-text callback (never also
`onCommand`). Legacy manual transcription still updates `transcript` for review;
legacy wake commands call `onCommand` only without a bound question. Parent must
audit ambient conversation routing around pending Eve prompts: Eve rc.6 generic
follow-ups must not answer approvals. This module has no approval API.

**Update legacy UI copy** that says the command microphone is on-device. Only the
optional wake detector is on-device. Wake recognition discards Apple's text and
opens Scribe only after the wake phrase: say "Hey Jarvis", wait for visible
"Listening", then give the command. Arming requires separate explicit cloud
consent. Wake pauses for playback, rearms locally after a completed turn, and
stays off after errors/mute. It is not a transcription or synthesis fallback.

## Verified provider boundary

Official references inspected during implementation:

- [Eleven v4](https://elevenlabs.io/docs/overview/capabilities/text-to-speech/eleven-v4)
- [TTD WebSocket](https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket)
- [TTS versus TTD](https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets)
- [Scribe realtime](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime)
- [Scribe server streaming](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/server-side-streaming)

Output uses `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input` with
`model_id=eleven_v4_turbo&output_format=pcm_24000`. Initialize exactly one configured
voice, stream `inputs` with `voice_id`, flush and `close_socket` at final text,
and handle snake-case audio/final/error events. Incremental text shares one
generation. Keep-alive is sent for an unfinished text turn. Neither the old TTS
socket nor multi-context TTD is used: the docs exclude v4 there.

Input uses `wss://api.elevenlabs.io/v1/speech-to-text/realtime` with
`scribe_v2_realtime`, PCM16 mono at 16 kHz and manual commit. The bridge requires a
matching `session_started` config, forwards partial display text, and emits a
final only after an explicit commit. Output is mono PCM16 at 24 kHz. Provider
credentials travel only as outbound headers; provider error bodies are never
echoed into the app or logs. Scribe's real handshake can omit `commit_strategy`;
only that echoed field is optional, and it must still equal `manual` if present.
The outbound URL always requests manual commits. No downgrade, provider switch, key collection by
speech, or public tunnel exists.

`configured` means configuration exists, not account validation. `connected`
means an active provider transport/session; it does not prove sound or entitlement
to both models. An actual rejection is explicit on that turn. No ElevenLabs key
was available to this lane. The parent separately reported successful actual v4
PCM24k output and Scribe PCM16k transcription with exact context after the narrow
handshake fix. This is provider validation, not microphone/speaker/AEC validation.

## Opt-in acoustic hands-free mode

After the cloud disclosure/consent above, expose a **separate**, default-off,
current-session hands-free toggle and await `voice.setHandsFreeEnabled(true)`.
Observe `handsFreeEnabled` and `handsFreeStatus`; failure never leaves it enabled.
Explain that the microphone stays active **locally during replies** for speech
detection and will automatically send a bounded answer window to ElevenLabs after
a spoken bound question. Do not infer this consent from wake arming, a key, or the
spoken-attention toggle. Setting false, mute, stop, interrupt, cloud revocation,
device loss or a detector failure stops capture and revokes acoustic rearming.
Typed commands and manual push-to-talk remain available. Public stopSpeaking is
also a full acoustic stop, whereas an internally detected barge-in transitions
directly into a new capture generation.

Implementation:

- A dedicated duplex `AVAudioEngine` owns **both** the microphone and the actual
  reply `AVAudioPlayerNode`. While stopped, Objective-C-contained setup enables
  `setVoiceProcessingEnabled`, checks both I/O nodes and disables processing bypass.
  This is Apple's supported echo-cancellation path, not two unrelated engines or
  an RMS detector on raw speaker echo. The microphone is not routed to speakers.
- Preflight requires input/output hardware and a supported mono processed input
  format. Every poll verifies active, unbypassed voice processing. Hardware/config
  changes, stalled input, unsupported formats or failed system APIs disable the
  mode explicitly; no raw-input downgrade. Speaker/headphone combinations that
  cannot supply this configuration are unsupported for acoustic mode.
- A local `SoundAnalysis` built-in version1 speech classifier processes ONLY AEC
  PCM16k in bounded serial work, with a supported 500 ms window and 50% overlap.
  Two consecutive fresh speech results >=0.85 confidence and non-silent actual
  PCM are required. A bounded normalized-correlation veto rejects residual PCM
  matching the rendered mixer reference. RMS is a silence floor, **not** proof of
  human speech. AEC/classification/correlation reduce false triggers; they do not
  authenticate a speaker or guarantee rejection of every echo/background voice.
- During playback, no microphone audio is sent to Scribe. Retain at most one
  second of processed pre-roll locally; correlated echo clears it. Accepted
  speech synchronously stops queued playback, disconnects the old provider turn,
  advances the generation/session and starts Scribe with the **spoken turn's
  original context**, not whatever room is currently selected. Pre-roll plus
  connecting audio is capped at two seconds; slow handshakes fail closed instead
  of dropping words or replaying old turns. Pending PCM drains in order only after
  Scribe reports listening. Normal manual capture is unchanged.
- A spoken **bound clarification** opens an answer window automatically only
  after real audio was received, provider audio ended AND every native scheduled
  buffer reports `dataPlayedBack`. Provider idle/done alone does not suffice.
  The exact question/revision/room/run/node/attempt travels unchanged. Silence
  closes the window after eight seconds without committing or dispatching text;
  detected speech uses 1.2 seconds trailing silence and a 45-second maximum.
  Unbound narration does not auto-open an ambient answer window.
- Final transcripts alone call `onUtterance`. Partials remain display-only and can
  be corrected. No spoken yes, local VAD event or transcript authorizes approval.
  The parent still owns exact pending-question/approval routing and expiry checks.

System API references:
[Apple voice processing](https://developer.apple.com/videos/play/wwdc2019/510/),
[voice processing details](https://developer.apple.com/videos/play/wwdc2023/10235/),
[local stream classification](https://developer.apple.com/documentation/soundanalysis/classifying-sounds-in-an-audio-stream),
[classification windows](https://developer.apple.com/documentation/soundanalysis/snclassifysoundrequest/windowduration).
The muted-talker listener is deliberately not used: Apple documents it as active
only while the voice-processing uplink is muted, which would lose the requested
audible pre-roll. No TCC/database/permission scripts or copied actor voices are used.

This is real acoustic processing code but **physical hardware behavior is not
verified by injected tests or a provider round-trip**. Validate on the target Mac
with speakers/headphones, ordinary and loud reply audio, silence/room noise,
near-end speech over playback, immediate mute, device removal and switching rooms
during recognition. Classifier windowing introduces detection latency (roughly
750 ms of evidence plus inference); pre-roll protects onset, not zero latency.
Do not advertise a measured false-trigger rate or production acoustics yet.

## Bounds and lifecycle

- Local JSON <=32 KiB, each PCM chunk <=16,000 bytes, strict canonical base64 and
  consecutive sequence numbers. New local connections require fresh session IDs;
  new turns advance generations. Old callbacks cannot revive a stopped turn.
- PCM output queue <=96,000 bytes (two seconds), paced at 20 ms, with provider
  socket pause/resume backpressure. Native scheduled playback also caps two
  seconds and waits for actual `dataPlayedBack` callbacks before becoming idle.
- Provider JSON max 1,450,000 bytes, bounded fragment counts, no compression. A
  single provider audio chunk larger than the two-second queue is rejected, not
  accumulated off-queue or replayed. Live provider chunk sizes must be verified.
- Input burst <=64,000 bytes with real-time replenishment; bounded provider send
  buffer. Native uses a locked one-second input mailbox plus a bounded one-second
  encoded-send queue; audio callbacks never enqueue unlimited MainActor work.
- At most two local sockets, ten-connection burst replenishing at 20/minute,
  twelve-turn burst replenishing at 30/minute, 100 client frames/second sustained.
  Capture <=60 seconds bridge /45 seconds native; no-speech native capture commits
  after eight seconds, active speech after 1.2 seconds silence. App commit floor
  is 250 ms. Turn <=90 seconds, idle socket 30 seconds, connection <=10 minutes.
- Provider handshake retries once after 250 ms **only before opening**, when no
  audio/text has been sent. Anything after opening fails explicitly, with no
  replay. Native reconnect is explicit and gets a fresh session and generation.
- Objective-C exception containment and default-device checks remain around tap,
  engine, conversion and playback operations. Format changes fail closed. Real
  input RMS comes from converted buffers; playback RMS from the output mixer tap.
  No timer synthesizes audio activity. OS permission prompts use generation gates.

These are application resource limits, not a provider-enforced billing cap. A
provider may charge accepted work even if the user interrupts it. Local voice and
workers do not operate through Mac sleep/shutdown.

## Verification

```sh
source ~/.nvm/nvm.sh
nvm use 24
npm --prefix runtime run typecheck
node --experimental-strip-types --test runtime/test/harness-voice.test.ts
npm --prefix runtime test
npm --prefix runtime run build
```

The protocol tests use actual loopback WebSocket servers, not a pretend provider
success claim. They cover real wire codecs, byte-for-byte PCM pacing, exact
question context, invalid frames/configuration, consent, interruption, stopped
retries, stale sessions, overflow and multi-second producer backpressure.

Native tests cover pure generation/context/PCM state, real AVAudioConverter
buffers, system speech-classifier loading, playback-drain accounting, pre-roll,
echo-correlation fixtures and injected consent/device-loss/permission/duplex
callbacks. They require the
parent's macOS stage (`swift test --package-path macos`); there is no Swift or
Clang toolchain on the Linux implementation VM. Native sources and tests have not
been compiled here. Actual microphones/speakers and the user's ElevenLabs account
are separate mandatory acceptance checks, not inferred from those fixtures.
