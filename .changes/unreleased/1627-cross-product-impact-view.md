---
issue: 1627
section: Added
---

- A finished portfolio check now shows its cross-product impact. The business-analyst
  summary comes first. Then each affected product is listed: whether it must change or
  consumes what changes, through what (an API, an event, a shared database, a shared
  library or shared identity), a severity badge, and its one-paragraph summary. **Why
  this severity?** shows how the stored severity was worked out, hop by hop: the
  coupling strength it started from, each step up or down, and the confidence.
  **Technical deep dive** lists the product's repositories, files, contract items,
  tables and columns and topics, and draws the path of products the change travels
  along. Products the change does not reach are listed in a collapsed **Not affected**
  group. **Export Markdown** downloads the whole report once the check has finished.
