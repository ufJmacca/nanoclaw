# CoS interaction: Mattermost first, one private conversation

**Contract:** `cos-interaction/mattermost-first-v1`  
**Plan revision:** 5. **Applies to:** S01–S11. **Decision:** one dedicated private Mattermost channel, not an assertion of an activated bot/account.

## 1. Human-facing topology

Use a private chief-of-staff channel with intended owner/bot participants. Bind immutable instance/channel/owner platform IDs, not display names. Revalidate privacy/membership before admission, sensitive previews and output. Platform admins/backups remain trusted; private channel is not cryptographic secrecy from administrators.

The channel talks to Pi NanoClaw's persistent scoped coordinator. PostgreSQL owns goals/missions/decisions independently of chat. Mac is development, not the conversation backend. Use the existing Mattermost service; no new server or move onto Pi is required.

Historical code inspection found strict exclusive channel/agent mapping with session_mode shared and invalid threaded execution sessions. Visual threads are not mission isolation. Optional thread presentation may be used only without relaxing strict session semantics. Start with one conversation and stable IDs. S05 specialist attempts have fresh isolated groups and return through host, not separate messaging channels.

## 2. User experience

| Request/event | Response |
|---|---|
| What should I focus on? | Grounded advice and current coverage, no priority mutation. |
| Describe goal/project | Exact versioned proposal requiring owner confirmation. |
| Research these options | Bounded work order, approval, mission ID and progress. |
| Daily review | Concise approved-schedule briefing respecting quiet hours. |
| Useful opportunity found | Evidence-backed proposal with accept/defer/dismiss. |
| Standing responsibility | Preview scope/sources/limits/expiry; autonomy only within approved mandate. |
| Reserve an hour tomorrow | Exact action preview before writer executes. |
| Status/cancel/pause | Host-validated accepted/pending/denied state targeting exact work. |
| Worker completion | One reviewed result with evidence and limits, not specialist chatter. |

Decision and effect records survive rendering/delivery failure. Pending decisions remain queryable by ID.

## 3. Deterministic controls alongside natural language

Natural language proposes actions and requests information. Critical confirmation/cancellation also has deterministic host controls processed before inference. Prefer genuinely implemented/tested native Approve/Reject callbacks; generic types do not prove adapter support. Portable baseline examples:

```text
cos approve P-104 <short-lived-confirmation-token>
cos reject P-104 <short-lived-confirmation-token>
cos status M-208
cos cancel M-208
cos pause automation
cos resume automation
```

These are proposed commands. Bind confirmation to exact revision/payload hash, authenticated owner, instance/channel, expiry and replay-protected challenge. Token alone grants no permission. Reject quoted/attachment/source/bot-generated commands, forged sender fields, old events and changed previews. LLM-extracted commands are not authenticated ingress. Ambiguous yes cannot select the wrong approval.

Correction creates a new preview/revision/token; modify is not a fabricated existing third button. S07 accept/defer/dismiss are exact transitions whether tested buttons or text controls.

Deliver CoS approvals only to validated owner-private channel or another explicitly supported/bound owner-private surface. No generic administrator DM fallback and no assumption strict group adapter implements DMs. Reuse native presentation with S01's backward-compatible CoS correlation/destination/receipt adapter. Application approvals differ from PR review and pre-authorised deployments.

## 4. Other interfaces and local development

Telegram remains separate, not a silent fallback or shared agent-shared context with Mattermost. Later CoS linkage needs explicit authenticated owner linking, disclosure policy, operation scope and replay/delivery checks. Notifications can still disclose confidential data and need authority. No web/mobile/voice/multichannel federation in these slices; host CLI is setup/diagnostics/emergency/deployment, not daily UI.

If Mattermost is unavailable, fixture implementation continues and live interface is unconfigured; do not install/select another service silently. Mac tests use fixture adapter/transport with synthetic identities. Never run a second consumer with Pi token, polling session or WebSocket identity. A separately authorised live dev bot has its own token/channel. Deployment smoke is fixture/no-send unless exact real access is already approved.

## 5. Tests and slice responsibilities

S01 proves fixture ingress → scoped proposal → exact host-confirmed approval → durable record → Mattermost-format reply, with live binding prerequisites separate.

| ID | Required behaviour |
|---|---|
| S01-UI01 | Only bound authenticated owner/private scope can apply controls/approval. |
| S01-UI02 | Text and supported buttons share exact lifecycle/expiry/replay semantics. |
| S01-UI03 | Changed membership/privacy/subscription blocks sensitive reads/previews/delivery. |
| S01-UI04 | Visual threads neither grant authority nor bypass strict shared-session mapping. |
| S01-UI05 | Mac fixture startup cannot consume/send through Pi real bot. |
| S01-UI06 | Other channels cannot read/approve CoS by guessed IDs. |
| S01-UI07 | Quoted/source/bot text cannot trigger confirmation. |
| S01-UI08 | Emergency pause/cancel requires no successful model turn. |

Regress in S04/S05/S08/S09/S11. S04 checks formatting/cadence; S05/S06 no specialist chatter; S07/S08 noise/digests; S09 exact previews; S11 safe inspect/control during model/DB failure. Local safe metadata and deny-only controls may survive outages, not unchecked private content.

## Evidence references

Historical fork: [registration](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost.ts), [adapter](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-adapter.ts), [strict subscription](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-subscription.ts), [native agent route](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/agent-to-agent/agent-route.ts). Revalidate current source and live binding in S01; no live channel test is claimed by preparing these plans.
