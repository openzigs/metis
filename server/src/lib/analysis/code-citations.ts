/**
 * Code-citation grounding for the code agent (Epic #726 / #734).
 *
 * The code agent may emit CODE citations — `{ filePath, startLine, endLine }`,
 * chat's #715 grounding format — alongside the historical document citations.
 * A model that invents a `file.ts:10-20` it never actually retrieved is
 * hallucinating, and an ungrounded citation is worse than none. This module is
 * the anti-hallucination gate: every code citation is validated against the
 * provenance the agent was actually given (fused code-graph symbol chunks) plus,
 * on the agentic path, the files it read through tools.
 *
 * Rules (pure, no I/O — trivially unit-testable):
 *   - A document citation passes through unchanged (doc enrichment stays the
 *     job of `enrichCitations`; this layer only touches code provenance).
 *   - A document citation whose `documentId` is a synthetic `code-graph:<id>`
 *     (the fused-chunk id from #729) is NORMALISED into a real code citation
 *     using that chunk's authoritative `filePath`/`startLine`/`endLine`. This
 *     also guarantees no `code-graph:` id is ever persisted as a doc citation,
 *     so downstream `Document`-row resolvers never chase it.
 *   - A code citation is KEPT only when its `filePath` appears in the allowed
 *     provenance set; otherwise it is DROPPED (hallucinated). When kept it is
 *     enriched with the matching symbol's `symbolId`/`snippet` when available.
 */
import {
  isCodeCitation,
  isDocumentCitation,
  type Citation,
  type CodeCitation,
} from "@metis/shared";
import type { RetrievalContextChunk } from "./agent-runner.js";
import { CODE_GRAPH_DOCUMENT_PREFIX } from "./fused-code-chunks.js";

/** Normalise a repo-relative path for comparison (strip `./`, leading `/`, backslashes). */
export function normalizeFilePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

/** The code-graph provenance the agent was actually given, indexed for lookup. */
interface CodeProvenance {
  /** Fused symbol chunks keyed by their synthetic `code-graph:<symbolId>` documentId. */
  byDocumentId: Map<string, RetrievalContextChunk>;
  /** Fused symbol chunks keyed by normalised `filePath` (first hit wins). */
  byFilePath: Map<string, RetrievalContextChunk>;
  /** Every filePath the agent may legitimately cite (fused chunks ∪ tool-read files). */
  allowedFilePaths: Set<string>;
}

/**
 * Build the provenance index from the retrieved chunks and any extra file paths
 * the agent read via tools (agentic path). Only chunks carrying code-graph
 * provenance (`source === "code-graph"` with a `filePath`) contribute.
 */
export function buildCodeProvenance(
  retrieved: RetrievalContextChunk[],
  extraAllowedFilePaths: Iterable<string> = [],
): CodeProvenance {
  const byDocumentId = new Map<string, RetrievalContextChunk>();
  const byFilePath = new Map<string, RetrievalContextChunk>();
  const allowedFilePaths = new Set<string>();
  for (const c of retrieved) {
    if (c.source !== "code-graph" || !c.filePath) continue;
    byDocumentId.set(c.documentId, c);
    const norm = normalizeFilePath(c.filePath);
    if (!byFilePath.has(norm)) byFilePath.set(norm, c);
    allowedFilePaths.add(norm);
  }
  for (const p of extraAllowedFilePaths) {
    if (typeof p === "string" && p.trim()) allowedFilePaths.add(normalizeFilePath(p));
  }
  return { byDocumentId, byFilePath, allowedFilePaths };
}

/** Turn a fused code-graph chunk into a fully-formed code citation. */
function chunkToCodeCitation(chunk: RetrievalContextChunk, snippet?: string): CodeCitation {
  const citation: CodeCitation = {
    filePath: chunk.filePath!,
    startLine: chunk.startLine ?? 1,
    endLine: chunk.endLine ?? chunk.startLine ?? 1,
  };
  if (chunk.symbolId) citation.symbolId = chunk.symbolId;
  const snip = (snippet ?? chunk.text)?.trim();
  if (snip) citation.snippet = snip.slice(0, 2048);
  return citation;
}

/** Structured record of a citation the grounding gate discarded (observability). */
export interface DroppedCitation {
  filePath: string;
  reason: "file-not-retrieved" | "code-graph-id-unresolved";
}

/**
 * Ground a finding's citations against the retrieved code provenance.
 *
 * Document citations pass through untouched. A `code-graph:` doc citation is
 * normalised to a real code citation. A code citation survives only if its
 * `filePath` was actually retrieved (else it is dropped as a hallucination and
 * reported via `onDrop`, so a drop is never silent).
 *
 * Grounding is on the normalised **filePath only** — span containment is NOT
 * required. If the model cites `foo.ts:40-55` and the grounded chunk is
 * `foo.ts:12-48`, the file is grounded and the model's (narrower/adjacent) span
 * is kept as-is; the model may legitimately cite a sub-range of a file it saw.
 *
 * Returns the surviving, grounded citation list (order preserved).
 */
