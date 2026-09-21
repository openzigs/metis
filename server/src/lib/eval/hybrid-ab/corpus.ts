/**
 * #335 — the default fixture corpus for the hybrid A/B rollout gate.
 *
 * A small, tier-balanced set of documents/sections. Both arms run the IDENTICAL
 * corpus, so the comparison is apples-to-apples. Operators can supply their own
 * corpus (e.g. the real `eval-data/` documents) via {@link runAbEval}; this
 * default gives the gate a deterministic, checked-in baseline shape to exercise.
 */
import type { AbCorpusItem } from "./types.js";

export const DEFAULT_AB_CORPUS: AbCorpusItem[] = [
  {
    id: "business-requirements",
    title: "Business Requirements",
    sections: [
      { id: "br-overview", label: "Overview & Domain", tier: "narrative" },
      { id: "br-capabilities", label: "Core Business Capabilities", tier: "narrative" },
      { id: "br-rules", label: "Business Rules", tier: "literal" },
      { id: "br-integrations", label: "Integrations", tier: "literal" },
      { id: "br-workflows", label: "Key Workflows", tier: "reconstruction" },
      { id: "br-data-model", label: "Data & Domain Model", tier: "reconstruction" },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    sections: [
      { id: "arch-overview", label: "System Overview", tier: "narrative" },
      { id: "arch-components", label: "Components", tier: "literal" },
      { id: "arch-flows", label: "Data Flows", tier: "reconstruction" },
    ],
  },
];
