---
issue: 1615
section: Added
---

- The analysis and impact pages now show what the server already records. The
  verdict badge reads **Partly implemented** for a requirement that is partly
  built, and a verdict the page does not recognise shows a grey **Verdict
  unknown** badge instead of nothing. A code citation names the repository its
  `file:line` is in, so the same path in two of a project's repositories reads
  as two files. When the repository cannot be told apart, no name is shown.
  Each requirement card shows its kind (functional or non-functional, with the
  category), and a **Kind** filter narrows the list. A version that only changes
  the kind now shows in the history diff. A multi-project impact analysis lists
  the projects with nothing to show in a collapsed group, each with the reason:
  **Checked: nothing affected**, **Not checked: no access** (shown without the
  project's name), **Not checked: no code index**, or **Error: the check
  failed**.
