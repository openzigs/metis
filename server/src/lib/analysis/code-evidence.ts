/**
 * Issue #1568 — which reviewed requirements approving would promote with no
 * code link, said on the Approvals tab BEFORE anyone approves.
 *
 * A promoted requirement's code links are seeded from the evidence findings of
 * the synthesis item it joins onto (`seedRequirementCodeLinksFromFindings`),
 * and only a citation that could be code becomes one (#768). In #706 run 10 an
 * import-scoped analysis promoted 22 requirements and 13 had no code link: all
 * 13 were requirements the analysis added, whose items cited no finding at all,
 * because the code analysis was scoped to the ticked items. Nothing on the tab
 * said so until after approval.
 *
 * This reads the same join promotion makes (`matchSynthesized`, over the
 * requirements not rejected, as `requirementOriginsFor` does) and the same
 * citation rule the seeding uses (`citationTargets`). It does not consult the
 * code graph, so it answers "no code evidence": a requirement it does not list
 * can still end with no link when its cited file is not in the graph, but one
 * it lists cannot get a link from promotion.
 */
import type { SynthesizedRequirement } from "@metis/shared";
import { citationTargets } from "../traceability/seed-code-links-from-findings.js";
import { matchSynthesized } from "./approved-requirement-set.js";
import type { StructuredRequirement } from "./types/requirements.js";

export function requirementsWithoutCodeEvidence(input: {
  structured: ReadonlyArray<Pick<StructuredRequirement, "id" | "title">>;
  synthesized: readonly SynthesizedRequirement[];
  /** The flattened findings, in the order synthesis's evidence indexes refer to. */
  findings: ReadonlyArray<{ citations?: unknown }>;
  /** Requirements whose latest approval is rejected: they are left out of the join. */
  rejectedIds?: ReadonlySet<string>;
}): Set<string> {
  const rejected = input.rejectedIds ?? new Set<string>();
  const considered = input.structured.filter((r) => !rejected.has(r.id));
  const matches = matchSynthesized(considered, input.synthesized, input.structured);
  const citesCode = input.findings.map((f) => citationTargets(f.citations).length > 0);
  const out = new Set<string>();
  for (const req of considered) {
    const indexes = matches.get(req.id)?.evidenceFindingIndexes ?? [];
    if (!indexes.some((i) => citesCode[i] === true)) out.add(req.id);
  }
  return out;
}
