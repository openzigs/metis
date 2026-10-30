---
issue: 1610
section: Added
---

- Requirements can now read **Partially implemented**. When METIS checks a
  requirement's acceptance criteria one by one, and finds code that meets at
  least one criterion while confirming another is missing, the verdict says
  so instead of choosing between **Implemented** and **Gap confirmed**. The
  verdict is worked out from the findings linked to each criterion, never
  guessed by the model: a criterion counts as met only when its finding cites
  code that METIS actually retrieved, and a criterion it could not check is
  never counted as met. Requirements without per-criterion evidence, and every
  requirement from an earlier run, keep the verdict they had. The new verdict
  appears on the gap report badge, in the exported report and in the
  traceability matrix.
