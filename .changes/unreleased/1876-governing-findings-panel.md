---
issue: 1876
section: Added
---

- The analysis Findings tab now shows a "Governing rules" panel: for each
  requirement, every applicable rule of your workspace's governing documents
  with its status (Compliant, Gap or Needs BA input), control id, the quoted
  clause and the policy revision it was checked against. A summary sentence
  per policy revision states the gaps found and ends "Not an audit opinion."
  Accept or reject a finding with a note; the decision, the note and who made
  it are shown after a reload. A Needs BA input finding links to the
  clarifying question that settles it. Nothing is shown while
  `GOVERNING_DOCS_ENABLED` is off, which is still the default.
