---
issue: 2587
section: Changed
---

- Impact analysis now reads the code the way a developer would before it answers
  (**Thorough**, `ANALYSIS_CODE_EXPLORATION=explore`) by default. Measured on a real product
  with `claude-sonnet-5-5`, it found more of the files a change touches (Recall@5 0.66 → 0.84,
  +0.18) and made no difference on the small fixture portfolio; a live five-requirement
  analysis cost about 1.55× **Fast** ($0.57 against $0.37) and took about 1.4× as long. To
  switch back, choose **Fast** on a project's Settings or set `ANALYSIS_CODE_EXPLORATION=fast`;
  any other set value also runs Fast, with a warning. A repository whose files are not on the
  server still runs Fast. Thorough's code pass does not search the project's documents or call
  `describe_table` (the document and database agents still do). See `eval-data/README.md`.
