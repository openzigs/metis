---
issue: 2314
section: Security
---

- An analysis's code agent no longer reads a repository file any document access restriction
  covers, whoever started the run: its `read_file_slice` refuses it as if it were missing,
  `list_files` and the code search tools leave it out, and so does its code-symbol context.
  Findings are read by the whole project, so an analysis reads as a shared audience.
- Spec Kit's code-symbol context leaves such files out too, and chat's code-symbol context shows
  only the files the reader may see.
- A change to a user's role now reaches chat's code and knowledge search on their next turn, not
  after the 30-minute result cache expired.
- Not yet covered: document search inside an analysis and Spec Kit, and Spec Kit's caller and
  plan-location lookups, still see restricted repository text (#2431).
