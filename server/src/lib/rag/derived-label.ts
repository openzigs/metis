/**
 * #199 — the derived-material label for generated-document chunks (#189, ADR 0017).
 * Retrieval attaches it (`readDerivedLabel`); chat prints it (`formatDerivedLabel`).
 */
import type { RetrievedChunk } from "@metis/shared";

/**
 * The one definition of the generated-doc `evidenceClass` stamp. The #189 writer
 * (`docs-gen/generated-doc-publication.ts`) re-exports it as
 * `GENERATED_DOC_EVIDENCE_CLASS`, so writer and reader cannot drift apart.
 */
export const DERIVED_EVIDENCE_CLASS = "derived-generated-doc";

/**
 * A chunk is derived when #189 stamped its metadata, or when its document was written
 * by the generated-document path (a legacy chunk that predates the stamp).
 */
export function readDerivedLabel(
  rawMetadata: string | null,
  documentSource: string,
): RetrievedChunk["derived"] {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawMetadata ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      meta = parsed as Record<string, unknown>;
  } catch {
    // Unparseable metadata is treated as absent; the document source still decides.
  }
  if (meta.evidenceClass !== DERIVED_EVIDENCE_CLASS && documentSource !== "generated")
    return undefined;
  const status = meta.generatedDocumentStatus;
  const scope = meta.generatedDocumentScope;
  return {
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof scope === "string" ? { scope } : {}),
  };
}

/** The line-suffix for a chat excerpt header; empty for primary material. */
export function formatDerivedLabel(derived: RetrievedChunk["derived"]): string {
  if (!derived) return "";
  const parts = ["DERIVED: generated documentation, not a primary source"];
  if (derived.status && derived.status !== "ready") parts.push(`status=${derived.status}`);
  if (derived.scope && derived.scope !== "full") parts.push(`scope=${derived.scope}`);
  return ` [${parts.join("; ")}]`;
}
