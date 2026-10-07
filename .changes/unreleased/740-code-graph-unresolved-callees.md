---
issue: 740
section: Fixed
---

- Asking the code-graph search what a function calls no longer fails when that function calls
  something outside the indexed code, such as the standard library or a third-party package. It
  now returns the callees it found and says how many other calls go to external or unresolved
  symbols, naming them, instead of failing the tool or reporting that the function calls nothing.
