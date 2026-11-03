---
issue: 1725
section: Fixed
---

- A portfolio check of a requirement nothing covers yet no longer says "No product needs to
  change". The form offers an optional "Which product will build this?" picker; the check names
  the product chosen, and its impact lists the products downstream of it with their path and
  severity. A product that holds one of the chosen product's repositories, such as an umbrella
  product, is reported as a direct change rather than a downstream consumer. A check run without
  a host says impact needs one and links back to the picker with the requirement filled in.
