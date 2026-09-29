---
issue: 372
section: Fixed
---

- Code symbol search now searches every symbol in a project. Keyword matching
  previously looked only at the first 5,000 symbols, chosen effectively at
  random, so on larger codebases an exact name such as `parseToolCall` could
  fail to find its own symbol and whole directories were never matched. The
  symbol set and its search index are now cached per project and rebuilt only
  when the code graph changes.
