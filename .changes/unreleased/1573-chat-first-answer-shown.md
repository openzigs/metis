---
issue: 1573
section: Fixed
---

- The first answer in a new chat now appears without a reload when the agent you
  had picked earlier is not available in the project. Switching to the default
  agent cut the answer's live stream off, so the question looked unanswered even
  though METIS had answered it.
- If an answer's live stream is cut off for any other reason than pressing Stop,
  the chat keeps your question on screen and shows the answer as soon as METIS
  has finished it.
