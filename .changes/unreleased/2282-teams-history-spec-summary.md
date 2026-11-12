---
issue: 2282
section: Fixed
---

- An `@AI` question asked in a linked Teams channel is answered only from the thread's messages
  since the channel was linked, so it no longer draws on in-app messages the channel never saw.
  If the thread's history cannot be read, the AI still answers, without it, where it used to
  give no reply. For a discussion about a Spec Kit feature whose `spec.md` has nothing under its
  `# Spec` heading, the AI is told so instead of being told no spec was written, and a `#` line
  inside a code block no longer cuts the spec summary short.
