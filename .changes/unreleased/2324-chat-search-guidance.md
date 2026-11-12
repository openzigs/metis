---
issue: 2324
section: Changed
---

- Chat now tells the model how to search a project before it answers, whenever it can call code or
  knowledge search: turn the question into the names the code uses, try two or three wordings before
  saying something is not there, read the code before claiming one function calls another, and say
  what it searched when nothing turns up. The four search tools' descriptions now say when to use
  each, what a good query looks like and what to try after an empty result. Each result they return
  ends with a fixed reminder to answer only from the results and cite them, or, when it found
  nothing, to search again before concluding. Administrators can turn this off with
  `CHAT_SEARCH_GUIDANCE=false`.
