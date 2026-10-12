import { createHash } from "node:crypto";
import { z } from "zod";

/** Hashes only: no source text, credentials, database row IDs, or timestamps. */
export const generationInputSnapshotSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().min(1),
    items: z.record(z.string(), z.string()),
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

export function fingerprintInputs(items: Record<string, string>): GenerationInputSnapshot {
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
  return { version: 1, fingerprint: inputHash(sorted), items: sorted };
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
