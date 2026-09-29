---
name: object-acl-side-channels
description: Owner-scoping an object on its REST routes misses the side channels. For MCP: tool registry listing, Socket.IO broadcast rooms, refusal text, save-time validators and 409 label uniqueness.
metadata:
  type: project
---

Making an object owner-only on its by-id and list routes is not enough. On PR #349 (#340, user-scope MCP servers), the adversarial panel found four more places that still disclosed another user's server, each outside `routes/mcp.ts`:
- the global `ToolRegistry` listing (`GET /api/ai/tools`);
- the shared `mcp:status` Socket.IO room, gated by role and not by object;
- refusal text that confirmed the object exists ("belongs to another user");
- a global label-uniqueness 409 (#351, left open).

**Why:** a registry, a broadcast room or a uniqueness index is keyed per process or per table, not per owner. So it still discloses the object after every route check passes.

**How to apply:** when you scope an object to a user or project, grep for every consumer of its identifier and label: registries, `io.to(` emits, error strings and unique constraints. Give each one the same filter, or file an issue for it. Project-scope `mcp:status` events were fixed in #353 (PR #356): they go to per-workspace rooms. Links: [[change-analysis-cross-project-idor]].
