# Native latency diagnostics

Settings → Diagnostics and macOS unified logging (`ai.backpacked.jarvisroy`,
category `diagnostics`) expose fixed event names, fixed service roles, timestamps
and optional `duration_ms`. The in-app history retains 100 events. Labels are
allowlisted; negative, nonfinite and over-ten-minute durations are rejected.
No text, audio, source names, session identifiers or credentials enter these
diagnostics. Durations use monotonic uptime, not wall-clock subtraction.

| Event | Measurement |
| --- | --- |
| `voice_speech_requested` | A validated sentence begins native speech preparation. |
| `voice_first_pcm` | Sentence preparation to the first accepted provider PCM frame. |
| `voice_playback_scheduled` | Sentence preparation to successful first-buffer scheduling. |
| `voice_first_output_rendered` | Sentence preparation to the first output render callback with RMS ≥ 0.001. The callback timestamp is sampled through the existing bounded audio mailbox. |
| `voice_interrupt_complete` | Explicit interruption or listening request while speaking, through local audio cleanup. |
| `voice_barge_in_stop_complete` | An accepted local speech detection decision through stopping the player. Detection time before that decision is excluded. |
| `voice_capture_ready` | Capture preparation through publishing the native listening state, including provider connection and any permission wait. |
| `session_local_feedback` | Accepted submit handler through publishing the submitting state. |
| `session_event_applied` | Sequenced event processing through native state updates and speech routing. |

Each speech milestone is emitted at most once per generation. Cancellation and
replacement clear the trace; stale audio cannot complete a later generation's
measurements. Silent audio produces no first-non-silent-output event. Audio
callbacks neither log nor enqueue unbounded work on the UI thread.

These are component measurements. Render time excludes device buffering and
physical speaker delay; state publication is not a compositor-presented frame.
Speech preparation begins after text is available, so it excludes transcription
and model reasoning. Do not compare it directly with the three-second full-turn
target. No target or percentile is certified by adding this instrumentation.

For release validation, record the Mac model, macOS version, audio devices,
network fixture and provider configuration. Measure physical interruption and
first meaningful audio with loopback/acoustic timing, and visible feedback with
screen frame timing. Exercise speakers, headphones, long pauses, device changes,
sleep and denied permissions. Report cold/warm starts and deep work separately;
retain failed or missing samples rather than treating them as zero latency.
