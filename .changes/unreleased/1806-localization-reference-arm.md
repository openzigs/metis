---
issue: 1806
section: Added
---

- `pnpm eval:localization --reference <arm>[,<arm>…]` pairs every other arm with the named arm as well as with A0, in each corpus's report and in the pooled report. For example, `--merge <dir> --reference A12,A13` gives A13C against A12 and A13S against A13 from the runner's own statistics. It changes no score, and you can pass it to `--merge`.
- The edit-candidate re-order's documentation now says what its model-weight threshold does and does not guarantee:
  - Below 5/66 (about 0.076), the search's first file stays in the top 5 whatever the model answers.
  - Below that threshold, a file the search ranked 6th can still reach 3rd place.
  - The weights that keep the guarantee and still let the model change the first file lie between about 0.016 and 0.076.
- The eval guide notes that a `deepseek-flash` tuning run needs `MODEL_PRICES` set.
