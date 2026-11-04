---
issue: 1578
section: Fixed
---

- Business Requirements documents are told that `GenerateRandomStringHex(32)`
  makes 64 characters, not 32, and the consistency note flags a hex length that
  is a byte count. With a readable database, the data dictionary is given the
  database's column defaults and a different stated default is flagged; a
  reader-layout main part's uncited values are listed. The data dictionary,
  and modules making such a call, are rewritten once on the next generation.
