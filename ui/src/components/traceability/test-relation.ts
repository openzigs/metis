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
};
