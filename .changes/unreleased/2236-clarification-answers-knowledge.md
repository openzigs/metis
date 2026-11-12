---
issue: 2236
section: Added
---

- Clarification answers are now kept as project knowledge. Each answer is saved with the question, who answered it and when, the paragraph of the document it was about, and the requirements and product it applies to. It is added to the project's knowledge, so chat and later analyses can find and cite it.
- A later analysis of the same project does not ask a question that has already been answered: it reuses the answer and lists it in the questions panel as already answered. If the paragraph the question was about has changed, the question is asked again and the old answer is no longer cited.
- An answer now re-runs what it changes. The affected requirements are mapped to code again and re-checked against your company's policies, and the policy findings show as being re-checked until the new ones are ready. Policy questions you already answered on those requirements keep their answers.
- Spec Kit `/specify`, `/plan` and `/tasks` now read the answers given with `/clarify`, and each `/clarify` answer is saved as project knowledge too.
- Answers and quoted document text are passed to the model as data it must not take instructions from.
