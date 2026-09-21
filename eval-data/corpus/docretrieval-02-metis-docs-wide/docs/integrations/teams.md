# Microsoft Teams app foundation

> Epic #547 (Phase 0, #548). This is the **shared Teams-app foundation** — the bot
> messaging endpoint, per-workspace OAuth install flow, encrypted bot credentials,
> and the `ConversationReference` store. Every other Teams capability layers on
> top of it: the collaboration bridge (#549–#554) and the pre-existing ChatOps
> (#63) and notification-card (#67) epics. **This phase does not yet bridge
> discussions** — it only stands up the plumbing and a health/echo bot.

---

## What this phase ships

| Capability | Where |
|---|---|
| Bot messaging endpoint (`POST /api/integrations/teams/messages`) | `server/src/routes/integrations/teams.ts` |
| Inbound Bot Framework JWT verification | `server/src/lib/teams/bot-adapter.ts` (SDK `CloudAdapter`) |
| Per-workspace OAuth/connect install flow | `server/src/routes/integrations/teams.ts` + `installation-store.ts` |
| Encrypted bot credentials (AES-256-GCM, vaulted) | `server/src/lib/teams/installation-store.ts` → `vault-service.ts` |
| `ConversationReference` store (get/save/delete) | `server/src/lib/teams/conversation-reference-store.ts` |
| Teams app manifest scaffolding | `server/src/lib/teams/manifest.ts` |

The bot is built on the official **Bot Framework SDK for Node — `botbuilder`
v4.23.3** (verified against `server/package.json`). Inbound activity authenticity
is verified by the SDK's `CloudAdapter` + `ConfigurationBotFrameworkAuthentication`
(Bot Framework JWT in the `Authorization` header) — we do **not** hand-roll JWKS
validation.

---

## HTTP surface

### Bot messaging endpoint (called by Teams / Bot Framework)

```
POST /api/integrations/teams/messages?workspaceId=<id>
```

- **Authentication:** the Bot Framework JWT in the `Authorization` header,
  validated by the SDK adapter against the workspace's `MicrosoftAppId`. This
  route is **not** behind METIS user auth (`requireAuth`) — it is authenticated by
  the channel-service JWT, not a METIS session.
- `workspaceId` (query) routes the activity to the right workspace's bot
  credentials. **Missing `workspaceId` → 400.**
- A workspace with **no installed credentials → 403** (`TEAMS_NOT_INSTALLED`). We
  never run an auth-disabled adapter that would accept unsigned activities.
- An **invalid/expired/unsigned** activity → **401** (`TEAMS_ACTIVITY_UNAUTHORIZED`).
- On a valid `message` activity the bot captures/refreshes the
  `ConversationReference` and **ingests the message into the linked discussion
  thread** (Phase 2 inbound, #551 — see
  [Inbound message sync](#inbound-message-sync-phase-2--551)). The Phase 0 echo
  behaviour was removed when inbound ingestion landed.

### Admin install flow (workspace admin only)

All of these require `requireAuth` + `requireWorkspaceRole("admin")` (system
admins bypass workspace RBAC).

```
POST   /api/integrations/teams/workspaces/:workspaceId/install
GET    /api/integrations/teams/workspaces/:workspaceId/installation
DELETE /api/integrations/teams/workspaces/:workspaceId/installation
GET    /api/integrations/teams/workspaces/:workspaceId/manifest?packageId=<guid>&publicHost=https://...&botName=METIS
```

`POST .../install` body:

```jsonc
{
  "appId": "<Azure bot app (client) id — MicrosoftAppId>",
  "appPassword": "<Microsoft App Password / client secret>", // encrypted+vaulted, never stored raw
  "tenantId": "<Azure AD tenant id>",   // required only for a SingleTenant bot
  "appType": "MultiTenant",             // MultiTenant | SingleTenant | UserAssignedMSID
  "label": "Prod bot"                   // optional
}
```

The response (and every read) is **secret-free** — the app password is never
echoed back. Re-installing the same `(workspace, appId)` rotates the stored secret
in place. `DELETE` revokes the installation and soft-deletes the vaulted secret.

---

## Secret handling (OWASP A02)

The bot's **Microsoft App Password is never stored on the installation row** and
never logged:

1. On install, the plaintext password is written to the hardened secret vault
   (`server/src/lib/vault/vault-service.ts`, AES-256-GCM with a versioned
   envelope) under the deterministic label
   `teams-bot-password:<workspaceId>:<appId>` (project scope).
2. Only a `${vault:...}` reference is persisted in
   `TeamsAppInstallation.appPasswordRef`.
3. At adapter-construction time the reference is resolved back to plaintext via
   the vault — plaintext never touches the installation table, logs, or API
   responses.

In production the vault refuses to start without a strong `VAULT_MASTER_KEY`
(`openssl rand -base64 32`).

---

## Data model

Two Prisma models (real migration, not the UNLOGGED ephemeral tables used for
rate-limit/SSO-state counters — a `ConversationReference` is **durable** data
whose loss silently breaks proactive delivery):

- **`TeamsAppInstallation`** (`teams_app_installations`) — per `(workspaceId,
  appId)`, holds `appId`, `appPasswordRef` (vault ref), `tenantId`, `appType`,
  `status` (`active`|`revoked`).
- **`TeamsConversationReference`** (`teams_conversation_references`) — keyed by
  `(workspaceId, conversationId)`, holds `serviceUrl`, `tenantId`, `channelId`,
  `aadObjectId`, `userId`, and the serialized reference JSON.

Both reuse the shared Postgres (via the #539 scheme-selected adapter) so a
reference saved by one replica is visible to every other — the same multi-replica
guarantee as the #541/#542 stores.

Phase 1 (#549) adds two more (same durable-data choice):

- **`TeamsChannelLink`** (`teams_channel_links`) — maps a `DiscussionThread` ↔ a
  Teams channel within a workspace. Holds `threadId`, denormalized `projectId`
  (for authz), `conversationId`, `channelId`, `tenantId`, `status`.
- **`TeamsUserIdentity`** (`teams_user_identities`) — binds a Teams sender's
  `(tenantId, aadObjectId)` to a METIS `userId` (plus the `email` captured at
  bind time, for provenance).

Phase 2 (#550) adds one column (no new model):

- **`DiscussionMessage.origin`** (`String @default("metis")`, free-form like
  `authorKind`) — `metis` for in-app messages, `teams` for messages ingested from
  a linked channel (set by #551). The outbound mirror skips non-`metis` origins;
  see [Loop guard / origin](#loop-guard--origin-the-551-seam--important).

---

## Linking & identity (Phase 1 — #549)

### Thread ↔ channel links

`POST|GET|DELETE /api/integrations/teams/workspaces/:workspaceId/links[/:linkId]`

- **Cardinality — one channel ↔ one thread.** A channel maps to at most one
  thread (`(workspaceId, conversationId)` unique) and a thread to at most one
  channel (`threadId` globally unique). A collision returns `409 LINK_CONFLICT`.
- **Authorization — member-only.** Create/list/unlink gate on `canAccessThread`
  (`server/src/lib/discussions/access.ts`), so only a workspace member on the
  thread's project may link/list/unlink (denials are audited). The link's
  workspace is **derived from the thread's project** and cross-checked against
  the path `:workspaceId` (`403 WORKSPACE_MISMATCH` otherwise) — a caller cannot
  link a thread into a workspace they are not a member of. List filters each row
  through `canAccessThread`; delete is workspace-scoped (a guessed link id from
  another workspace cannot be removed).

### AAD → METIS user mapping

`resolveUserFromAadObjectId(tenantId, aadObjectId)` →
`server/src/lib/teams/aad-identity-resolver.ts`.

METIS SSO has **no stored external-subject id**: both OIDC and SAML map an
external identity to a `User` **by email** (`linkOnFirstSSOLogin` in
`server/src/lib/auth/migrate-link-sso.ts`; the providers extract `email` from
claims). A Bot Framework activity carries `aadObjectId`/`tenantId` but not
reliably an email, so Phase 1 persists a durable `(tenantId, aadObjectId)→userId`
binding **established through that same SSO email match** (`linkByEmail`,
case-insensitive) or an explicit admin link (`linkExplicit`). This **reuses** the
existing identity linkage rather than inventing a parallel one — the binding row
is just a Teams-side cache of "this AAD subject is that METIS user".

- **Establishing a binding (workspace admin):**
  `POST /api/integrations/teams/workspaces/:workspaceId/identities` with
  `{ tenantId, aadObjectId, email }` (SSO email match) **or**
  `{ tenantId, aadObjectId, userId }` (explicit). No active matching user →
  `404 AAD_USER_UNMAPPED`.
- **Cross-tenant isolation (OWASP A01):** the binding key is
  `(tenantId, aadObjectId)` and the resolver **requires a non-empty `tenantId`**,
  so an `aadObjectId` from a different tenant can never resolve to a local user,
  and a tenant-less sender resolves to `null`.
- **Unmapped senders are never silently attributed:** the resolver returns
  `null` (also for bindings to disabled/soft-deleted users) — later phases (#551
  inbound) must reject or flag these senders, never post them as a METIS user.

---

## Outbound message sync (Phase 2 — #550)

`mirrorMessageToTeams(threadId, message)` /
`scheduleMirrorToTeams(threadId, message)` →
`server/src/lib/teams/outbound-sync.ts`; the renderer →
`server/src/lib/teams/outbound-render.ts`.

When a new `DiscussionMessage` is created in a thread that is **linked** to a
Teams channel (Phase 1), the message is mirrored OUT into that channel as a Bot
Framework **proactive message**. Inbound ingestion (#551), the AI participant
(#552), and promote (#553) are **not** part of this phase.

### Hook point

`server/src/routes/discussions.ts` calls `scheduleMirrorToTeams(threadId,
message)` immediately after the existing `emitMessageNew` socket fan-out — for
**both** the human REST post (`POST /threads/:id/messages`) and the persisted AI
reply (`POST /threads/:id/ai-respond`). The mirror reuses the same fan-out seam
the in-app realtime layer uses, so every new message reaches both surfaces.

### How a send works

1. **Resolve the link** for the thread. The link store is workspace-scoped, but
   `threadId` is globally unique and belongs to exactly one project → one
   workspace, so the workspace is derived from the thread's project, then the
   link is read. **No link → immediate no-op** (no credential resolution, no
   adapter, no network — most threads are not bridged, so the hot path is free).
2. **Load the stored `ConversationReference`** (#548) for the linked channel.
3. **Resolve the bot credentials** from the #548 vault, build a `CloudAdapter`,
   and call `continueConversationAsync(botAppId, reference, logic)` — the
   CloudAdapter proactive API in `botbuilder` v4.23.3 (the legacy
   `continueConversation(reference, logic)` is unsupported on `CloudAdapter`).
   The `logic` callback `sendActivity`s the rendered text.

### Human vs AI rendering

Authorship is rendered INTO the message text (the Teams channel has no METIS
author chrome) and human vs AI is visibly distinct:

| Author | Rendered as |
|---|---|
| Human | `**<displayName>**: <body>` (bold name; falls back to `METIS user`) |
| AI | `🤖 **METIS AI** (<model>): <body>` (robot marker + model for provenance) |

The body is length-clamped (Teams rejects oversized activities); markdown is
otherwise passed through (Teams renders a constrained subset; the body already
survived in-app rendering).

### Loop guard / origin (the #551 seam — IMPORTANT)

`DiscussionMessage.origin` (`String @default("metis")`, free-form like
`authorKind`) discriminates where a message came from:

- `metis` — created in-app (human REST post or AI reply). **Mirrored outbound.**
- `teams` — ingested from the linked channel by inbound sync (**#551 will set
  this**). **Skipped by the outbound guard** — the very first check in
  `mirrorMessageToTeams` returns early on any non-`metis` origin, BEFORE any link
  lookup, so a Teams-sourced message is never echoed back into the channel it
  arrived from. Without this, every inbound message would bounce straight back
  out and loop forever.

This is the contract #551 depends on: **inbound writes `origin: "teams"`;
outbound only mirrors `origin: "metis"`.**

### Robustness — failures never break message creation

The mirror is **best-effort, fire-and-forget, and never throws into the request
path**. `scheduleMirrorToTeams` schedules the work without `await`, and
`mirrorMessageToTeams` swallows every failure (expired/missing
`ConversationReference`, Teams API error, uninstalled app, inactive link),
logging it and returning `{ mirrored: false, reason }` internally. The user's
in-app POST that created the message always succeeds regardless — the same
posture as the existing socket-emitter and @mention fan-out.

---

## Inbound message sync (Phase 2 — #551)

`ingestTeamsActivity(context, { workspaceId })` →
`server/src/lib/teams/inbound-sync.ts`, invoked by the bot turn logic
(`server/src/lib/teams/bot-handler.ts`) for every `message` activity.

When a user posts in a Teams channel that is **linked** to a discussion thread
(Phase 1), the message is ingested as a human `DiscussionMessage` and — through
the realtime fan-out — appears to in-app users exactly like a native message. The
AI participant runs after ingestion (Phase 3, #552 — see
[AI participant via Teams](#ai-participant-via-teams-phase-3--552)); promote (#553)
is **not** part of this phase.

### Shared creation path (no bypass)

The per-message side effects — build via `buildHumanMessageData` (author
invariant), persist, `dispatchDiscussionMentions` (member-only @mention
notifications), `emitMessageNew` (realtime `thread:{id}` fan-out), and
`scheduleMirrorToTeams` (outbound) — live in **one** function,
`createHumanDiscussionMessage` (`server/src/lib/discussions/create-message.ts`).
BOTH the REST `POST /threads/:id/messages` route and the Teams inbound bridge
call it, so a Teams message cannot skip the invariant, the member notifications,
or the realtime emit, and the two entry points can never drift apart.

### How an inbound message is ingested

1. **Activity type.** Only `message` activities carry content; everything else is
   ignored.
2. **Bot-own-message guard.** A proactive message #550 sent comes back as an
   activity whose `from.id === recipient.id` (the bot's own id) — ignored before
   any work (see [Loop guard round trip](#loop-guard-round-trip)).
3. **Resolve the link.** `getByConversation(workspaceId, conversationId)` (#549).
   No active link → the channel is not bridged → ignored.
4. **Text.** The leading bot `@mention` markup is stripped (other users'
   mentions preserved); an empty / mention-only message is skipped.
5. **Resolve the sender.** `resolveUserFromAadObjectId(tenantId, aadObjectId)`
   (#549), with `tenantId` taken from the activity's `channelData.tenant.id`,
   then `conversation.tenantId`, then the link's recorded tenant.
6. **Unmapped sender → never attributed to nobody.** When the resolver returns
   `null`, ingestion is **skipped** and a one-time, per-conversation, best-effort
   hint is posted back to the channel inviting the user to link their METIS
   account. No message is created.
7. **Member/tenant authorization.** Identity is not authorization — the resolved
   user is run through `canAccessThread` at the **lowest privilege**
   (`role: "reader"`, so access must be earned through real project membership,
   never a fabricated admin role). A resolved-but-unauthorized sender is rejected
   (forbidden); a link pointing at a missing/soft-deleted thread reports
   not-found.
8. **Create.** `createHumanDiscussionMessage({ ..., origin: "teams" })` — the
   `origin: "teams"` is what makes the #550 outbound mirror skip it.

### Loop guard round trip

The bridge is safe in both directions:

- **Teams → in-app.** A channel message becomes an `origin: "teams"`
  `DiscussionMessage`; the #550 outbound guard skips non-`metis` origins, so it is
  **not** echoed back into the channel it came from; the realtime `message:new`
  emit makes it appear to in-app members live.
- **In-app → Teams.** An in-app post (`origin: "metis"`) is mirrored OUT by #550;
  it arrives back at the bot endpoint as an activity whose `from.id` is the bot's
  own id, and the **bot-own-message guard** (step 2) ignores it, so it is **not**
  re-ingested.

### Security

The endpoint is gated by Bot Framework JWT auth (#548). Teams message text is
treated as **untrusted** — it flows only into `DiscussionMessage.body`, rendered
by the existing XSS-safe markdown path; it is never placed in any executable sink.
Two further gates run on every inbound activity (#554): a **tenant allowlist**
(`TEAMS_ALLOWED_TENANTS`) rejects activities from non-approved tenants even when
the JWT is valid, and a **per-`(workspace, conversation)` inbound rate limit**
(`TEAMS_INBOUND_RATE_LIMIT_*`) caps how fast one channel can push messages into
METIS. Both run **before** sender resolution or any DB write. See
[Security model](#security-model-phase-4--554).

---

## AI participant via Teams (Phase 3 — #552)

The #475 LLM participant works **from Teams**: an `@AI` mention in a linked
channel triggers the EXISTING discussion AI responder, and the reply appears in
the in-app thread AND (mirrored once) back in the Teams channel. **No AI logic is
reimplemented** — `server/src/lib/teams/ai-participant.ts` (`maybeRespondAsAI`)
reuses `ai-gate.ts` (`shouldAIRespond`), `ai-rate-limit.ts`
(`checkThreadAIRateLimit`), and `ai-responder.ts` (`streamAIReply`) verbatim.

### Where it runs

After [inbound ingestion](#inbound-message-sync-phase-2--551) creates the human
`DiscussionMessage` (`origin: "teams"`), `inbound-sync.ts` reads the thread's
`aiResponseMode` and calls `maybeRespondAsAI(context, trigger)`. The AI step is
**best-effort and never changes the `"ingested"` outcome** — a failure is logged
and swallowed; the human message stays ingested.

### Canonicalizing the `@AI` mention

The in-app gate (`detectAIMention`) matches the literal token `@AI`. A Teams `@AI`
arrives as a **mention entity** whose `text` is an `<at>AI</at>` tag (the literal
`@AI` is not in `activity.text`). `canonicalizeAIMention` rewrites any AI-directed
mention entity — matched by the inner `<at>` text **or** `mentioned.name` equal to
`AI` (case-insensitive) — into a canonical ` @AI ` token, so the **same** gate the
REST `ai-respond` route uses recognizes it. A plain-text `@AI` a user types already
canonicalizes to itself; other users' mentions are left untouched. (The leading
**bot** recipient mention is already stripped by #551 before this runs.)

### `aiResponseMode` honored end-to-end

The gate decides BEFORE any provider call (cost control):

- **`off`** — never replies, even on `@AI`.
- **`on_mention`** (default) — replies only on a canonical `@AI`.
- **`auto`** — replies on `@AI` OR a detected question/request (no explicit mention).

### Rate limiting

The per-(thread, user) sliding-window cap (`ai-rate-limit.ts`, #485, shared-store
aware via `DISCUSSION_RATE_LIMIT_BACKEND`) is enforced **before** the provider
call. An over-limit Teams message gets **no reply and incurs no LLM cost** — a
chatty channel cannot blow the AI budget beyond the existing cap. `AITokenUsage`
is recorded exactly **once** per reply (by `streamAIReply`, unchanged).

### No token streaming in Teams (final reply only)

Teams has **no SSE surface**, so `maybeRespondAsAI` passes **no `onChunk`
callback** to `streamAIReply` — nothing is streamed to Teams. Only the FINAL
persisted reply is delivered to the channel. The in-app thread still streams
token-by-token over SSE via the REST route, unchanged; the Teams delivery is the
single mirrored final message. (A future enhancement could send a Bot Framework
typing indicator while generating — `botbuilder` v4.23.3 supports a `typing`
activity — but it is intentionally **not** wired here to keep the path minimal.)

### How the reply reaches Teams — exactly once, no double-post

`streamAIReply` persists the reply as `authorKind: "ai"` with the default
`origin: "metis"`; it does **not** itself send to Teams. `maybeRespondAsAI` then
schedules **one** `scheduleMirrorToTeams(threadId, { …, origin: "metis" })` — the
**identical single mirror** the in-app `ai-respond` route schedules. The #550
outbound guard mirrors that `metis`-origin reply out once. The triggering human
message is `origin: "teams"`, so the loop guard skips it. There is no second send
path, so the AI reply is posted to the channel **exactly once**.

### Security

The Teams body is **untrusted**: it flows only into `streamAIReply`'s
injection-isolated message array (a fixed system prompt + the body as a USER turn)
and is never executed. Rate limiting bounds cost abuse. Member/tenant scoping from
#549/#551 already gated ingestion, so **only a mapped, authorized user's `@AI`
reaches the responder** — an unmapped/unauthorized sender produces no human
message and therefore no AI reply. The full OWASP/prompt-injection hardening pass
is **#554** (de-scoped here). Promote-to-requirement is **#553** (see below).

---

## Promote a message to a requirement from Teams (Phase 3 — #553)

`handleTeamsPromoteSubmit(context, { workspaceId })` /
`isPromoteSubmit(activity)` → `server/src/lib/teams/teams-promote.ts`, invoked by
the bot turn logic (`server/src/lib/teams/bot-handler.ts`).

A discussion message mirrored into a linked Teams channel can be promoted to a
tracked `Requirement` **directly from Teams**. The existing promotion logic is
**not reimplemented** — `promoteMessageToRequirement`
(`server/src/lib/discussions/promote.ts`) creates the `Requirement` + initial
`RequirementVersion` (atomically) and writes the `AuditLog` provenance, exactly
as the in-app REST promote does.

### The action: an Adaptive Card `Action.Submit` button (chosen + justified)

Each mirrored message (#550) now renders as an **Adaptive Card** carrying a
**"Promote to requirement"** button (`renderMirroredMessageActivity` in
`server/src/lib/teams/outbound-render.ts`); a `text` fallback keeps non-card
clients readable. Pressing the button delivers a normal Bot Framework `message`
activity whose `value` is the card action's `data` echoed back **verbatim**:

```jsonc
{ "metisAction": "promote", "threadId": "<thread id>", "messageId": "<DiscussionMessage id>" }
```

- **Why `Action.Submit`, not `Action.Execute`.** A submit arrives as a plain
  `message` activity (`activity.value`), which the functional turn handler (#548
  `runFoundationTurn`) **already** processes — no new invoke plumbing. An
  `Action.Execute` instead raises an `adaptiveCard/action` **invoke** activity
  that `botbuilder` v4.23.3 does **not** reliably dispatch unless the turn logic
  subclasses `TeamsActivityHandler` (this bot uses a plain functional callback;
  cf. microsoft/botbuilder-js#4111).
- **No correlation schema needed.** The source `DiscussionMessage.id` + `threadId`
  ride in the submit `data` and Teams returns them untouched on click, so there is
  **no** new `teamsMessageId`/activity-id column, table, or migration. (Verified
  against `botbuilder` v4.23.3 in `server/package.json`.)

`runFoundationTurn` intercepts a promote submit **before** inbound ingestion: it
is an action, not a chat message, and (being text-less) would otherwise be skipped
as `empty-text`.

### Flow on a promote submit

1. **Correlate.** Read `{ threadId, messageId }` from the (untrusted) submit
   `value`. A submit missing either id → graceful error card (`bad-correlation`).
2. **Resolve the acting user.** `resolveUserFromAadObjectId(tenantId, aadObjectId)`
   (#549), tenant-scoped (`channelData.tenant.id`, then `conversation.tenantId`).
   An **unmapped/anonymous** sender → refusal card; **never promote on behalf of
   nobody**.
3. **Authorize.** `canAccessThread` at the **lowest privilege** (`role: "reader"`),
   so access must be earned through real project membership, never a fabricated
   admin role (same posture as #551 inbound). A non-member → refusal card
   (`forbidden`); a missing/soft-deleted thread → `thread-not-found` card.
4. **Verify** the correlated message still exists in the thread (defence in depth
   against a tampered/stale card payload).
5. **Promote** via `promoteMessageToRequirement`, with the **real resolved user**
   as the actor — so the `AuditLog` provenance attributes the promotion to the
   actual Teams user, not the bot. The Requirement title is derived from the
   source message's first non-empty line (clamped to 255, the column limit),
   since the button carries no free-text input.
6. **Respond.** A **confirmation card** (with the new requirement id) on success;
   a **clear refusal/error card** on every failure.

### Security

The submit `value` is **untrusted client input**: `threadId`/`messageId` flow only
into parameterized Prisma lookups and the authorization check — never an
executable sink. Identity is tenant-scoped (#549); authorization is independent of
identity and member-scoped (#477). A `promote.ts` failure (it runs in a
`$transaction`) leaves **no partial `Requirement`**, and its internal detail is
**never** leaked back to the channel (a safe, generic card is sent). The
comprehensive OWASP/prompt-injection hardening pass is **#554**.

---

## ChatOps: `/metis` commands + approval button (#578, epic #63)

`server/src/lib/teams/teams-command.ts`, dispatched by the bot turn logic
(`server/src/lib/teams/bot-handler.ts`) alongside the inbound-ingest (#551) and
promote (#553) branches. Project-health source: `summarizeProjectHealth`
(`server/src/lib/teams/project-health.ts`).

Two **interactive** ChatOps surfaces on the **existing** #547/#548 bot — no
second app or bot registration. (One-way **notification** cards are #67; Slack is
#579; PagerDuty is #580 — all out of scope here.)

### "Slash commands" in Teams — exact invocation syntax

A Teams bot does **not** receive Slack-style slash commands; it receives the
command as the message **text**, usually prefixed with the bot @mention. So a
command is parsed out of the (mention-stripped) message text, reusing the #551
mention-stripping approach (`stripBotMention`). Type, **in a channel where the
METIS bot is installed**:

| To do this | Type | Notes |
|------------|------|-------|
| Show project health | `@METIS /metis status` | Uses the channel's linked project (#549). |
| Show a specific project | `@METIS /metis status <projectId>` | Explicit project ref wins over the link. |
| Start an approval | `@METIS /metis approve <draftId>` | Replies with an **Approve** button. |
| List commands | `@METIS /metis` | Posts a help card. |

In a 1:1 chat with the bot the leading `@METIS` mention is unnecessary; the
`/metis ...` text alone is parsed. Command matching on `/metis` is
case-insensitive. A non-`/metis` message falls through to normal inbound
ingestion (#551) — ChatOps never swallows ordinary chat.

### `/metis status` → project-health card

1. **Pre-flight** (shared by both commands): tenant allowlist (#554) → inbound
   rate limit (#554) → resolve the acting user tenant-scoped (#549) → resolve the
   user's **effective METIS role** from their `UserRole` binding (exactly as login
   does in `auth.ts#ensureUserRow`), defaulting to least-privilege `reader`.
2. **Resolve the project** — an explicit `<projectId>` arg wins; otherwise the
   channel's `TeamsChannelLink` (#549). No link and no arg → a "no project" card.
3. **Authorize** — `actorCanAccessProject` (admins see all; otherwise project
   membership). Identity ≠ authorization. A non-member → "no access" card.
4. **Summarize + reply** — `summarizeProjectHealth` runs a handful of **indexed**
   count queries (`@@index([projectId, status])` on every model) plus two
   "latest run" lookups, so the card is built well within the **<2s** target
   without touching the heavy code-graph overview or FinOps cost subsystems. The
   card shows: project status, requirement count, draft counts
   (pending/approved/published), and the latest analysis + publish-batch status.

**On "ephemeral":** Microsoft Teams has **no** Slack-style channel-ephemeral bot
message — a bot reply in a channel is visible to the channel (confirmed against
the Bot Framework / Teams proactive-messaging docs). The status card is therefore
posted as a normal channel reply. It is safe to do so: the card carries **only**
the requested project's **non-sensitive** health summary (no secrets, no other
project's data), and project access is enforced **before** the card is built.

### `/metis approve <draft>` → Approve `Action.Submit` button

Mirrors the #553 promote-card pattern. `/metis approve <draftId>` runs the
pre-flight + an authorization gate (below), then replies with an **Adaptive Card**
carrying a single **Approve** `Action.Submit` whose `data` is echoed back verbatim
on click:

```jsonc
{ "metisAction": "approve", "draftId": "<IssueDraft id>" }
```

`Action.Submit` (not `Action.Execute`) for the same reason as promote: the submit
arrives as a plain `message` activity the functional turn handler already
processes — no invoke plumbing, no correlation schema (verified against
`botbuilder` v4.23.3). The command **prompt** does **not** approve; approval
happens only on the button press.

**The Approve click** (`handleTeamsApproveSubmit`) **re-runs the full authz chain**
— the click is independent, untrusted client input, so the earlier prompt is
never trusted — then invokes the **existing** publishing-approval service:

```
approveDraft({ draftId, actorId })   →  server/src/lib/publishing/publishing-service.ts
```

This is the **same** service the REST route `POST /api/projects/:projectId/drafts/:id/approve`
calls. It flips the `IssueDraft` to `status="approved"` and writes the
`publish.draft.approve` **`AuditLog`** attributed to `actorId` — the **real
resolved Teams user**, not the bot. METIS approval logic is **not** reimplemented.
A confirmation card is posted on success (target **~1s**); approval is idempotent
for an already-`published` draft.

#### Authorization (reuses the REST path's, do not bypass)

The acting user must satisfy **both**, exactly as the REST path requires:

- **Role permission** — `hasPermission(role, "issue.draft")`, the identical
  permission the REST route enforces via `requirePermission("issue.draft")`. A
  `reader` (or an actor with **no** assigned role) is refused.
- **Project membership** — `actorCanAccessProject` on the **draft's** project.

A **missing** draft and a draft in an **inaccessible** project produce the
**identical** "not found" card, so a caller cannot probe for draft existence
across projects.

### Security

Every ChatOps surface runs the **same** governance + identity + authz chain as the
rest of the bridge, in this order — **before** any data is read or written:

1. **Tenant allowlist** (#554, OWASP A01) — a command/click from a non-allowlisted
   tenant is refused before the sender is even resolved (allow-all by default).
2. **Inbound rate limit** (#554, OWASP A04) — the per-`(workspace, conversation)`
   cap applies to commands too, so an abusive channel cannot flood ChatOps;
   **fails open** on a limiter store error.
3. **Identity** (#549) — the actor is resolved tenant-scoped; an **unmapped**
   sender is refused (never act as nobody).
4. **Authorization** — role permission + project membership (above); identity is
   never authorization.

All Teams input (command text, the `draftId`/`projectId` in the submit value) is
**untrusted**: it flows only into **parameterized** Prisma lookups and the
approval service, never an executable sink. Cards **never** leak the allowlist
contents, a rejected tenant id, a raw internal error, or another project's
existence. An approval-service failure → a safe error card with **no partial
state** (the service writes the audit row only **after** the status update, so a
throw leaves the draft unchanged). Every handler is **non-throwing** — a
card-send failure is logged and swallowed, never surfaced to the channel. **No
schema or migration change** (the project-health summary is read-only counts; the
approval reuses the existing `IssueDraft`/`AuditLog`).

---

## One-way notification cards (#67, epic #63)

One-way **notification** cards push an operational event into a configured Teams
channel. Three events are supported today: **analysis-complete**,
**publish-rolled-back**, and **budget-exceeded**. These are *informational* cards
with **no action buttons** — distinct from the discussion-message mirror cards
(#550/#553) and the interactive `/metis` ChatOps cards (#578). The scope split in
epic #63 holds: **#67 owns one-way notifications, #578 owns interactive ChatOps**;
Slack is #579 and PagerDuty sev-1 alerting is #580 (the publish-rollback PagerDuty
incident is independent of this Teams card).

No second bot/app is registered — notifications reuse the **same** install,
vaulted credentials (#548), proactive-send mechanism (#550), and tenant allowlist
(#554) as the rest of the bridge.

### Notification targets (where each event routes)

A **notification target** is a per-workspace, per-event mapping to a destination
Teams channel `ConversationReference`. Unlike a thread↔channel **link** (#549,
which is keyed to a `DiscussionThread` for bidirectional mirroring), a target
carries **no thread** — it just says "for event X in this workspace, proactively
post the card into THIS channel".

- Model `TeamsNotificationTarget` → table `teams_notification_targets`, unique on
  `(workspaceId, eventType)` (at most one channel per event per workspace).
- `eventType` is free-form (`analysis-complete` | `publish-rolled-back` |
  `budget-exceeded` today); new event kinds need no migration.
- Durable relational data (real model + migration in both the SQLite and
  idempotent-Postgres dirs), like the #548/#549 stores — losing a target silently
  stops delivery until re-registered.

**Admin HTTP surface** (`requireAuth` + `requireWorkspaceRole("admin")`; the
workspace comes from the path, so an admin can only configure their own
workspace's targets):

```
POST   /api/integrations/teams/workspaces/:workspaceId/notification-targets
       { eventType, conversationId, channelId?, tenantId?, reference }
       → 201 { the target summary }            (re-registering an event UPSERTS)
GET    /api/integrations/teams/workspaces/:workspaceId/notification-targets
       → 200 [ target summaries ]
DELETE /api/integrations/teams/workspaces/:workspaceId/notification-targets/:eventType
       → 200 { deleted: true } | 404 NOTIFICATION_TARGET_NOT_FOUND
```

`reference` is the Bot Framework `ConversationReference` for the destination
channel (the same shape the #548 store captures on an inbound activity) — the
operator supplies it from a channel the bot is installed in.

### How a notification fires

The three event sources call a thin, **best-effort** hook
(`server/src/lib/teams/notification-hooks.ts`) at their real emission points:

| Event | Emission point | Workspace derived from |
|-------|----------------|------------------------|
| `analysis-complete` | `markAnalysisCompleted` path in `analysis/orchestrator.ts` | analysis's project → workspace |
| `publish-rolled-back` | the >50%-failure **auto-rollback** path in `publishing/publisher.ts` | batch's project → workspace |
| `budget-exceeded` | FinOps **alert engine** `tickWorkspace`, **after** the durable `AlertEvent` | the workspace itself |

Each hook renders the card (`notification-render.ts`) and schedules a
fire-and-forget proactive send (`notification-sync.ts` `sendEventNotification`),
which resolves the workspace's vaulted creds (#548), builds a `CloudAdapter`, and
calls `continueConversationAsync(botAppId, ref, logic)` against the stored target
reference — the **same** proactive path as #550.

The budget card fires **only after** the `AlertEvent` is persisted, so it inherits
the rule's cooldown idempotency (no duplicate cards within a window). It is an
**additional** card alongside the workspace's configured email/webhook alert
channels (#50), not a replacement.

### Robustness — a notification never breaks the originating operation

`sendEventNotification` is **best-effort and non-throwing**, and the hooks call it
fire-and-forget off the operation's critical path. A send failure, a missing
installation, an expired reference, or an unconfigured target is logged and
swallowed — the analysis run, the publish rollback, and the budget tick all
complete unaffected. When no target is registered for the event, the path no-ops
**before** any credential resolution or network call (zero overhead when unused).

### Security

- **Per-workspace scoping** on every store read/write and on the send path — a
  notification can never be routed into, nor a target read from, another
  workspace's channel.
- **Tenant allowlist** (#554) is applied before every send: a target in a
  non-approved tenant is suppressed.
- **No secret/PII leakage** — cards carry only the originating workspace's own
  event data (project/workspace name, counts, rollback reason, spend vs budget);
  the bot password stays vaulted and is resolved only at send time; nothing is
  logged that identifies a tenant or leaks a reference.
- Untrusted request input (the `reference`, ids) flows only into **parameterized**
  Prisma writes, never an executable sink. Free-text card fields are
  length-clamped so an oversized payload cannot make the send throw.

### Manual verification

Like the rest of the bridge, the live Teams round-trip is a **manual** step (it
needs a real Azure app + tenant + channel) — not a CI job:

1. Install the bot for a workspace (admin install flow above) and add it to a
   channel; capture that channel's `ConversationReference` (it is recorded on the
   first inbound activity in `teams_conversation_references`).
2. `POST .../notification-targets` for, e.g., `budget-exceeded` with that channel's
   conversation id + reference.
3. Trigger the event (complete an analysis, force a >50%-failure publish rollback,
   or cross a budget alert threshold) and confirm the card lands in the channel.

---

## Azure setup (manual — cannot be scripted from inside METIS)

A developer must perform these steps once in Azure to register the bot:

1. **Create an Azure Bot resource** (Azure Portal → *Create a resource* → *Azure
   Bot*). Choose a **Multi-tenant** (or **Single-tenant**) app type.
2. **Capture the Microsoft App ID** (the bot's app/client id) and **create a
   client secret** (*App registration → Certificates & secrets → New client
   secret*). Copy the secret value immediately — it is shown once.
3. **Set the messaging endpoint** to your public METIS host with the workspace
   routing key, e.g.:
   ```
   https://<your-metis-host>/api/integrations/teams/messages?workspaceId=<workspaceId>
   ```
   (Use the value `GET .../manifest` returns as `messagingEndpoint`.)
4. **Enable the Microsoft Teams channel** on the Azure Bot (*Channels → Microsoft
   Teams*).
5. **Install the credentials in METIS** via
   `POST /api/integrations/teams/workspaces/:workspaceId/install` with the app id,
   the client secret, and (for a single-tenant bot) the tenant id.
6. **Build the Teams app package.** `GET .../manifest` returns a `manifest.json`;
   zip it with a `color.png` (192×192) and `outline.png` (32×32) icon and upload
   the `.zip` to Teams (*Apps → Manage your apps → Upload an app*), or publish it
   to your org's app catalog.
7. **Add the bot to a test channel** and send it a message — METIS captures the
   `ConversationReference` for that conversation. If the channel is **linked** to
   a discussion thread (Phase 1) and your Teams account is **mapped** to a METIS
   user (Phase 1 identity), the message is ingested into that thread (Phase 2
   inbound); an unmapped sender receives a one-time hint to link their account.

### Required permissions

The scaffolded manifest requests `identity` and `messageTeamMembers` and declares
the bot in `team`, `groupChat`, and `personal` scopes (so #63/#67 and the bridge
can all reuse one registration). Proactive messaging into channels (later phases)
additionally relies on the conversation having interacted with the bot at least
once (captured `ConversationReference`); Graph-based proactive install is a
later-phase concern.

---

## Manual verification (no CI for the live round-trip)

The end-to-end Teams round-trip needs a real Azure app + tenant, so — like the
SAML/OIDC/LDAP local harnesses (#523/#521/#525) — it is a **documented manual
step**, not a CI job. To verify:

1. Complete the Azure setup above for a test workspace.
2. Add the bot to a Teams test channel and send a message.
3. Confirm a row appears in `teams_conversation_references` for that
   `(workspaceId, conversationId)`.
4. Link the channel to a discussion thread and map your Teams identity (Phase 1),
   then post in the channel — confirm the message appears in the thread in-app in
   realtime as a human message, and that posting in-app mirrors back OUT to the
   channel without looping.

Everything else — inbound JWT accept/reject, install/encrypt/resolve, the
ConversationReference store round-trip across two store instances, and the
migration — is covered by unit tests that run on every PR (no live tenant
required).

---

## Environment

| Variable | Purpose |
|---|---|
| `VAULT_MASTER_KEY` | Required in production; encrypts bot credentials at rest. `openssl rand -base64 32`. |
| `DATABASE_URL` | Selects SQLite vs the shared Postgres (the ConversationReference + installation tables live here). |
| `TEAMS_ALLOWED_TENANTS` | **(#554)** Comma-separated Azure AD tenant id allowlist for inbound bridge traffic. **Unset/blank = allow-all** (any tenant whose activity passes JWT validation). Set it (e.g. `TEAMS_ALLOWED_TENANTS=<tenant-guid>`) to pin a MultiTenant bot to approved tenant(s). Comparison is case-insensitive; a tenant-less sender is rejected when a list is set. |
| `TEAMS_INBOUND_RATE_LIMIT_MAX` | **(#554)** Max inbound activities per `(workspace, conversation)` per window. Default `30`. |
| `TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS` | **(#554)** Inbound rate-limit window in ms. Default `60000` (1 min). |
| `DISCUSSION_RATE_LIMIT_BACKEND` | Selects the rate-limit store backend (`memory` default, `postgres` for a cluster-wide cap). Shared by the inbound bridge cap (#554) and the per-(thread,user) AI cap (#485). |

No `MICROSOFT_APP_*` env vars: bot credentials are **per-workspace** and stored
(encrypted) via the install flow, not via process env.

---

## Security model (Phase 4 — #554)

This section is the consolidated threat model and the operator's security
checklist for the Teams bridge. The bridge surfaces a METIS discussion thread to
an external chat product, so **all Teams-sourced input is untrusted** and is
defended in depth.

### Trust boundary

```
Microsoft Teams (untrusted) ──JWT──▶ POST /api/integrations/teams/messages
                                       │  (1) Bot Framework JWT validation  [#548]
                                       │  (2) tenant allowlist               [#554]
                                       │  (3) inbound rate limit             [#554]
                                       │  (4) channel→thread link            [#549]
                                       │  (5) AAD→METIS identity resolve     [#549]
                                       │  (6) member/tenant authorization    [#477/#551]
                                       ▼
                              DiscussionMessage (origin="teams") ─▶ thread + AI + promote
```

Every numbered gate must pass; failing any one stops the activity with a
structured outcome and **no** message, AI reply, or requirement is created.

### What is validated, and where

| Control | Mechanism | Code | OWASP |
|---|---|---|---|
| **Inbound authenticity** | Bot Framework **JWT** validated by the SDK `CloudAdapter` (`ConfigurationBotFrameworkAuthentication`) — signature (JWKS), expiry, issuer, audience = app id. Unsigned/forged/expired/wrong-audience tokens are rejected **before** turn logic. We never run an auth-disabled adapter (a workspace with no installed credentials returns 403). | `bot-adapter.ts`, `routes/integrations/teams.ts` | A07, A01 |
| **Tenant allowlist** | `TEAMS_ALLOWED_TENANTS` (case-insensitive). Unset = **allow-all** (documented default); set = only listed tenants, and a tenant-less sender is rejected. Enforced on inbound ingest **and** promote. | `tenant-allowlist.ts`, `inbound-sync.ts`, `teams-promote.ts` | A01 |
| **Inbound rate limit** | Per-`(workspace, conversation)` sliding window (default 30/min) reusing the shared `RateLimitStore` seam — cluster-wide with `DISCUSSION_RATE_LIMIT_BACKEND=postgres`. Fails **open** (logs) if the store errors, so a limiter outage never blocks legitimate traffic. | `inbound-rate-limit.ts` | A04 |
| **AI cost cap** | Per-`(thread, user)` AI-invocation cap, enforced **before** any provider call. | `ai-rate-limit.ts` (#485) | A04 |
| **Identity (no cross-tenant leak)** | Binding key is `(tenantId, aadObjectId)`; a non-empty `tenantId` is **required**; an unbound or foreign-tenant sender resolves to `null` and is never silently attributed. | `aad-identity-resolver.ts` | A01 |
| **Authorization (member-only)** | Identity ≠ authorization. The resolved user is authorized via `canAccessThread` at the **lowest** privilege (`role: "reader"`), so access must be earned through real project membership — never a fabricated admin role. Enforced on bot ingest, promote, and the REST link/identity routes. | `inbound-sync.ts`, `teams-promote.ts`, `access.ts` | A01 |
| **Prompt-injection isolation** | Untrusted Teams text flows ONLY into `streamAIReply`'s injection-isolated array (fixed system prompt + body as a **user** turn). There is **no tool/function execution** on this path, so injected "instructions" cannot escalate, call tools, or run shell. | `ai-participant.ts`, `ai-responder.ts` | A03/LLM01 |
| **Secret storage** | The Microsoft App Password is encrypted in the vault (AES-256-GCM); only a `${vault:label}` reference is stored on the installation row. Plaintext never touches the table, logs, or API responses, and is redacted from every summary. | `installation-store.ts`, `vault-service.ts` | A02 |
| **No data/error leakage** | Bot turn errors, promote failures, and the unmapped-sender hint emit only **generic, user-safe** strings to the channel; internal detail (stack, SDK auth reason, allowlist contents, the rejected tenant id) is logged but never sent. The route's 401 body never echoes the SDK auth-failure message. | `bot-adapter.ts onTurnError`, `teams-promote.ts`, `tenant-allowlist.ts` | A09 |

### Authorization is enforced on EVERY entry point

- **Bot message ingest** — link + identity + `canAccessThread` (reader). Unmapped → skipped (one-time hint); unauthorized → `forbidden`.
- **`@AI` in Teams** — only runs inside ingestion, so it inherits all the gates above; the gate + AI rate-limit run before any provider call.
- **Promote from Teams** (Adaptive Card) — tenant allowlist + identity + `canAccessThread` (reader) + message-exists check, then the atomic `promote.ts` `$transaction`.
- **REST link/identity admin routes** — `requireAuth` + member-only (`canAccessThread`) for links; `requireAuth` + `requireWorkspaceRole("admin")` for installs and identity bindings. The link's workspace is derived from the thread's project (never trusted from the body), so a caller cannot link a thread into a workspace they don't belong to.

An **unmapped or unauthorized** Teams user can never create a message, trigger the
AI, or promote a requirement.

### Operator responsibilities

1. **Set `TEAMS_ALLOWED_TENANTS`** for a MultiTenant bot you want pinned to specific
   tenant(s). The default is allow-all (so a deliberately-broad install keeps
   working) — if you only intend to serve your own tenant, **set it explicitly**.
   A SingleTenant Azure bot is already tenant-pinned by Azure; the allowlist is
   defence in depth on top of that.
2. **Set `DISCUSSION_RATE_LIMIT_BACKEND=postgres`** in a multi-replica deployment
   so both the inbound bridge cap and the AI cap hold cluster-wide (the default
   `memory` backend is per-process).
3. **Provision `VAULT_MASTER_KEY`** in production so bot secrets are encrypted at
   rest.
4. **Map Teams users** (SSO email match or explicit admin link) before they expect
   to participate — unmapped senders are rejected with a hint, never attributed.
5. **Tune the inbound cap** (`TEAMS_INBOUND_RATE_LIMIT_*`) to your channel volume;
   the default of 30/min/conversation suits typical discussion traffic.

### Residual risks (accepted)

- With `DISCUSSION_RATE_LIMIT_BACKEND=memory`, both caps are per-process, so the
  effective ceiling scales with replica count (same accepted residual as the in-app
  limiters — set `postgres` to remove it).
- The live end-to-end JWT round-trip needs a real Azure tenant and is a documented
  manual step; the **accept/reject contract** (valid → 200, unsigned/forged/
  expired/wrong-audience → 401, no-creds → 403) is covered by unit tests on every PR.
