---
issue: 130
section: Removed
---

- **Breaking:** GitHub Copilot support is removed — the `copilot-native` provider, the `copilot-svc` sidecar (Compose service, Helm values, `metis-copilot-svc` image) and the `@github/copilot*` dependencies. `AI_PROVIDER=copilot-native` now refuses to start, naming the supported providers; a runtime-config or project override selecting it refuses AI calls by name, never falling back to another provider. See `docs/MIGRATING_FROM_COPILOT.md`.
- **Breaking:** the `openai` / `azure` providers no longer read the `COPILOT_PROVIDER_*` / `COPILOT_MODEL` fallbacks; a set one without its replacement stops startup with the rename to make (`OPENAI_*`, `AZURE_OPENAI_*`, `AI_MODEL`).
- Chats created on Copilot stay readable but are read-only, with a notice on the chat page. Morph `apply_diff` now calls the Morph API from the server (`MORPH_API_KEY`); the unregistered sidecar-only `code_exec` tool is gone. The `ai_sessions.copilotHome` column is dropped.