export function groundCodeCitations(
  citations: Citation[],
  provenance: CodeProvenance,
  opts?: { onDrop?: (dropped: DroppedCitation) => void },
): Citation[] {
  const out: Citation[] = [];
  for (const c of citations) {
    // A doc citation pointing at a synthetic fused-chunk id → real code citation.
    if (isDocumentCitation(c) && c.documentId.startsWith(CODE_GRAPH_DOCUMENT_PREFIX)) {
      const chunk = provenance.byDocumentId.get(c.documentId);
      if (chunk) out.push(chunkToCodeCitation(chunk, c.snippet));
      // No matching chunk ⇒ the model invented a code-graph id ⇒ drop it.
      else opts?.onDrop?.({ filePath: c.documentId, reason: "code-graph-id-unresolved" });
      continue;
    }

    if (isCodeCitation(c)) {
      const norm = normalizeFilePath(c.filePath);
      if (!provenance.allowedFilePaths.has(norm)) {
        // Hallucinated file:line — the model cited a file it was never shown.
        opts?.onDrop?.({ filePath: c.filePath, reason: "file-not-retrieved" });
        continue;
      }
      const match = provenance.byFilePath.get(norm);
      out.push({
        ...c, // keep the model's span (containment is optional — see doc above)
        symbolId: c.symbolId ?? match?.symbolId,
        snippet: c.snippet ?? match?.text?.trim().slice(0, 2048),
      });
      continue;
    }

    // Plain document citation — untouched here (doc enrichment is elsewhere).
    out.push(c);
  }
  return out;
}

/**
 * Strictly parse `filePath:startLine-endLine` locators out of a tool result and
 * return the (raw) file paths. Only the exact `path:int-int` shape is accepted —
 * a bare path in prose, or `path:int` with no range, is ignored so a chatty
 * result cannot smuggle an ungrounded path into the allowed set.
 *
 * **Truncation-robust:** because we ground on the file path only (not the span),
 * a locator cut mid-span still yields the correct path when the `int-int` is
 * intact, and a locator cut before its `:int-int` simply fails the pattern and
 * is ignored — a truncated preview can therefore never invent a path, only omit
 * one. (In practice we parse the FULL, untruncated `result`, so even that
 * omission does not occur.)
 */
export function parseLocatorFilePaths(text: string): string[] {
  if (!text) return [];
  // path = non-space/non-`:` chars that contain a `/` or `.` (so a bare word
  // like `foo:1-2` is rejected); span = int-int; the locator must be delimited
  // by start/whitespace/open-paren before and end/whitespace/close punctuation
  // after, so a partial trailing token (truncation) fails the lookahead.
  const LOCATOR = /(?:^|[\s([])((?:[^\s:()]*[/.])[^\s:()]*):(\d+)-(\d+)(?=$|[\s):,\]])/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LOCATOR.exec(text)) !== null) {
    if (m[1]) paths.push(m[1]);
  }
  return paths;
}

/** Tool names whose result text carries authoritative `path:startLine-endLine` locators. */
const LOCATOR_BEARING_TOOLS = new Set(["search_code_symbols", "search_code_graph"]);

/**
 * Collect every file path the agentic tool loop grounded a citation in. Three
 * authoritative sources:
 *   - `read_file_slice` **args** — the file the agent explicitly opened;
 *   - `search_code_symbols` / `search_code_graph` **results** — the
 *     `filePath:startLine-endLine` locators those tools render from real
 *     `CodeSymbol` spans (#730). Without this, a symbol the agent discovered via
 *     search and cited WITHOUT also reading it would be dropped as ungrounded,
 *     silently penalising the very tool #730 added. We parse the FULL `result`
 *     (falling back to the 200-char `resultPreview` only when `result` is
 *     absent) so truncation cannot cost a path.
 */
export function collectToolProvenance(
  toolCalls: Array<{ tool: string; args: unknown; resultPreview?: string; result?: string }>,
): string[] {
  const paths: string[] = [];
  for (const call of toolCalls) {
    if (call.tool === "read_file_slice") {
      const fp = (call.args as { filePath?: unknown } | null | undefined)?.filePath;
      if (typeof fp === "string" && fp.trim()) paths.push(fp);
      continue;
    }
    if (LOCATOR_BEARING_TOOLS.has(call.tool)) {
      const text = call.result ?? call.resultPreview ?? "";
      paths.push(...parseLocatorFilePaths(text));
    }
  }
  return paths;
}
