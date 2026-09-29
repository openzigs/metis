---
issue: 31
section: Changed
---

- Settings and Admin are one area. Workspaces, SSO & authentication and Embeddings are now sections of Settings, listed under "Administration" and shown only to system admins; anyone else who opens one sees a notice instead.
- Skills and agents each have one page, in the Library. Their tabs have a scope: the workspace library, where skills and agents are written and versioned, or one project, where you choose what that project may use and edit its own custom agents. Project Settings links there instead of hosting its own Custom agents card.
- MCP servers have one page, Settings → MCP servers. Its new Servers tab registers, starts and stops servers and filters them by scope: mine, project or workspace.
- Usage and cost have one page, Settings → Usage & cost, with a Project, Workspace (budgets, alerts and chargeback, formerly FinOps) or All projects (admins only) scope.
- Every old address redirects to its new home, so bookmarks and shared links still work: `/admin/...`, `/skills`, `/agents`, `/settings/agents`, `/projects/<id>/usage` and `/workspaces/<id>/finops`.
- The standalone Custom agents settings page is gone. It listed only built-in agents and could not show agents created from it; project custom agents are on Library → Agents with the project as the scope.
