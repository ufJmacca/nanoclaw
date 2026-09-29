# CoS interaction: Mattermost first, one private conversation

**Contract:** `cos-interaction/mattermost-first-v1`  
**Applies to:** S01–S11.  
**Decision:** default product interface is one dedicated, private Mattermost channel. This is a proposed configuration for implementation, not a claim that a channel or account has been activated.

## 1. Human-facing topology

Use a private channel such as `chief-of-staff`, with the designated owner and bot as its intended participants. Bind its immutable instance/channel IDs and the authenticated owner's platform ID, not the display name. Revalidate actual privacy and membership before admission, approval previews and output delivery. Platform administrators and backups remain within the platform's trust boundary; a private channel is not a cryptographic claim that no administrator can access its content.

The channel connects to the **Pi's NanoClaw**, which runs one persistent coordinator for that scope. Approved records, missions and decisions are held in PostgreSQL, not in Mattermost messages. Restarting a session does not delete the work model. The Mac is a development machine, not the chat backend. Use the existing Mattermost deployment; installing a new server or moving one onto the Pi is not required by these plans.

The current fork includes a native Mattermost adapter and strict channel-specific wiring. The inspected strict subscription sets `session_mode='shared'`, identifies threaded sessions as invalid, and maintains an exclusive channel/agent mapping [I01–I03]. Therefore **a Mattermost thread is not an isolated agent session in this plan**.

Start with one shared coordinator conversation and stable mission/decision IDs. Replies may be visually grouped in Mattermost threads only where the existing adapter supports this without changing strict session semantics. Thread presentation is optional; it is not an S01 prerequisite and must never be used as a security boundary. Do not change the strict topology to implement it. Specialist attempts get their own isolated execution AgentGroups under S05 and return results through the host, not through other Mattermost channels.

## 2. What the owner sees

| User action / system event | Visible experience | State / control |
|---|---|---|
| Ask “What should I focus on?” | Brief recommendation with sources and current coverage. | Read approved records; advice does not modify priorities. |
| Describe a goal/project | Proposed exact change followed by owner confirmation. | Versioned proposal; no unapproved canonical change. |
| “Research these options.” | Bounded work-order preview, then mission ID and status. | S05 approval/dispatch and independent specialist execution. |
| Daily scheduled review | A concise brief in this private channel. | Approved schedule, quiet hours and deduplicated notification intent. |
| Assistant notices worthwhile work | Reasoned proposal with accept, defer or dismiss controls. | S07; suggestion is not authorisation. |
| Approve a standing responsibility | Readable scope, sources, limits and expiry. | S08; future preparation is autonomous only inside the mandate. |
| “Reserve an hour tomorrow.” | Exact calendar/time/payload preview before any write. | S09 exact external-action approval and verified receipt. |
| Ask for status/cancel/pause | Immediate accepted/pending/denied state and recorded target ID. | Host validates owner identity and current generation. |
| A specialist finishes | One reviewed result with evidence and limitations. | Workers cannot directly message the owner or other channels. |

Retain all decisions and execution receipts independently of chat rendering. A delivery failure does not erase a pending decision. Reopening the conversation should allow querying outstanding decisions by ID.

## 3. Natural language and deterministic controls

Natural language is the main interface. It can propose actions and request status. For safety-critical confirmation and cancellation, provide deterministic owner-bound controls in addition to model interpretation.

Prefer an existing tested Approve/Reject interaction when the installed Mattermost adapter genuinely supports the required callback/identity flow. Do not assume a rich button works because a generic NanoClaw type exists. The portable baseline is an exact text command intercepted by the **host before model inference**, for example:

```text
cos approve P-104 <short-lived-confirmation-token>
cos reject P-104 <short-lived-confirmation-token>
cos status M-208
cos cancel M-208
cos pause automation
cos resume automation
```

These are **new proposed command contracts**, not installed bot commands. Confirmations bind the exact proposal/intent revision, payload hash, owner, instance/channel, expiry and a replay-protected challenge. The token alone grants no permission: an authenticated event from the bound owner and destination is required. Reject quote/attachment/source text, bot output, forged sender fields, stale events and modified previews as confirmation. Do not execute a command extracted by an LLM from untrusted documents. Ambiguous natural-language “yes” must not approve the wrong pending decision.

