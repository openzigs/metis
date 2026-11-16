---
issue: 2599
section: Fixed
---

- On the Bedrock gateway, a Claude Sonnet 5.5 model id (or any current Claude id METIS knows, in
  any regional, global, dated or `-v1:0` spelling) now gets the model's real 1,000,000-token
  context window instead of an assumed 32,768. Thorough analysis keeps its full working memory,
  the document reader reads in full-size pieces, and chat compacts at the right point. A model
  whose window METIS does not know now logs one warning naming `AI_MODEL_CATALOG_OVERRIDES`.
- The Thorough option on a project's Analysis depth card now states its measured gain as
  figures: it found 84 in every 100 of the files a change touches, where Fast found 66.
