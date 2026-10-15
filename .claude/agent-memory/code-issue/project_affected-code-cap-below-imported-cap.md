---
name: affected-code-cap-below-imported-cap
description: ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES (default 8) is below MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS (25); logic keyed on imported NR-* ids silently loses items 9+, so test with more items than the cap.
metadata:
  type: project
---

`ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES` defaults to 8 (`DEFAULT_AFFECTED_CODE_MAX_CANDIDATES`, `server/src/lib/analysis/affected-code-context.ts`; also read by `new-requirements.ts` and `affected-schema-context.ts`), while a run may import up to `MAX_IMPORTED_REQUIREMENTS_PER_ANALYSIS` = 25 items (`@metis/shared`). Logic keyed on the imported `NR-*` candidate ids therefore silently loses items 9 and later.

**Why:** raised by the review of PR #1158 (#1098); every test there used fewer imported items than the cap, so the loss was invisible.

**How to apply:** any change that touches imported items gets a fixture with more items than 8 (ideally 25) and asserts item 9+ is handled or reported. General shape: [[never-dropped-silently-needs-a-fixture-per-cap]].
