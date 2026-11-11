---
issue: 2240
section: Changed
---

- Chat follow-ups now search with the conversation. Answering the model's question ("Which product
  do you mean?" — "Server") or asking a short follow-up searches your message together with the
  question before it, and your own words are still searched on their own. A question with several
  parts searches each part and merges the results.
- The excerpts an answer cited stay available on your next message, marked as cited in the
  previous answer. They are read again for you, so an excerpt you can no longer see, or whose
  document was deleted, is not brought back.
- Documents attached in the Workbench now limit the search to those documents. Before, their file
  names were pasted above the question and searched for as words.
- A follow-up or multi-part question runs up to five searches instead of one, and each search
  embeds its query, so a hosted embedding provider bills up to five embedding calls for that turn.
  Chat itself uses no extra model tokens.
