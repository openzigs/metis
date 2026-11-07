---
issue: 1899
section: Added
---

- The localization eval has two new arms, A7R and A7RD. They re-read the code with
  nothing changed, as a routine refresh does, and then measure the files to edit
  without and with setting out-of-date citations aside. The earlier no-change arm (A7K)
  matches A7 by construction, so it could not show that cost. After a staleness patch,
  every repository is now restored even when restoring one of them fails, and the
  original error is kept. Server type checking now also covers the scripts under
  `server/scripts/`.
