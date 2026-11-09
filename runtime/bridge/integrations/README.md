# Owner integrations

This module provides fixed HTTPS Telegram, Google OAuth/Gmail/Calendar, and Twilio
adapters. `IntegrationService.open()` does not contact providers. Only an explicit
`start()`, `tick()`, polling, OAuth callback, approved effect, or call request does.
The automated tests inject provider responses and use an ephemeral local HTTP
server. They do not send real messages, make calls, connect Google accounts, or
use live ElevenLabs credentials.

## Runtime wiring

Supply `dataDirectory`, a private random 32-byte `encryptionKey`, the shared
objective `ledger`, explicit `prices`, and owner hooks. Integrations default off
unless `enabled: true` or `JARVIS_ENABLE_INTEGRATIONS=1`. Missing provider sections
remain unavailable. Keep the encryption key separate from the SQLite data and
back it up securely; losing it makes saved Google tokens unusable.

The ledger interface is `reserve({requestId,projectId,objectiveId,authority,
estimatedUsd})` and `settle(id,{accounting,estimatedUsd})`. The existing objective
ledger enforces the $300 monthly, $10 daily, and $5 objective limits. Price fields
must be configured explicitly, including a documented zero for free APIs:
`telegramRequestUsd`, `googleRequestUsd`, `twilioRequestUsd`, `twilioMinuteUsd`,
`elevenLabsMinuteUsd` for recognition, and `elevenLabsCharacterUsd` for speech.
Unknown prices block dispatch. A call reserves five minutes of calling and
recognition plus 10,000 speech characters. Interrupted or unmeasured outcomes keep
their reservation unknown. Provider rates must reflect the configured account,
destination, voice/model, and applicable billable rounding.

`route(request,response,externalURL)` accepts only Google OAuth callbacks and
authenticated Twilio webhooks under `/v1/cloud/integrations/`. Construct
`externalURL` from the configured HTTPS origin, never an untrusted forwarded Host.
`upgrade()` authenticates the Twilio WebSocket handshake and binds its media token
to one call and stream. The reverse proxy must preserve `X-Twilio-Signature`, the
original path/query, and WebSocket upgrades. Setup methods and `setup()` require
the root server's owner/native authentication; they are not public callbacks.

The root must inject `authorizeDisclosure({projectId,channel,destinationId,
proactive})`. It is evaluated using the configured numeric Telegram chat or E.164
phone number, never a model-supplied destination. Details fail closed without it.
`authorizeCallOutreach()` separately permits a generic proactive phone call.
Telegram or Twilio authentication never grants native or approval authority.

## Telegram

Create a bot, configure its token and one numeric private owner chat ID, then use
the authenticated setup action to obtain a ten-minute pairing code. The owner
sends `/start CODE` from that exact private chat. Groups, bots, other senders, and
other chats cannot pair or issue commands. Polling uses durable update offsets;
an ambiguous handoff is not automatically replayed. Replies to questions preserve
the exact objective/question/revision/expiry binding. They are answers, not action
approvals. `/stop` invokes the root stop hook ahead of ordinary messages.

The durable outbox holds routine notifications during 22:00–08:00 in the configured
IANA time zone and permits at most four routine messages, questions, and digests
combined per local day. `scheduleDigests()` obtains content from the root hook at
09:00 and 18:00, once per slot. Direct replies are distinguished from proactive
outreach. An outbound request is durably fenced before sending; uncertain sends
are never retried automatically, including after restart. Outbox bodies marked
`project_details` recheck the disclosure grant after reserving budget and
immediately before sending; revocation cancels them. `minimal` is reserved for
the root's generic status/review-link templates.

## Google

Register the exact redirect URI
`https://YOUR_HOST/v1/cloud/integrations/google/callback` in the Google OAuth app.
The PKCE state and verifier are single-use and expire after ten minutes. Access and
refresh tokens are AES-256-GCM encrypted with account/consent-bound associated
data. Read consent requests Gmail and Calendar read scopes. Gmail sending and
Calendar event creation each require a separate OAuth consent and an exact
existing Jarvis approval; neither scope silently upgrades read consent.

Selected label/calendar IDs are project-bound. OAuth does not itself permit body
retention or cloud reasoning: `retentionAllowed` and `cloudAllowed` both default
false. Polling bodies requires retention permission. Approved retained context is
bounded to 500 current items per account; context delivery is capped at 20 items
and 64 KiB and rechecks the account revision, current selectors, and both grants.
Permission changes abort reads, invalidate old references, and remove content
outside the retained scope. Disconnecting removes the retained content and tokens.
Mail attachments and remote HTML resources are not fetched. Plain-text bodies are
bounded and marked when truncated. Calendar reads are incremental event records,
including recurrence rules and exceptions. They do not expand every recurring
daily occurrence; each retained calendar record states this limitation. Gmail uses
history cursors captured before initial scans. Poll intervals are at least five
minutes and pagination continues across polls.

`prepareGoogleAction()` returns exact canonical arguments and a digest.
`executeGoogleAction()` invokes the injected existing approval authority before
its sole provider-effect callback. The root binds the effect to the persisted Eve
approval receipt and its exact project/arguments. Reused request IDs with changed
arguments and uncertain outcomes are rejected. This module is not another
approval engine.

## Phone and speech

Configure one Twilio-owned calling number and one owner E.164 destination. Verify
the owner number in the Twilio account; `verifyOwnerNumber()` checks its verified
caller IDs. A proactive call requires a blocked deadline within 60 minutes, an
unanswered question for at least ten minutes, a configured outreach grant, and a
budget reservation. A separate versioned per-project outreach policy defaults off
and requires confirmation of the configured time zone and enabled categories.
`considerObjectiveCall()` checks the current authoritative objective and an exact
known-sent question notification. The `call_when_ready` category additionally
requires an owner request bound to an authoritative objective revision and frozen
goal/steps, with an expiry of at most 24 hours. It is consumed once the unchanged
objective completes. Policy changes and Stop cancel pending requests. Quiet hours
apply to both call categories. Calls are limited to two per local day, one per issue, at least
five minutes apart, and a five-minute provider time limit. Recording is disabled.

The initial call gives only a generic prompt to open the trusted Jarvis review
page. The cloud gateway must verify a fresh passkey assertion bound to the exact
live `CallSid`, then invoke `authorizeCall(callSid,proof)`. Its live proof and the
phone disclosure grant are rechecked before private transcript handling and
audio output. Ordinary speech or a generic "yes" cannot approve actions.

`ExistingVoiceSpeechAdapter` connects only to the existing authenticated loopback
`/v1/voice/stream` bridge. It reuses the ElevenLabs recognition/dialogue adapter,
generation checks, and no-replay behavior. Stop and call-authorization revocation
advance a durable authorization generation: prior calls cannot regain private
access after resume, even if a passkey assertion or provider cancellation finishes
late. Every stop action is attempted; cancellation failures remain an explicit
`uncertain` stop status and are reported to the caller. G.711 µ-law 8 kHz media is converted to
PCM16 16 kHz; existing 24 kHz dialogue output is downsampled to µ-law. No cloud AI
credential is needed in this gateway. The private bridge token must never be
exposed to Twilio, Telegram, the browser, or workers.

## Before deployment

Provision the owner accounts, OAuth consent screen, HTTPS callback origin,
passkey review flow, private data directory, encryption key, exact destination
grants, and provider prices. Then test a real consent callback, owner pairing,
Twilio signature behind the proxy, actual billing measurements, and microphone
round trips on the deployment host. Fixture tests establish protocol behavior;
they do not establish live provider access or speech quality.
