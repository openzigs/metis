---
issue: 1781
section: Fixed
---

- The AI edit-candidate check (`IMPACT_LLM_EDIT_VERIFY`, off by default) no longer accepts a
  suggested line just because the file's whole-file module symbol spans it: the line must fall
  inside a named function or type. A suggested line must be a whole number, a file a stored
  requirement link already lists is no longer "added" again, and the run summary no longer says
  every dropped suggestion named a bad line.
