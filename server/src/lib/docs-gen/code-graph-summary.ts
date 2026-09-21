/**
 * Code-graph edge summarisation for doc synthesis (#271, items 1 & 2).
 *
 * The holistic synthesizer's Phase 1 extracts facts PER MODULE in isolation —
 * it never sees the call/dependency edges between modules, nor (for SAS) the
 * dataset lineage already captured by the parser. As a result the synthesized
 * doc cannot describe true end-to-end workflows or dataset input→output flow,
 * which is exactly what makes a business-requirements doc "reconstruction
 * grade".
 *
 * This module is PURE and deterministic: it takes the already-loaded code
 * symbols + edges (from the DB, the same source the synthesizer already uses —
 * NO graphify CLI dependency) and produces compact, budget-bounded summaries:
 *
 *   1. Per-module DATA_LINEAGE blocks — for each documentable module, the SAS
 *      datasets it reads (input) and writes (output), derived from the parser's
 *      `references` edges carrying `metadata.lineage`.
 *   2. A project-level dataset lineage chain — for each dataset, which modules
 *      produce it and which consume it, so synthesis can chain
 *      "module A writes DS → module B reads DS".
 *   3. A cross-module dependency/call summary — module → module edges
 *      (calls / imports / references) so synthesis can describe orchestration.
 *
 * Everything is char-budget bounded so feeding it into Phase 2 cannot blow the
 * token budget.
 */

import { repositoryPathIdentity, type RepositoryIdentity } from "./repository-identity.js";

/** Minimal symbol shape this module needs (subset of CodeSymbol). */
export interface GraphSymbol {
  repository?: RepositoryIdentity;
  id: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  contentHash?: string | null;
  language?: string | null;
}

/** Minimal edge shape this module needs (subset of CodeEdge). */
export interface GraphEdge {
  kind: string;
  fromSymbolId: string;
  toSymbolId: string | null;
  toQualifiedName: string | null;
  /** Raw JSON string as stored on CodeEdge.metadata, or already-parsed object. */
  metadata?: string | null | Record<string, unknown>;
}

/** Lineage entry: a dataset and the modules that read / write it. */
export interface DatasetLineage {
  dataset: string;
  /** Module dirs that WRITE (produce) this dataset. */
  producers: string[];
  /** Module dirs that READ (consume) this dataset. */
  consumers: string[];
}

export interface CodeGraphSummary {
  /** module dir → rendered DATA_LINEAGE block (already markdown-ish). */
  perModuleLineage: Map<string, string>;
  /** Ordered project-level dataset lineage (most-connected first). */
  datasetLineage: DatasetLineage[];
  /** module dir → set of module dirs it depends on (calls/imports/references). */
  crossModuleDeps: Map<string, Set<string>>;
}

/** Parse the JSON-encoded edge metadata, tolerating already-parsed objects. */
function parseMeta(metadata: GraphEdge["metadata"]): { lineage?: string; dataset?: string } | null {
  if (!metadata) return null;
  if (typeof metadata === "object") return metadata as { lineage?: string; dataset?: string };
  try {
    return JSON.parse(metadata) as { lineage?: string; dataset?: string };
  } catch {
    return null;
  }
}

/** The directory of a file path (matches loadModules' `dir` computation). */
function dirOf(filePath: string): string {
  return filePath.split("/").slice(0, -1).join("/");
}

/**
 * Build all three summaries from symbols + edges.
 *
 * @param symbols   All code symbols for the project/graph.
 * @param edges     All code edges for the project/graph.
 * @param moduleDirs The set of documentable module dirs (from loadModules) —
 *                   only edges/lineage anchored to these are surfaced. When
 *                   omitted, every dir that appears is included.
 */
