---
issue: 1692
section: Fixed
---

- A portfolio check now reads a product **Restricted** when the change may reach it through
  a repository the person who ran the check cannot read, even if the check stopped at no
  product they cannot read. Before, it read **Not affected** whenever the check stopped at
  no such product, so the same path could read either way depending on an unrelated
  product.
- Working out which products to mark **Restricted** costs less: it is skipped when the
  person who ran the check can read everything it touched, and otherwise stops as soon as
  it has its answer.
