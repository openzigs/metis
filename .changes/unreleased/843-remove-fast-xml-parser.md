---
issue: 843
section: Removed
---

- The server no longer depends on `fast-xml-parser`. Nothing has imported it since the JUnit and
  test-coverage importers were removed, so it no longer appears in dependency audits.