export function buildCodeGraphSummary(
  symbols: GraphSymbol[],
  edges: GraphEdge[],
  moduleDirs?: Set<string>,
): CodeGraphSummary {
  const symById = new Map<string, GraphSymbol>();
  for (const s of symbols) symById.set(s.id, s);

  const include = (dir: string): boolean => !moduleDirs || moduleDirs.has(dir);

  // ── 1 & 2: dataset lineage ────────────────────────────────────────────
  // module dir → { input: Set, output: Set }
  const moduleDatasets = new Map<string, { input: Set<string>; output: Set<string> }>();
  // dataset → { producers: Set<dir>, consumers: Set<dir> }
  const datasetMap = new Map<string, { producers: Set<string>; consumers: Set<string> }>();

  // ── 3: cross-module deps ──────────────────────────────────────────────
  const crossModuleDeps = new Map<string, Set<string>>();

  for (const e of edges) {
    const from = symById.get(e.fromSymbolId);
    if (!from) continue;
    const fromDir = repositoryPathIdentity(from.repository, dirOf(from.filePath));

    // Lineage from `references` edges with metadata.lineage.
    if (e.kind === "references") {
      const meta = parseMeta(e.metadata);
      const lineage = meta?.lineage;
      const datasetName = (meta?.dataset ?? e.toQualifiedName ?? "").trim();
      const dataset = repositoryPathIdentity(from.repository, datasetName);
      if ((lineage === "input" || lineage === "output") && datasetName) {
        if (include(fromDir)) {
          let md = moduleDatasets.get(fromDir);
          if (!md) {
            md = { input: new Set(), output: new Set() };
            moduleDatasets.set(fromDir, md);
          }
          md[lineage].add(dataset);

          let ds = datasetMap.get(dataset);
          if (!ds) {
            ds = { producers: new Set(), consumers: new Set() };
            datasetMap.set(dataset, ds);
          }
          if (lineage === "output") ds.producers.add(fromDir);
          else ds.consumers.add(fromDir);
        }
        continue; // a lineage reference is not a cross-module code dep
      }
    }

    // Cross-module dependency edges (calls / imports / references to code).
    if (e.kind === "calls" || e.kind === "imports" || e.kind === "references") {
      let toDir: string | null = null;
      if (e.toSymbolId) {
        const to = symById.get(e.toSymbolId);
        if (to) toDir = repositoryPathIdentity(to.repository, dirOf(to.filePath));
      }
      if (toDir && toDir !== fromDir && include(fromDir) && include(toDir)) {
        if (!crossModuleDeps.has(fromDir)) crossModuleDeps.set(fromDir, new Set());
        crossModuleDeps.get(fromDir)!.add(toDir);
      }
    }
  }

  // Render per-module lineage blocks.
  const perModuleLineage = new Map<string, string>();
  for (const [dir, { input, output }] of moduleDatasets.entries()) {
    if (input.size === 0 && output.size === 0) continue;
    const lines: string[] = [];
    if (input.size > 0) {
      lines.push(`- INPUT datasets (read): ${[...input].sort().join(", ")}`);
    }
    if (output.size > 0) {
      lines.push(`- OUTPUT datasets (written): ${[...output].sort().join(", ")}`);
    }
    perModuleLineage.set(dir, lines.join("\n"));
  }

  // Build ordered project-level dataset lineage (most-connected first).
  const datasetLineage: DatasetLineage[] = [...datasetMap.entries()]
    .map(([dataset, { producers, consumers }]) => ({
      dataset,
      producers: [...producers].sort(),
      consumers: [...consumers].sort(),
    }))
    // Only chains that actually link modules (a producer AND consumer, or
    // at least one of each role) are interesting; keep any with ≥1 endpoint.
    .filter((d) => d.producers.length > 0 || d.consumers.length > 0)
    .sort(
      (a, b) => b.producers.length + b.consumers.length - (a.producers.length + a.consumers.length),
    );

  return { perModuleLineage, datasetLineage, crossModuleDeps };
}

/**
 * Render the per-module DATA_LINEAGE block for a single module, or null when
 * the module has no lineage. Used to splice DATA_LINEAGE into Phase-1 facts.
 */
export function renderModuleLineage(summary: CodeGraphSummary, moduleDir: string): string | null {
  return summary.perModuleLineage.get(moduleDir) ?? null;
}

/**
 * Render the project-level dataset lineage chain as a compact, char-bounded
 * markdown block for the Phase-2 synthesis prompt. Shows, per dataset, the
 * producing module(s) → consuming module(s) so synthesis can describe true
 * input→output workflows.
 */
export function renderDatasetLineageChain(
  summary: CodeGraphSummary,
  maxChars = 4000,
  maxRows = 60,
): string {
  if (summary.datasetLineage.length === 0) return "";
  const parts: string[] = ["### DATASET LINEAGE (which module writes/reads which dataset)"];
  let total = parts[0].length;
  let shown = 0;
  for (const d of summary.datasetLineage) {
    if (shown >= maxRows) break;
    const prod = d.producers.length ? d.producers.map(shortDir).join(", ") : "(external/source)";
    const cons = d.consumers.length ? d.consumers.map(shortDir).join(", ") : "(terminal/output)";
    const line = `- \`${d.dataset}\`: produced by [${prod}] → consumed by [${cons}]`;
    if (total + line.length > maxChars) {
      parts.push(`- (... ${summary.datasetLineage.length - shown} more datasets truncated)`);
      break;
    }
    parts.push(line);
    total += line.length;
    shown += 1;
  }
  return parts.join("\n");
}

/**
 * Render the cross-module dependency summary as a compact, char-bounded
 * markdown block for the Phase-2 synthesis prompt. Shows module → modules it
 * depends on, so synthesis can describe end-to-end orchestration.
 */
export function renderCrossModuleDeps(
  summary: CodeGraphSummary,
  maxChars = 4000,
  maxRows = 60,
): string {
  if (summary.crossModuleDeps.size === 0) return "";
  // Order by out-degree (most-connected modules first — these are the
  // orchestrators worth describing).
  const ordered = [...summary.crossModuleDeps.entries()].sort((a, b) => b[1].size - a[1].size);
  const parts: string[] = ["### CROSS-MODULE DEPENDENCIES (module → modules it depends on)"];
  let total = parts[0].length;
  let shown = 0;
  for (const [dir, deps] of ordered) {
    if (shown >= maxRows) break;
    const targets = [...deps].sort().map(shortDir).join(", ");
    const line = `- ${shortDir(dir)} → ${targets}`;
    if (total + line.length > maxChars) {
      parts.push(`- (... ${ordered.length - shown} more modules truncated)`);
      break;
    }
    parts.push(line);
    total += line.length;
    shown += 1;
  }
  return parts.join("\n");
}

/** Trim a module dir to its last 3 path segments for legible prompts. */
function shortDir(dir: string): string {
  return dir.split("/").slice(-3).join("/") || dir;
}
