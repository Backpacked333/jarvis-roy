# Evaluate Jarvis on your Mac

[tasks.json](tasks.json) fixes **30 tasks** across research, mathematics, coding,
writing and daily assistance. [baseline.json](baseline.json) preserves the
pre-implementation automated baseline and marks all 30 live evaluations unrun.
Runtime unit tests validate implementation behavior; they do not score research
quality, physical voice interaction or task success. This directory makes no
provider calls automatically.

## Create a private report

Use Node 24 and a report directory outside the checkout. Reports and evidence
can contain personal material; do not commit them or provider credentials.

```sh
mkdir -p "$HOME/Jarvis-evaluation/evidence"
chmod 700 "$HOME/Jarvis-evaluation"
node evaluations/record.mjs init "$HOME/Jarvis-evaluation/report.json"
node evaluations/record.mjs check "$HOME/Jarvis-evaluation/report.json"
```

`init` creates a private, versioned report with all 30 tasks `unrun` and refuses
to overwrite an existing file. `check` validates its schema, suite digest, exact
task IDs, scores and evidence paths; it reports missing work and measurements.
It does not read evidence content, verify claims or turn an unrun task into a
pass. Evidence paths are relative files within the report directory.

Record the full Git commit, reviewer, Mac model/chip/RAM/macOS, network route and
latency, microphone/output devices, speaker/headphone route, sample rate, exact
interactive/deep/speech/transcription model IDs and effective feature flags.
Record the analysis image's immutable identity where used. Give each input file
a stable label and SHA-256 digest in `fixture.sources`; preserve the actual
inputs privately in `evidence/`. Include source versions, grants/cloud-sharing
settings, provider access, budgets and test-specific setup in task notes or
evidence. Record changed fixtures in a new report, not silently over an old run.

## Run and review the fixed tasks

1. Read each task's prompt and acceptance criterion. Prepare concrete inputs
   once: papers with disagreements, conflicting evidence, a missing full text,
   revision pairs, numerical data, broken code/tests and safe account fixtures.
   Save the exact instantiated prompt, expected checks and input digests before
   running. Keep those fixtures stable across comparisons.
2. Run tasks manually through the app on the documented Mac. Use project-scoped
   grants and explicit research/Rooms budgets. For sends, use a self-owned test
   recipient and review the exact action; never infer authorization from an
   evaluation prompt. If a prerequisite is missing, record `blocked` and why.
3. Save each task's actual transcript, source passages/version IDs, plan and
   limits, artifact hashes, worker image, commands, test output, critique,
   limitations and observed outcome as applicable. Capture errors and uncertain
   cancellations/sends. Source metadata alone cannot support a claimed full-text
   quotation. Re-run calculations from recorded inputs; inspect real artifact
   bytes and code diffs. Expert review is needed for substantive conclusions.
4. Review against the fixed acceptance criterion and score using the table.
   Fill `executedAt` (ISO timestamp), `notes` and `evidencePaths`. Record reasons
   for unmet criteria. A task designed to expose missing evidence can pass when
   Jarvis correctly identifies that limitation.
5. Validate the report and compare it with the previous run by task/category,
   preserving failures and blocked work. Repeated attempts belong in evidence
   with their conditions; do not keep only a successful retry.

| Status | Score | Meaning |
| --- | --- | --- |
| `unrun` | `null` | Not attempted. |
| `blocked` | `null` | Cannot assess due to a documented missing prerequisite. |
| `failed` | `0` | Attempted; acceptance criterion not met. |
| `partial` | `1`, `2` or `3` | Some useful work, respectively major, material or minor unmet criteria. Describe the gap. |
| `passed` | `4` | Human review found the complete acceptance criterion satisfied with evidence. |

Zero is an observed failed **task score**, never a substitute for an unavailable
measurement. Do not average unrun/blocked tasks as zeros or call model critique
independent factual verification.

## Measure physical interaction separately

For each metric, collect **at least 30 valid samples** under a documented fixed
Mac/network/audio setup. Record every attempt, failures and missing timestamps,
the raw timing evidence and measurement method. Use one monotonic clock or
synchronized recorded audio/video; account for frame/sample resolution. Report
speaker and headphone fixtures separately, including long pauses, interruptions,
device changes, sleep/wake and permission denial.

| Metric | Start → end | Target |
| --- | --- | --- |
| `interruption` | Audible user interruption onset → actual Jarvis output stops | p95 ≤250 ms |
| `visibleFeedback` | Local input/event → first corresponding visible state update | p95 ≤150 ms |
| `firstMeaningfulAudio` | Committed simple user turn → first audible answer content | median ≤3,000 ms |

For audio, transport arrival or a playback callback alone is not physical speaker
latency. “Working…” is not meaningful answer content. Measure deep-work duration
separately in task evidence; do not mix it into simple-turn latency. Report
conversational end-of-speech→commit latency separately if turn detection adds a
delay. Use the same clock boundaries for every comparison.

Put valid timings in `samplesMs`, count failed and missing attempts in their
separate fields, and explain them in `notes`. Never replace them with zero.
The script computes nearest-rank p95/median, reports the measured sample count,
and leaves target assessment unset below 30 samples. A target met among measured
samples does not excuse failed or missing attempts. Retain raw recordings/logs
and user authorization for any personal content they contain.

```sh
node evaluations/record.mjs check "$HOME/Jarvis-evaluation/report.json" --require-complete
```

Exit code `0` means valid structure (and, with `--require-complete`, all tasks
assessed, required fixture fields filled and sufficient timing samples). Exit
`1` means invalid structure or missing evidence files; `2` means valid but
incomplete. Completion can contain failed tasks or missed latency targets; it
is not a release approval. Feature gates also require the target Mac's startup,
permissions, isolation, privacy, restart and cancellation acceptance described
in [implementation status](../docs/implementation-status.md).
