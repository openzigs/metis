---
issue: 129
section: Added
---

- Library agents and project custom agents now share one definition: persona, skills, tool list, preferred model, reasoning effort, an approval override that can only ask for approval more often, and a version. Existing agents keep everything they had.
- Chats list each available skill by name and description only; the AI opens a skill with `load_skill` when it needs it (with `CHAT_PROGRESSIVE_SKILLS`, on by default). Skills a project has switched off are neither listed nor loadable.
- Skills import in the open Agent Skills `SKILL.md` format, including a skill folder's supporting files; malformed frontmatter and unsafe files are refused with the reason.
- In a project chat the agent can hand a task to another agent the project may use (with `CHAT_SUBAGENTS`, on by default). The other agent works with only its own tools, every tool it calls asks you for approval as the chat would, and its transcript opens from the hand-off. `SUBAGENT_MAX_DEPTH`, `SUBAGENT_TOKEN_BUDGET` and `SUBAGENT_MAX_TURNS` bound it.
- The custom-agent wizard lists the tools the server really has (it used to list names no tool carried), and sets an agent's skills and approval override.
- Agent and skill text containing an API key, token or private key is refused.
