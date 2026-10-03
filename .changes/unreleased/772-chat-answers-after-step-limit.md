---
issue: 772
section: Fixed
---

- A chat question that uses up its tool steps now still gets an answer. Chat makes one last call
  with tools turned off, so the model answers from the code it has already read and says what it
  could not check, in place of the "reached the tool-call limit" message. That call is streamed
  and metered like the rest of the turn.
- Chat now runs a tool when the model types `_` where the name has `-`, or the reverse. For
  example, `search_knowledge` runs `search-knowledge`. Before, this used up a step on an
  "Unknown tool" error.
