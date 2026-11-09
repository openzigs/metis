---
issue: 1909
section: Added
---

- The localization eval's table guard now records, for each A7 run, every stored
  citation behind each requirement and how it reached the test fixture: as its symbol,
  as a same-named one, as its whole file, or dropped. It also shows whether a citation
  read as its file named a symbol the fixture does not model. Where A7 scores below its
  control A7O on a requirement, the guard prints each run's extra tables and the
  citations behind them. That names the code path behind DeepSeek's A7 − A7O gap once
  the live re-read runs (#2057).
