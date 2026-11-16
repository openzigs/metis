---
name: new-optional-field-check-every-caller
description: Threading a new optional field through a shared function (streamAIReply) can miss a caller silently; the Teams ai-participant passes its own projectRetriever.
metadata:
  type: project
---

When a PR threads a new field through a shared function such as `streamAIReply`, check every caller, not only the route that motivated it (#2516 review). The Teams ai-participant calls it with `projectRetriever`, not the chat route's retriever, and was missed.

**Why:** an optional field type-checks at every call site that omits it, so the compiler never points at the missed caller and its behaviour silently stays old.

**How to apply:** grep every call of the shared function across `server/src` (including `lib/teams/` and MCP paths) and list each in the PR body with whether it passes the new field. Consider making the field required for one commit to let `tsc` enumerate the callers.
