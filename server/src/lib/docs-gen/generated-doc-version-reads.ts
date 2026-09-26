/**
 * #196 — cached reads of a generated-document version's heavy columns.
 *
 * A full-coverage document's provenance manifest is ~17 MB and its changed
 * symbols ~8 MB. The detail, list and panel routes need only a handful of
 * facts from either, so each is parsed once per version and the small result
 * kept in a bounded, per-process LRU.
 *
 * Caching is sound because a version row is written once
 * (`generatedDocumentVersion.create` in the generate handler) and never
 * updated. The cache key still carries the row's `createdAt`, so a row that is
 * deleted and re-created under the same id can never be served stale.
 */
import {
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
  type GeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";

/** The summary the viewer's Provenance panel shows, without the manifest. */
export interface GeneratedDocProvenanceSummary {
  revisionId: string;
  version: number;
  generatedAt: string;
  pipeline: string;
  models: { phase1: string; phase2: string };
  sectionCount: number;
  selectedEvidenceCount: number;
  sourceCount: number;
  historicalCitations: GeneratedDocVersionManifest["historicalCitations"];
  legacy: GeneratedDocVersionManifest["legacy"];
}

export function summarizeGeneratedDocVersionManifest(
  manifest: GeneratedDocVersionManifest,
): GeneratedDocProvenanceSummary {
  return {
    revisionId: manifest.revision.revisionId,
    version: manifest.revision.version,
    generatedAt: manifest.document.generatedAt,
    pipeline: manifest.generation.pipeline ?? "unknown",
    models: {
      phase1: manifest.generation.model.phase1.model,
      phase2: manifest.generation.model.phase2.model,
    },
    sectionCount: manifest.sections.length,
    selectedEvidenceCount: manifest.selectedEvidence.primary.length,
    sourceCount: manifest.sourceFingerprints.length,
    historicalCitations: manifest.historicalCitations,
    legacy: manifest.legacy,
  };
}

/** A least-recently-used map bounded by the total weight of its values. */
export class WeightedLru<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private total = 0;

  constructor(
    private readonly maxWeight: number,
    private readonly weigh: (value: V) => number = () => 1,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    const weight = this.weigh(value);
    this.delete(key);
    if (weight > this.maxWeight) return;
    this.entries.set(key, { value, weight });
    this.total += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.maxWeight) break;
      this.entries.delete(oldest);
      this.total -= entry.weight;
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.total -= entry.weight;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}

/** The immutable identity of one stored version row. */
export interface GeneratedDocVersionRowKey {
  projectId: string;
  documentId: string;
  versionId: string;
  version: number;
  createdAt: Date;
}

function cacheKey(row: GeneratedDocVersionRowKey): string {
  return `${row.projectId}\u0000${row.documentId}\u0000${row.versionId}\u0000${row.createdAt.getTime()}`;
}

/** `null` records a manifest that cannot be read, which is as immutable as a good one. */
const summaries = new WeightedLru<GeneratedDocProvenanceSummary | null>(2_000);

/**
 * The provenance summary of one version, parsing its stored manifest at most
 * once per process. `loadManifest` is called only on a cache miss. Returns
 * `null` when the stored manifest is unreadable; a version that never stored
 * one gets the legacy manifest's summary, exactly as the full endpoint does.
 */
export async function cachedProvenanceSummary(
  row: GeneratedDocVersionRowKey,
  loadManifest: () => Promise<string | null>,
): Promise<GeneratedDocProvenanceSummary | null> {
  const key = cacheKey(row);
  const cached = summaries.get(key);
  if (cached !== undefined) return cached;
  const stored = await loadManifest();
  let summary: GeneratedDocProvenanceSummary | null;
  try {
    summary = summarizeGeneratedDocVersionManifest(
      stored
        ? parseGeneratedDocVersionManifest(stored)
        : legacyGeneratedDocVersionManifest({
            projectId: row.projectId,
            generatedDocumentId: row.documentId,
            version: row.version,
          }),
    );
  } catch {
    summary = null;
  }
  summaries.set(key, summary);
  return summary;
}

/** Parsed changed-symbol arrays, bounded by the total length of their stored JSON. */
const CHANGED_SYMBOLS_CACHE_CHARS = 64 * 1024 * 1024;
const changedSymbols = new WeightedLru<{ items: unknown[]; storedLength: number }>(
  CHANGED_SYMBOLS_CACHE_CHARS,
  (entry) => entry.storedLength,
);

/**
 * A version's changed symbols, parsed once per process. `loadChangedSymbols`
 * is called only on a cache miss. Returns `null` when the stored value is not
 * a JSON array.
 */
export async function cachedChangedSymbols(
  row: GeneratedDocVersionRowKey,
  loadChangedSymbols: () => Promise<string>,
): Promise<unknown[] | null> {
  const key = cacheKey(row);
  const cached = changedSymbols.get(key);
  if (cached) return cached.items;
  const stored = await loadChangedSymbols();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  changedSymbols.set(key, { items: parsed, storedLength: stored.length });
  return parsed;
}

/** Test seam: drop every cached read. */
export function clearGeneratedDocVersionReadCaches(): void {
  summaries.clear();
  changedSymbols.clear();
}
