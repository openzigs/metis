---
name: teams-msi-auth-and-proactive-sends
description: botbuilder auth-type traps, checking its chosen credential path offline, why managed identity needs an operator allowlist, and why only proactive Teams sends need the serviceUrl host check (#1468 and its two reviews).
metadata:
  type: project
---

From #1466 / PR #1468 and its two review rounds (2026-10-24).

**botbuilder fails open on the app type.** botbuilder-core 4.23.3's
`ConfigurationServiceClientCredentialFactory` treats any unrecognised `MicrosoftAppType` as
MultiTenant, silently. `UserAssignedMsi` needs a tenant id and NO password. Validate the type
before passing it (`normalizeTeamsAppType`, `server/src/lib/teams/installation-store.ts`).

**Check the chosen path offline.** `buildCredentialsFactory(creds).createCredentials(appId,
audience, loginEndpoint, true)` and test `instanceof ManagedIdentityAppCredentials` /
`MicrosoftAppCredentials`. Load the classes with
`createRequire(require.resolve("botbuilder"))("botframework-connector")` so they are the copy
botbuilder uses.

**No-proof credentials need an operator gate.** A credential type that needs no proof of
possession (managed/workload identity, ambient host credentials) turns "a workspace admin
configures an integration" into "a workspace admin uses any identity on the host". Require an
operator allowlist or a system-admin gate plus cross-workspace uniqueness, especially where
admin-supplied `serviceUrl`s receive bearer tokens. Here MSI ownership comes only from
`TEAMS_MSI_CLIENT_IDS` (optionally bound per workspace), checked at install and on every
resolve.

**serviceUrl.** A notification target's `ConversationReference` is admin-supplied, and
`continueConversationAsync` POSTs a bot bearer token to its `serviceUrl`. Gate every
proactive send through `server/src/lib/teams/service-url.ts`. Inbound `sendActivity` replies
run on a JWT-verified turn and do not need it. Probe host checks with WHATWG URL edge cases:
backslash, `%2E`, fullwidth dots, trailing dot, `:443` ([[same-origin-href-check]]).

**Review heuristics.**
- When a PR maps a legacy stored enum on read, check what the old write path required: the
  affected population is usually every legacy row, not just the named edge case.
- When a summary reports one reason out of several, check the banner copy against the
  dominant upgrade path (allowlist unset, legacy password row), not just the enum. A blocking
  reason ranked first hid the legacy diagnosis.

Related: [[chatops-workspace-scoping]], [[secret-binding-fire-time-checks]].
