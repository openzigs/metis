---
issue: 2351
section: Changed
---

- Chat, impact analysis and the portfolio check use one scope picker, with the same three
  options and wording: **This project**, **Chosen products** and **Whole workspace** (which says
  how many products it covers). Launched from a change request, impact analysis and the
  portfolio check start on its project; elsewhere each starts where it did before. Escape closes
  the picker.
- There is no "All" option any more: an unscoped chat reads **No product chosen** (it still
  answers without searching), and the portfolio check's **Whole workspace** is every product you
  can read when no workspace is open. Impact analysis's project list and the portfolio check's
  **One product** / **Several products** controls are gone.
- The portfolio check refuses a product you cannot read instead of storing it as restricted.
