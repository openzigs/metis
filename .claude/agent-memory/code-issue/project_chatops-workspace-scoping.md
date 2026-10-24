---
name: chatops-workspace-scoping
description: Teams/Slack ChatOps handlers must scope every target to the bot's workspace — identity resolvers, card/action ids, where to sweep for handlers, and the test fakes that break when a handler gains a lookup (#1439, #1443).
metadata:
  type: project
---

Collected from #1439 and #1443 and their reviews (2026-10-23). #1431 and #1432 are closed.

**Identity is per workspace.** `TeamsUserIdentity` / `SlackUserIdentity` are unique on
`(workspaceId, …)` since #1431. `resolveUserFromAadObjectId` / `resolveUserFromSlackId`
require `workspaceId` and refuse non-members, so any new ChatOps surface must pass the bot's
workspace.

**Ids from the client are untrusted.** Teams promote/approve card `value` ids (`threadId`,
`draftId`) and Slack `action.value` are client-controlled. A new ChatOps action must scope its
target to the bot's workspace itself (`server/src/lib/workspaces/chatops-project-scope.ts`),
not rely on a channel link.

**Where to sweep.** The reliable list of ChatOps targets is the dispatch table in
`teams/bot-handler.ts#runFoundationTurn` plus the `bolt.command` / `bolt.action`
registrations in `slack/slack-receiver.ts`.

**Lowercasing for a match.** When an identifier is lowercased for case-insensitive lookup, a
"prefer the exact match" step must compare against the ORIGINAL input, or it quietly prefers
the record stored in lowercase. Tests sending only lowercase input pass either way (#1439
review).

**Eligibility must match the picker.** An assignee/recipient rule must use the same audience
as the picker (`routes/users.ts` `mentionAudienceWhere`, which includes system admins;
`lib/requirements/assignee-eligibility.ts`), or the UI offers users the API then 404s.

**Test fallout.**
- A DB lookup added to a ChatOps handler breaks its unit-test fake (the fake db exposes only
  the models it uses). Add `project.findFirst` / `discussionThread.findFirst` to the
  teams-command, teams-promote, inbound-sync and slack-command fakes.
- `sla-checker` persists the coordinator notification only when a socket server exists;
  real-DB SLA tests need a stubbed `getSocketServer`.

Related: [[teams-msi-auth-and-proactive-sends]], [[sso-login-identity-matching]],
[[membership-access-widening-checklist]].
