/**
 * #816 — plain-language labels for how a test was linked to a requirement's
 * mapped code (`TestLinkRelation`, #814). Shared by the requirement chain view
 * and the analysis traceability matrix so both say the same thing.
 */
import type { TestLinkRelation } from "@metis/shared";

export const TEST_RELATION_LABEL: Record<TestLinkRelation, string> = {
  direct: "Mapped directly",
  exercises: "Calls the code",
  naming: "Naming convention",
  // #1034 — bound by callee name after ingest: a guess, and labelled as one.
  "inferred-call": "Inferred call",
  // #1108 — calls a constructor or router many tests build; not about this requirement.
  "entry-point": "Shared entry point",
};
