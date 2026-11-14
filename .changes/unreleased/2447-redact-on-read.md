---
issue: 2447
section: Security
---

- A finding, requirement or cross-document finding that draws on a document you may not see is
  now shown as "Restricted" in its place, wherever analysis output appears: the change request
  page, the requirements list, report and matrix exports, the requirement diff, chat, and the
  portfolio and impact checks. The rest of the result is shown as before, and nothing is hidden
  from someone who can see the document. A requirement you cannot see cannot be opened, edited,
  checked or used to start a Spec Kit feature, and a title search does not find it. Analyses that
  recorded no sources (those run before this release) keep today's rule, where everything in a
  result is shared with the whole project.
- A check started from a change request says how many requirements it left out for their sources,
  never which; an admin shown a restricted row is recorded in the audit log.
