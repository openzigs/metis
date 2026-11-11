---
issue: 2226
section: Fixed
---

- The AI in a discussion now reads the most recent 20 messages of a long thread, so it sees the
  answer you just gave to its own question instead of the first 20 messages. In a thread attached
  to a requirement it also reads that requirement's current title, body and acceptance criteria,
  and in a thread attached to an analysis, the analysis status and its requirements' titles. This
  applies to replies in METIS and to `@AI` replies from a linked Teams channel.
