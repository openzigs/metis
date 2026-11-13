---
issue: 2324
section: Added
---

- `CHAT_SEARCH_GUIDANCE` (off by default) tells chat how to search a project before it answers:
  search with the names the code uses, try two or three wordings, read the code before claiming a
  call, and say what it searched. The search tools' descriptions say when to use each tool, and
  each result ends with a fixed reminder to cite it, or to search again if it found nothing. It
  stays off because on the BA question set it did not raise facts stated, lowered citation
  precision by 3 to 8 points and added about 9,000 input tokens per question.
