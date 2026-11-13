---
issue: 2264
section: Fixed
---

- A chat scoped to several products gives its excerpts to the closest matches, not one per product
  in turn, so unrelated products no longer crowd out the one holding the answer. A relevant product
  cut only by the excerpt limit is no longer called irrelevant, and products are compared fairly
  when the reranker falls back for one. A turn searches at most 20 products
  (`CHAT_MULTI_PROJECT_MAX_PROJECTS`) and names the rest; archived products are named as archived;
  same-named products get distinct labels; a saved workspace scope you have left is dropped.
