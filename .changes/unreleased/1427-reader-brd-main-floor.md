---
issue: 1427
section: Fixed
---

- The main part of a reader-layout Business Requirements document is no longer
  asked for less than its 40,000-character floor. For DeepSeek its sections
  were asked for about 32,000 characters together, so the main part reached
  the floor only when the model wrote well past what it was asked, and one run
  came out at 35,996. They are now asked for about 40,000; anything written past
  60,000 is still trimmed when the document is assembled.
