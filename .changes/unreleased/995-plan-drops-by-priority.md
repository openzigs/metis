---
issue: 995
section: Fixed
---

- With the topic plan on, a Business Requirements document now leaves topics
  out before writing when a section has too little room for them, least
  important first, while important topics still get more room than minor ones.
  Topics holding a value the section owns are planned and written first.
- Applies with `DOCS_GEN_TOPIC_PLAN=on`, and also with `DOCS_GEN_BRD_LAYOUT=reader`,
  which plans the document whatever that flag says. Either way, a planned BRD
  is rewritten in full once on its next regeneration (about $1.89 on DeepSeek,
  walkthrough run 9). Documents generated with neither setting are unchanged.
