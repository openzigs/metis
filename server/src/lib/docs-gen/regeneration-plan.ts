import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * #1071 — one code graph as a snapshot saw it: a digest of the items derived
 * from ITS rows, and the extractor-upgrade mark it carried at that moment
 * (`CodeGraph.extractorUpgradedAt`, ISO; null when no upgrade ever rewrote it).
 */
export const graphStateSchema = z
  .object({ rows: z.string().min(1), mark: z.string().min(1).nullable() })
  .strict();
export type GraphState = z.infer<typeof graphStateSchema>;
/** Graph tag (a hash of the graph's id, never the id) → its state. */
export const graphStatesSchema = z.record(z.string(), graphStateSchema);
export type GraphStates = z.infer<typeof graphStatesSchema>;

/**
 * Hashes only: no source text, credentials or database row IDs. The one
 * timestamp is each graph's upgrade mark, compared for identity alone.
 *
 * `graphs` (#1071) says which graph each graph-row item belongs to, in
 * aggregate, and which upgrade mark each graph carried. It is NOT part of the
 * fingerprint — the items are, exactly as before — so a snapshot recorded
 * without it compares as it always did. Absent on every manifest written
 * before per-graph attribution existed.
 */
export const generationInputSnapshotSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().min(1),
    items: z.record(z.string(), z.string()),
    graphs: graphStatesSchema.optional(),
  })
  .strict();
export type GenerationInputSnapshot = z.infer<typeof generationInputSnapshotSchema>;
export const regenerationTaskSchema = z
  .object({
    projectId: z.string().min(1),
    generatedDocumentId: z.string().min(1),
    expectedVersion: z.number().int().min(0),
    fingerprint: z.string().min(1),
  })
  .strict();
export type RegenerationTask = z.infer<typeof regenerationTaskSchema>;

export function inputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fingerprintInputs(
  items: Record<string, string>,
  graphs?: GraphStates,
): GenerationInputSnapshot {
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
  return {
    version: 1,
    fingerprint: inputHash(sorted),
    items: sorted,
    ...(graphs ? { graphs } : {}),
  };
}

/**
 * #1230 — the snapshot item of a reader-layout BRD's approved requirements
 * (`generation-inputs.ts`). It makes the document stale like any input, but a
 * run in progress does not stop for it: the only section that reads it is
 * rendered by METIS from the stored rows, with no model call, so an analyst
 * approving or editing a requirement mid-run (the normal sign-off workflow)
 * must not throw away the model-written sections. The run publishes with the
 * item it captured and, having seen it move, asks for the check (#1252). The
 * auto-update check then regenerates the document, reusing every section whose
 * own inputs are unchanged (#857). A document without auto-update is marked
 * out of date instead, and its Regenerate (`POST /regenerate`,
 * `reusePublished`) reuses them the same way. Any other manual regenerate (of a
 * failed or cancelled document) does not reuse the published version.
 */
export const APPROVED_REQUIREMENTS_ITEM = "approvedRequirements";

/** The snapshot items a run in progress does not stop for (see above). */
const RUN_STABLE_ITEMS: readonly string[] = [APPROVED_REQUIREMENTS_ITEM];

/**
 * `fresh` as a run that captured `standsFor` compares it mid-run and at the
 * commit fence: every {@link RUN_STABLE_ITEMS} item taken from `standsFor`, so
 * a difference in those alone is no difference at all. Returns `fresh` itself
 * when they already agree.
 */
export function withRunStableItemsOf(
  fresh: GenerationInputSnapshot,
  standsFor: GenerationInputSnapshot,
): GenerationInputSnapshot {
  if (RUN_STABLE_ITEMS.every((key) => fresh.items[key] === standsFor.items[key])) return fresh;
  const items = { ...fresh.items };
  for (const key of RUN_STABLE_ITEMS) {
    const kept = standsFor.items[key];
    if (kept === undefined) delete items[key];
    else items[key] = kept;
  }
  return fingerprintInputs(items, fresh.graphs);
}

