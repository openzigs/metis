---
issue: 2240
section: Changed
---

- Chat follow-ups now search with the conversation: your message is searched on its own and
  together with the question before it, and each part of a multi-part question is searched.
  A follow-up or multi-part question runs up to five searches, so a hosted embedding provider
  bills up to five embedding calls for that turn; chat itself uses no extra model tokens.
- The excerpts an answer cited stay available on your next message, marked as cited in the
  previous answer, unless you can no longer see them or the document was deleted.
- Documents attached in the Workbench now limit the search to those documents.
