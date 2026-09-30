---
name: tests-can-lock-in-bugs
description: An existing test can assert the buggy behaviour as expected
metadata:
  type: project
---

generated-doc-outbox.test asserted INDEXING_FAILED for a cancelled task (#483), so the fix turned it red and read as a regression.

**Why:** A red existing test after a mapping change may be the bug's own pin, not a regression.

**How to apply:** When changing a status or error mapping, grep the tests for the old constant asserted against the case you are changing, and fix the assertion with a comment citing the issue.
