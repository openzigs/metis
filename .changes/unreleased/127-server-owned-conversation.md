---
issue: 127
section: Security
---

- Chat history is kept on the server: chat routes take only the new message and
  refuse client-sent assistant, system or tool messages (`CLIENT_HISTORY_REJECTED`).
- Reading, resuming or forking a chat requires owning it and its project access.
- Long chats are summarised near the model's context window instead of dropping
  old turns; summarised messages stay visible. Replies record reported usage,
  and each summary's model usage counts toward cost tracking and the project
  budget (`/compact` is refused once the budget is spent). A summary cut short
  by its length limit is labelled.
- Resume from the server's record, and "Fork from here" on any answer.
