---
issue: 2324
section: Added
---

- `CHAT_SEARCH_GUIDANCE` (off by default) tells chat how to search a project before it answers,
  whenever it can call code or knowledge search. It asks the model to:
  - turn the question into the names the code uses;
  - try two or three wordings before saying something is not there;
  - read the code before claiming one function calls another;
  - say what it searched when nothing turns up.

  The four search tools' descriptions also say when to use each one, what a good query looks like
  and what to try after an empty result. Each result they return ends with a fixed reminder:
  answer only from the results and cite them, or, when the search found nothing, search again
  before concluding it is not there. It stays off because on the BA question set it did not raise
  the share of facts stated, lowered citation precision by 3 to 8 points and added about 9,000
  input tokens per question.
