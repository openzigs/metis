/**
 * Issue #1613 — the NFRs the elicitor (#231) finds, as draft non-functional
 * requirements a BA can review.
 *
 * Until now `runElicitation` only fed the completeness checker a text block
 * (`formatElicitedArtifacts`), so an elicited NFR was never a requirement
 * anyone could see or approve. This turns each one into a synthesized-
 * requirement shape that `persistRequirements` writes beside the synthesis set:
 *
 *   - `kind: "non-functional"` with the elicitor's category (#1612).
 *   - Evidence is the corpus sections the model cited, which are analysis
 *     findings (`runCrossDocDetectionAndPersist` builds one section per
 *     finding), mapped to the synthesis's finding indexes. An NFR citing
 *     nothing has no evidence indexes, so the existing roll-ups give it
 *     `no_evidence` and never `implemented` (NFR-2: no fabrication).
 *   - One the synthesis already states is dropped, never written twice (see
 *     {@link statesSameNfr}).
 *
 * The body is the model's text as-is. It is data: every prompt that later
 * quotes a requirement body fences it there (#1114, #1351), so nothing is
 * escaped here, where a second encoding would only corrupt what the BA reads.
 *
 * Pure.
 */
import type {
  ElicitationPriority,
  Nfr,
  RequirementPriority,
  SynthesizedRequirement,
} from "@metis/shared";

/** The label that tells a reviewer a requirement came from NFR elicitation. */
export const ELICITED_NFR_LABEL = "elicited-nfr";

const PRIORITY: Record<ElicitationPriority, RequirementPriority> = {
  "must-have": "high",
  "should-have": "medium",
  "nice-to-have": "low",
};

/** Lower-case letters, digits and comparison/percent signs only. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}%<>=]+/gu, "");
}

/**
 * True when `existing` already states `nfr`: the same title once case, spacing
 * and punctuation are ignored, or the NFR's measurable target written into the
 * existing requirement's title or body ("p95 < 300ms" in "… p95 < 300 ms …").
 */
export function statesSameNfr(nfr: Nfr, existing: { title: string; body: string }): boolean {
  const title = normalize(nfr.title);
  if (title.length > 0 && title === normalize(existing.title)) return true;
  const metric = normalize(nfr.metric);
  return metric.length > 0 && normalize(`${existing.title} ${existing.body}`).includes(metric);
}

function body(nfr: Nfr): string {
  return nfr.metric ? `${nfr.description}\n\nTarget: ${nfr.metric}` : nfr.description;
}

/**
 * The elicited NFRs to write as requirements, in elicitation order, with any
 * the synthesis set (or an earlier NFR in the list) already states removed.
 * `findingIdsByIndex` is the synthesis's index → finding id map; an evidence id
 * that names no finding in it is not evidence and is dropped.
 */
export function elicitedNfrRequirements(input: {
  nfrs: Nfr[];
  findingIdsByIndex: string[];
  existing: Array<{ title: string; body: string }>;
}): SynthesizedRequirement[] {
  const indexOf = new Map(input.findingIdsByIndex.map((id, i) => [id, i]));
  const kept: SynthesizedRequirement[] = [];
  const seen = [...input.existing];
  for (const nfr of input.nfrs) {
    if (seen.some((e) => statesSameNfr(nfr, e))) continue;
    const requirement: SynthesizedRequirement = {
      type: "feature",
      title: nfr.title,
      body: body(nfr),
      priority: PRIORITY[nfr.priority],
      labels: [ELICITED_NFR_LABEL],
      evidenceFindingIndexes: [
        ...new Set(
          (nfr.evidenceIds ?? [])
            .map((id) => indexOf.get(id))
            .filter((i): i is number => i !== undefined),
        ),
      ],
      acceptanceCriteria: [],
      kind: "non-functional",
      nfrCategory: nfr.category,
    };
    kept.push(requirement);
    seen.push(requirement);
  }
  return kept;
}
