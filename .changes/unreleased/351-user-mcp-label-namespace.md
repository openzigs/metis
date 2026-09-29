---
issue: 351
section: Security
---

- A personal (`user`-scope) MCP server's label is now unique only among its owner's servers. Creating one with a label another user already holds succeeds instead of answering 409 `LABEL_TAKEN`, which confirmed that the other user's server existed. Re-using your own label is still refused.
- A personal MCP server's tools are named `mcp:u.<ownerId>.<label-slug>:<tool>` (the label lowercased and slugged, so `My Server` becomes `my-server`), so they can never collide with another user's tools or with a global or project server's `mcp:<label>:<tool>`. Before this, the second same-named server's tools failed to register, and a user server could take a global server's tool name. Operator note: approval rules written against a personal server's old `mcp:<label>:…` names must use the new form.
