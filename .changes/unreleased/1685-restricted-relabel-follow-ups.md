---
issue: 1685
section: Changed
---

- In a portfolio check, a product the change may reach only through another **Restricted**
  product now reads **Restricted** too; one that only provides to the product the check
  could not follow stays **Not affected**. A check run before this rule no longer claims
  a connection it never looked for.
- The line naming products with no repositories names three, then "and N more", never a
  product's id. A check run before #1677 keeps "We could not tell" until it is re-run.
