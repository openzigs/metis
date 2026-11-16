---
issue: 2595
section: Added
---

- An impact analysis can be handed off as a Word or PDF document: **Export Word** and **Export
  PDF** on the report give the change request it was started from together with the analysis, in one
  readable document — the summary, each requirement with its source passage, the files to edit with
  their lines, the clarifications answered, the risks and what could not be verified. The markdown
  export lists only the first ten blast-radius symbols and covering tests of each change and counts
  the rest, so a large run no longer downloads as a file of hundreds of kilobytes (one walkthrough
  run went from 552 KB to 128 KB).
