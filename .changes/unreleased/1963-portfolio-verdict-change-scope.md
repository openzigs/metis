---
issue: 1963
section: Fixed
---

- A portfolio assessment over every product you can see no longer reads "could not
  verify" just because an unrelated product could not be checked. When the products the
  change touches all confirm the gap, the verdict is a gap, and the summary names as not
  in scope the unchecked products not connected to any product the change touches (no
  link either way, at any distance). An unchecked product linked to the change, upstream
  or several hops out, or one never analysed, keeps the verdict at "could not verify".
  Assessments saved earlier read as before.
- A downstream product reached by more than one kind of link (for example a shared
  database and an event) now lists every kind in the summary, on the impact page and in
  the Markdown export, not only the one its most severe path crosses.