A corrected preview creates a new proposal revision and new confirmation token. Approve/Reject is the existing primitive's model; “modify” means prepare a new version, not fabricate an existing third button. Accept/defer/dismiss in S07 must likewise be deterministic versioned transitions, whether rendered as tested buttons or explicit commands.

For Mattermost, bind approval delivery to the validated owner-only private CoS channel, or an explicitly supported and separately bound owner-private surface. Do not fall back to a generic administrator DM. The strict subscription path is group/channel-scoped; do not make unverified Mattermost DM support a prerequisite. Reuse the NanoClaw approval abstraction while adding the backward-compatible CoS destination/receipt adapter from S01.

Read-only conversational requests can use the same host-derived session context. Application-level approvals are distinct from coding-agent PR approval and from already pre-authorised Pi deployments.

## 4. Telegram and other interfaces

**Mattermost is the selected first implementation target.** Telegram can remain an existing unrelated NanoClaw channel without becoming part of this CoS scope. No account migration or automatic cross-channel memory sharing occurs.

A later Telegram CoS surface would require an explicitly linked owner identity, source/destination disclosure policy, independent replay/delivery checks and decisions about which operations it can initiate. It could serve as a notification channel, but forwarding confidential briefing content would still need authority. Do not wire a Mattermost-owned group into `agent-shared` across Telegram to approximate this: native strict routing forbids such cross-group reuse.

A web dashboard, native mobile app, voice interface and general multi-channel CoS federation are not required by S01–S11. The host administration CLI is for setup, diagnostics, emergency pause and deployment; it is not the daily user interface. If Mattermost is genuinely unavailable, continue fixture implementation and report the live interface as unconfigured—do not silently select Telegram or install another chat service.

## 5. Development versus live messaging

Local Mac tests use a fixture Mattermost transport and synthetic owner/channel/event identities through the actual adapter contracts. Do not connect the Mac development instance to the Pi bot's tokens, polling session, WebSocket identity or production channel. Two active consumers must not race for the same messages or both answer them.

A live development bot, if separately authorised, uses a distinct bot/token/private test channel. Existing Pi runtime tokens stay on the Pi. Deployment smoke checks are fixture/no-send by default; use authorised real chat only when that exact access is already granted. Connecting a new account or sending real messages remains separate from the standing deployment authority.

## 6. Slice integration and acceptance

S01 proves fixture ingress → private scope → proposed goal → exact host-confirmed decision → durable record → Mattermost-formatted reply. It also documents the live channel-binding prerequisites. The account may remain unconfigured without inventing success.

Add these S01 tests and regress them in S04/S05/S08/S09/S11:

| ID | Requirement |
|---|---|
| S01-UI01 | Only the designated authenticated owner in the bound private scope can apply a control/approval. |
| S01-UI02 | Text commands and any supported buttons resolve the same exact proposal/intent lifecycle, expiry and replay rules. |
| S01-UI03 | Changed membership/privacy/subscription blocks subsequent sensitive previews, reads and deliveries. |
| S01-UI04 | Threads are presentation only; they neither grant authority nor bypass the existing strict shared-session model. |
| S01-UI05 | Mac fixture startup cannot consume or send through the Pi's real bot identity. |
| S01-UI06 | Telegram/other channels cannot inspect or approve Mattermost CoS records by guessing IDs. |
| S01-UI07 | Replying to a quote, source document or bot-generated command text cannot trigger an approval. |
| S01-UI08 | A model turn is not required to process a deterministic emergency pause/cancel command. |

S04 validates actual brief formatting and cadence; S05/S06 validate that specialist chatter stays out of the main channel; S07/S08 validate proposal noise and mandate digest behaviour; S09 validates exact external-action previews; S11 validates inspection/control when the model or database is unavailable. Safe status metadata/emergency deny-only actions can survive outages, not unchecked disclosure of stale private records.

## 7. Source references

- **I01:** [Mattermost registration](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost.ts).
- **I02:** [Mattermost adapter](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-adapter.ts): native ingress/egress, recovery and declared thread support; not evidence of thread session isolation.
- **I03:** [Strict subscription](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-subscription.ts): exclusive mapping and shared-session policy.
- **I04:** [Native agent route](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/agent-to-agent/agent-route.ts): cross-agent Mattermost restrictions.

Revalidate the actual installation during S01. No live channel, bot or approval path was tested while preparing this plan revision.