/**
 * #1252 — whether `fresh` and `standsFor` differ in a {@link RUN_STABLE_ITEMS}
 * item: a run that publishes standing for `standsFor` is then out of date the
 * moment it publishes, and must ask for the check again (a check made while it
 * ran lost the generation claim to it).
 */
export function runStableItemsDiffer(
  fresh: GenerationInputSnapshot,
  standsFor: GenerationInputSnapshot,
): boolean {
  return RUN_STABLE_ITEMS.some((key) => fresh.items[key] !== standsFor.items[key]);
}

/** Whether `key` is an item a run in progress does not stop for. */
export function isRunStableItem(key: string): boolean {
  return RUN_STABLE_ITEMS.includes(key);
}

/**
 * Item kinds derived from code-graph ROWS: a symbol's identity carries its
 * qualified name, an edge's its endpoints and how it was bound, a rationale
 * finding's its symbol. An extractor upgrade rewrites these with no change to
 * any source file.
 */
const GRAPH_ROW_KINDS = ["symbol:", "edge:", "finding:"] as const;

const isGraphRowKey = (key: string): boolean => GRAPH_ROW_KINDS.some((k) => key.startsWith(k));

/**
 * #1071 — true when two snapshots differ, and ONLY in items derived from
 * code-graph rows: every other item — each source file in full, every SQL
 * file, the evidence pool, the settings, the web research — is identical.
 *
 * This says what kind of difference it is, never why. Graph rows change for
 * real reasons with no source change (a lineage backfill, a re-introspection
 * of the live schema, new rationale findings), and those regenerate. Only a
 * caller holding positive evidence that an extractor upgrade rewrote the graph
 * may treat such a difference as that rewrite — see `extractor-upgrade.ts`.
 */
export function isGraphRowsOnlyChange(
  previous: GenerationInputSnapshot | null,
  current: GenerationInputSnapshot,
): boolean {
  if (!previous || previous.fingerprint === current.fingerprint) return false;
  for (const key of new Set([...Object.keys(previous.items), ...Object.keys(current.items)])) {
    if (isGraphRowKey(key)) continue;
    if (previous.items[key] !== current.items[key]) return false;
  }
  return true;
}

export type RegenerationPlan =
  | { mode: "unchanged"; changed: string[] }
  | { mode: "full"; changed: string[]; reason: string }
  | { mode: "sections"; changed: string[]; sections: string[] };

/** A citation list is NOT a completeness certificate. Holistic manifests currently
 * have global flow/formula dependencies, so callers must omit this certificate. */
export function planRegeneration(
  previous: GenerationInputSnapshot | null,
  current: GenerationInputSnapshot,
  dependencies?: { complete: boolean; sections: Record<string, string[]> },
): RegenerationPlan {
  const changed = [
    ...new Set([...Object.keys(previous?.items ?? {}), ...Object.keys(current.items)]),
  ]
    .filter((key) => previous?.items[key] !== current.items[key])
    .sort();
  if (previous?.fingerprint === current.fingerprint) return { mode: "unchanged", changed: [] };
  const full = (reason: string): RegenerationPlan => ({ mode: "full", changed, reason });
  if (!previous) return full("Legacy version has no input snapshot");
  if (changed.includes("settings")) return full("Effective generation settings changed");
  if (!dependencies?.complete) return full("Dependency completeness is not recorded");
  const entries = Object.entries(dependencies.sections);
  if (changed.some((key) => !entries.some(([, keys]) => keys.includes(key)))) {
    return full("Changed inputs have no complete section mapping");
  }
  const sections = entries
    .filter(([, keys]) => changed.some((key) => keys.includes(key)))
    .map(([id]) => id);
  if (sections.length === entries.length) return full("All sections depend on changed inputs");
  return { mode: "sections", changed, sections };
}
