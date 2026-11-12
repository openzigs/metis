---
issue: 2198
section: Changed
---

- Chat is told to check a claim before making it. It looks up a function's callers before saying it has none, and says when it could not look. It reads other code before saying that code has the same bug. It checks later migrations before saying a table, column or status is still used. It cites the lines that hold the claim, not the file's header, and names a requirement by its title instead of its id. These rules come from walkthrough run 10's wrong answers, and are not measured yet.
- The code agent of Requirements Analysis is told to cite code for what it does, not because its name shares a word with the requirement. A requirement to record when an article was read should no longer be grounded in the code that estimates reading time, which is how its Tested by list picked up that code's tests in run 10.
- The business-analyst question set (`eval-data/corpus/baqa-01-acme-reader/`) gains five questions, S7 to S11, one for each of run 10's wrong answers. Each lists the source that disproves the wrong claim.
