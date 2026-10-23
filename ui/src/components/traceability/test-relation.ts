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

/**
 * #1108 review — what each label means, in an analyst's words, for a tooltip.
 */
export const TEST_RELATION_DESCRIPTION: Record<TestLinkRelation, string> = {
  direct: "The code mapped to this requirement is itself a test.",
  exercises: "This test calls the code mapped to this requirement.",
  naming:
    "This test sits next to the mapped code and is named after it. A weak signal: check the test.",
  "inferred-call":
    "This test seems to call the mapped code, matched by name only. A weak signal: check the test.",
  "entry-point":
    "This test only calls shared setup code (such as a constructor or router) that many tests use, and its name does not mention this requirement. It does not count as testing this requirement.",
};
