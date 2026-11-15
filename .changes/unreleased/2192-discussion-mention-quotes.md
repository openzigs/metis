---
issue: 2192
section: Fixed
---

- A discussion @mention notification keeps quoting what the message says. A mention added by
  editing a message quotes the whole message, not just `@name`; editing the message re-quotes the
  notifications already sent (or says "The message was edited." to anyone who can no longer open
  the project); and deleting it replaces the quote with "The message was deleted.", as requirement
  comments already did.
- A requirement comment edited moments after it was posted no longer notifies a newly mentioned
  user twice.
- On a review with several reviewers, the final "Review approved" notification now reads
  `"X" was approved: Bob gave the last approval` instead of crediting the last approver alone.
