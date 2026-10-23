---
issue: 1446
section: Fixed
---

- The deleted-project chat e2e test no longer fails about one run in ten: its timestamped message no longer looks like a card number to the chat guardrail, which masked it before the browser could find it.
