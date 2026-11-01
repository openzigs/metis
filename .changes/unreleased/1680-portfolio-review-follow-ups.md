---
issue: 1680
section: Changed
---

- One product you cannot read no longer moves every unrelated product out of **Not
  affected** in a portfolio check. Only a product connected to it (a shared repository, an
  edge or a resource both use) reads **Restricted**, and its note no longer says *you*
  cannot read the product, since that depends on who ran the check.
- Deleting a declared integration edge now asks first, and a detected edge's strength
  override is chosen, then applied (or cancelled), instead of being saved on the first
  pick. The strength being applied stays shown while it saves.
- Arriving at the portfolio page from a product shows that product's name even when it
  is not in the first page of the picker, and a check whose live updates stopped is
  re-read every 5 seconds instead of 3.
