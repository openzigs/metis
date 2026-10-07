---
issue: 818
section: Removed
---

- The Test Coverage page and test-management (Xray, Zephyr, TestRail)
  connections are removed. Requirement-to-test links now appear as **Tested by**
  in traceability. Existing test-coverage and test-management data stays for one
  release and is removed in a later one; `/projects/:id/test-coverage` now shows
  the standard not-found page.
