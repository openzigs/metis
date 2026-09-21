# Slack app (Bolt SDK) — ChatOps + interactive approvals

Issue #579 (epic #63). METIS ships a Slack app built on the **Slack Bolt SDK**
(`@slack/bolt@4.7.3`) that mounts on the existing Express server, supports a
per-workspace OAuth install with a **vault-encrypted** bot token, answers the
`/metis status` and `/metis approve` slash commands, and approves publishing
drafts from an interactive **Approve** button — calling the **same** approval
service the REST path and Teams ChatOps (#578) use.

This is a fully greenfield integration (Slack shares no code with the Teams
bridge) but it deliberately reuses METIS's established patterns: the AES-256-GCM
vault for credentials (#548), the SSO email-match identity linkage (#549), and
the `approveDraft({draftId, actorId})` + RBAC authz shape (#578).

---

## Architecture

```
Slack  ──signed request──▶  ExpressReceiver (raw-body HMAC verify)
                              │  mounted at /api/integrations/slack/events
                              │  BEFORE express.json() so it owns the raw body
                              ▼
                     Bolt App listeners
                       ├─ command("/metis")  ─▶ handleSlackCommand(...)
                       └─ action("metis_approve_draft") ─▶ handleSlackApproveAction(...)
                              │
                              ▼  (pure, dependency-injected, fully unit-tested)
        ┌──────────────────────────────────────────────────────────┐
        │ SlackIdentityResolver  → (slackTeamId, slackUserId)→User   │ #549 reuse
        │ summarizeProjectHealth → /metis status                     │ #578 reuse
        │ approveDraft           → Approve button + /metis approve    │ #578 reuse
        │ SlackInstallationStore → per-workspace bot token (vault)    │ #548 reuse
        └──────────────────────────────────────────────────────────┘
```

| Concern | Module |
|---|---|
| Bolt receiver wiring (SDK adapter) | `server/src/lib/slack/slack-receiver.ts` |
| Signature + replay verification | `server/src/lib/slack/signature.ts` |
| OAuth v2 install flow | `server/src/lib/slack/oauth.ts` |
| Per-workspace bot token store (vault) | `server/src/lib/slack/installation-store.ts` |
| Slack→METIS identity resolver | `server/src/lib/slack/slack-identity-resolver.ts` |
| Command handlers (status/approve/action) | `server/src/lib/slack/slack-command.ts` |
| Block Kit message builders | `server/src/lib/slack/block-kit.ts` |
| App config (env, fail-closed switch) | `server/src/lib/slack/config.ts` |
| Admin + OAuth callback routes | `server/src/routes/integrations/slack.ts` |

The Bolt receiver is mounted in `server/src/app.ts` **ahead of** the global
`express.json()` body parser so Bolt reads the raw request body Slack signed.

---

## Environment configuration

| Variable | Required | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Yes (to enable Slack at all) | Verifies every inbound request signature. Without it the receiver is **not mounted** (fail closed). |
| `SLACK_CLIENT_ID` | For OAuth install | Slack app client id. |
| `SLACK_CLIENT_SECRET` | For OAuth install | Slack app client secret (used only in the token exchange). |
| `SLACK_STATE_SECRET` | For OAuth install | Signs the OAuth `state` (CSRF / install-fixation protection). |
| `SLACK_SCOPES` | No | Comma-separated bot scopes. Default: `commands,chat:write,users:read,users:read.email`. |
| `VAULT_MASTER_KEY` | Yes (production) | Master key the bot token is encrypted under (shared METIS vault). |

The `users:read.email` scope lets the install flow read the bot user's email for
the SSO identity binding. Without OAuth env vars you can still verify requests
and install a token directly via the admin API (`POST .../install`).

---

## Slack app manifest

Create a Slack app (https://api.slack.com/apps) and apply this manifest, replacing
`https://metis.example.com` with your deployment's public base URL:

```yaml
display_information:
  name: METIS
features:
  bot_user:
    display_name: metis
    always_online: true
  slash_commands:
    - command: /metis
      url: https://metis.example.com/api/integrations/slack/events
      description: METIS ChatOps (status, approve)
      usage_hint: "status | approve <draftId>"
      should_escape: false
oauth_config:
  redirect_urls:
    - https://metis.example.com/api/integrations/slack/oauth/callback
  scopes:
    bot:
      - commands
      - chat:write
      - users:read
      - users:read.email
settings:
  interactivity:
    is_enabled: true
    request_url: https://metis.example.com/api/integrations/slack/events
  org_deploy_enabled: false
  socket_mode_enabled: false
```

Both the slash-command **and** interactivity request URLs point at the single
receiver endpoint `…/api/integrations/slack/events`.

---

## Install (OAuth)

1. A workspace **admin** calls `GET /api/integrations/slack/workspaces/:workspaceId/authorize`
   (METIS-authenticated). It returns `{ url }` — the Slack authorize URL with a
   signed `state`.
2. The admin opens the URL and authorizes the app in Slack.
3. Slack redirects to `GET /api/integrations/slack/oauth/callback?code=…&state=…`.
   METIS verifies the `state` (rejects forged/expired), exchanges the `code` for a
   bot token via `oauth.v2.access`, and stores it **encrypted** in the vault. Only
   the `${vault:label}` reference is persisted on the `slack_app_installations` row.

### Direct (non-OAuth) install

For single-tenant deployments that provision the token out-of-band:

```
POST /api/integrations/slack/workspaces/:workspaceId/install
{ "slackTeamId": "T0123", "botToken": "xoxb-…", "slackTeamName": "Acme" }
```

The token is encrypted on the way in and never returned. Both paths are behind
`requireAuth` + `requireWorkspaceRole("admin")`.

---

## Identity linking

Slack interactions carry a `team.id` + `user.id` but not reliably an email. METIS
binds a Slack user to a METIS user through the **same email key SSO uses**: when a
binding is established (via the install/admin flow), the Slack user's email is
matched (case-insensitively) against `User.email`. An unmapped Slack user is
**refused** — never silently attributed. Bindings are team-scoped, so a user id
from another team can never resolve to a local user.

---

## Commands

### `/metis status [<projectId>]`

Returns an **ephemeral** Block Kit message (only the invoker sees it) with the
project's health: status, requirement count, draft counts
(pending/approved/published), and the latest analysis + publish status. If no
project id is given and the install has no default project, it asks for one.
Requires the resolved user to have **project access**.

### `/metis approve <draftId>`

Returns an ephemeral prompt with an **Approve** button. Requires the resolved user
to carry the `issue.draft` role permission **and** have access to the draft's
project. A missing or inaccessible draft yields the identical "not found" refusal
(no cross-project probing).

### Approve button

Clicking **Approve** re-runs the **full** authorization chain (the click is
independent, untrusted input) and invokes the existing `approveDraft` service,
which flips the `IssueDraft` to `approved` and writes the `publish.draft.approve`
`AuditLog` attributed to the **real resolved Slack user** (not the bot). A
confirmation is posted in-channel. An approval-service failure produces a safe
error message with no partial state and no leaked internal detail.

---

## FinOps budget alerts (#51)

Beyond the interactive `/metis` ChatOps, the Slack install is reused as an
**outbound** FinOps alert channel. When a workspace configures a FinOps alert
channel of type `slack`, the budget alert engine posts a Block Kit card to the
configured Slack channel each time an alert rule trips:

- **Channel type:** add an alert channel with `type: "slack"` and set the target
  Slack channel id in `target` (or `config.channel`). Configure this alongside the
  existing `email` / `webhook` channels — a rule can route to one or more.
- **Per-workspace token:** the card is posted with the workspace's own bot token,
  resolved from the same vault-backed install store (`resolveBotToken`) — a
  workspace's budget alert can only ever post with its own Slack credentials.
- **No second app:** it reuses the #579 `@slack/web-api` client + the shared Block
  Kit builders. The card shows the workspace, rule, utilisation %, spend, and
  budget.
- **Best-effort:** a missing install / Slack API error is a logged no-op — it never
  breaks the other channels or the alert-engine tick.

---

## Security

- **Signature + replay:** every inbound request (commands, interactions, events)
  is HMAC-verified against `SLACK_SIGNING_SECRET` with a constant-time compare and
  a 5-minute replay window. The receiver is never mounted without the secret.
- **Token at rest:** the bot token is AES-256-GCM-encrypted in the vault; only a
  `${vault:label}` reference is stored. It is never logged or returned.
- **Per-workspace / per-team isolation:** every store read/write and the
  interaction path are scoped, so one workspace's Slack credentials and data are
  never visible to another.
- **Identity ≠ authorization:** approval requires both the `issue.draft`
  permission and project membership. Unmapped/unauthorized users are refused.
- **Untrusted input:** all Slack input flows only into parameterized Prisma
  lookups / the approval service, never an executable sink. OWASP-clean.

---

## Local / manual verification

The live Slack round-trip requires a real Slack app + a publicly reachable URL
(e.g. an `ngrok` tunnel to your dev server) and is a **manual** step — there is no
CI job for it (mirrors the Teams #548–#578 phases). The full security + business
logic is covered by unit + route tests (`server/src/lib/slack/*.test.ts`,
`server/src/routes/integrations/slack.test.ts`).
