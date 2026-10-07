---
issue: 775
section: Fixed
---

- An @AI reply in a discussion now respects the project's monthly token budget, as chat does. Once
  the project is over budget, the reply is refused with a "budget exceeded" error (HTTP 402) and no
  model call is made. This also applies to @AI replies started from a linked Teams channel.
