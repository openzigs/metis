---
issue: 403
section: Fixed
---

- A malformed clarification request (for example `{ "requirements": {} }`, or a
  requirement entry that is `null`) is now rejected with a 400 validation error
  instead of failing with a 500.
- The clarifying-questions preview and the approvals panel no longer fail to
  render for requirements stored before ambiguities were extracted; such a
  requirement is shown with no open questions.
