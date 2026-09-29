---
issue: 145
section: Fixed
---

- Custom agents can be edited: the project's **Custom agents** card has an
  **Edit** button for its own agents, covering the whole definition (persona,
  tools, skills, model, reasoning effort, approval). Each save raises the version.
- Agent files from older METIS versions import again. Tool names this server
  does not have (such as the old wizard's `knowledge_search`) are left out and
  listed under `meta.droppedTools`; they never gave the agent anything.
