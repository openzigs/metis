---
issue: 1685
section: Changed
---

- In a portfolio check, a product the change may reach only through another product
  that reads **Restricted** now reads **Restricted** too, instead of **Not affected**. A
  product that only provides something to the product the check could not follow stays
  **Not affected**, and the **Restricted** note now says the change *may reach it through*
  that product.
- A check run before this rule, whose **Restricted** products were relabelled whether or
  not they are connected, now says so instead of claiming a connection. Run it again to
  see which products are connected.
- The line naming the products with no repositories, on the page and in the summary,
  names the first three and then says how many more, and never shows a product's id in
  place of its name. A check run before #1677 keeps "We could not tell" until it is run
  again.
- Arriving at the portfolio page from a product already in the picker's first page no
  longer reads that product a second time.
