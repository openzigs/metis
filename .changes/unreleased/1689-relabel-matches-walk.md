---
issue: 1689
section: Fixed
---

- A portfolio check now reads a product **Restricted** exactly when the check would reach
  it if it could follow the change through every product, as far as it looks. It no
  longer marks one the change cannot reach, nor misses one reached through a product it
  does not list or cannot read. Older checks say they used an older rule and ask for a
  re-run.
- A list of products in prose joins the last name with "and" and counts nameless ones.
