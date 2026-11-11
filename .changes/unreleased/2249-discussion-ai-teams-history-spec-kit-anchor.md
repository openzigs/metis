---
issue: 2249
section: Fixed
---

- An `@AI` reply from a linked Teams channel now reads the thread's recent messages, as a reply in
  METIS does, so it sees the answer you just gave to its question.
- The AI in a discussion now reads only the messages posted before the one it is answering. A
  message posted after it, such as a colleague's reply or a second `@AI`, is no longer read as
  part of the question.
- A discussion attached to a Spec Kit feature now gives the AI that feature's name, status and the
  summary at the top of its `spec.md`. A thread attached to more than one item (for example a
  requirement and a Spec Kit feature) gives the AI every one that still exists, not just the first.
