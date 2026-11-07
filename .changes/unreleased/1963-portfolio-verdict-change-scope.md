---
issue: 1963
section: Fixed
---

- A portfolio assessment over every product you can see no longer reads "could not
  verify" just because an unrelated product could not be checked. When the products the
  change touches all confirm the gap, the verdict is a gap, and the summary names the
  unchecked products the change does not reach as not in scope. Only a product whose
  integrations were analysed counts as not reached; an unchecked product never analysed
  keeps the verdict at "could not verify", and the summary says it was never analysed. An
  affected product that could not be checked still makes the verdict "could not verify".
- A downstream product reached by more than one kind of link (for example a shared
  database and an event) now lists every kind in the summary, on the impact page and in
  the Markdown export, not only the one its most severe path crosses.
