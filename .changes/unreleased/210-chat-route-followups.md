---
issue: 210
section: Fixed
---

- Streamed chat is gated by the project token budget (402 when spent) and
  records its usage where the budget reads it; the semantic cache now finds
  answers when the provider reports a different model id than was requested
  (#211); the chat page reads only new transcript rows after each turn, the
  transcript read is paged with a server maximum, and fork copies rows in one
  batch (#212); a chat prompt must leave room for the reply —
  `CHAT_ANSWER_RESERVE_PERCENT`, default 10% of the window (#213).
