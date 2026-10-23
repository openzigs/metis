---
issue: 1137
section: Fixed
---

- The analysis Traceability tab no longer renders about a million characters
  for 33 requirements. The gap report and the current-vs-proposed diff show 10
  requirements a page and the matrix 25. A requirement's database changes load
  when you press Show database changes. Each code location is listed once, and
  each test names the test as well as its file.
- The workspace traceability roll-up counts spec and code coverage out of the
  analysed requirements and shows imported items no analysis has mapped as a
  separate count. Before, they were in the denominator, so coverage read 6%.
- New baseline pins the approved requirements, not every row in the project,
  and says how many it will pin and how many it leaves out before you create it.
