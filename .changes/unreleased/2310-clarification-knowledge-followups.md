---
issue: 2310
section: Fixed
---

- Answering a later round of an older analysis's clarifying questions no longer overwrites a newer answer to the same question given in another analysis: each submit records only the round it answered.
- An answer reused from the project's earlier answers now re-runs what it changes for the requirement that reused it (code mapping and governing impact), as a typed answer does.
- After a clarification answer, only the requirements whose clarifications hold that answer under its own question are mapped to code again. A short answer such as "Yes" no longer matches unrelated requirements.
- An answered requirement that the governing re-run cannot match to an analysed requirement is now re-checked under its own id, as **Re-check this requirement** does, so its governing findings no longer judge the wording from before the answer.
- When some requirements' governing findings could not be produced after an answer, the others' new findings and decisions are now stored together. A later findings run no longer reverts them.
- A clarification answer's project document is written before the one it replaces is deleted, so a failed write no longer leaves the answer unindexed. Two saves of the same answer at once no longer index it twice. The document now has its own source, `clarification`, and a `document.upload` audit entry by the person who answered.
- A clarifying question that cites no document paragraph no longer shares its answer with same-titled requirements in other analyses.
- A reused clarification answer records the requirements it applies to by analysis, and two analyses reusing it at once both keep theirs. A clarification with an empty question is now found in the requirement text that holds its answer.
