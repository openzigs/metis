---
issue: 1137
section: Fixed
---

- The analysis Traceability tab no longer renders about a million characters
  for 33 requirements: the gap report and diff show 10 requirements a page, the
  matrix 25, and database changes load on request. Code locations are listed
  once, and each test names the test as well as its file.
- The workspace roll-up counts coverage out of analysed requirements and shows
  imported items no analysis has mapped as a separate count (it read 6%).
- New baseline leaves out imported items nobody approved, and says how many it
  will pin, how many are approved, and how many it leaves out.
