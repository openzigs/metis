/**
 * The stored chunks of a document, as the document reader cites them: its
 * approved chunks (`knowledgeChunk`) by position, else, while it waits in
 * quarantine, its quarantined chunks (`quarantineChunk`, `ord >= 0`) by `ord`.
 *
 * One rule, shared by the reader (`document-reader-agent.ts`), which quotes
 * these chunks in the questions it asks, and by the clarification reopen
 * (`clarification-records.ts`, #2429), which checks a quote against the same
 * text. If the two read different chunks, the reopen would compare against
 * text the questions never quoted.
 */
import { prisma } from "../prisma.js";

/** One stored chunk: its position (or `ord`) in the document, and its text. */
export interface StoredChunk {
  index: number;
  text: string;
}

/**
 * The stored chunks of each of `documentIds` (of `projectId`), in order. A
 * document with no stored chunk is absent.
 */
export async function storedChunksByDocument(
  projectId: string,
  documentIds: readonly string[],
): Promise<Map<string, StoredChunk[]>> {
  const out = new Map<string, StoredChunk[]>();
  if (documentIds.length === 0) return out;
  const approved = await prisma.knowledgeChunk.findMany({
    where: { projectId, documentId: { in: [...documentIds] } },
    select: { documentId: true, position: true, text: true },
    orderBy: { position: "asc" },
  });
  for (const c of approved) {
    out.set(c.documentId, [...(out.get(c.documentId) ?? []), { index: c.position, text: c.text }]);
  }
  const rest = documentIds.filter((id) => !out.has(id));
  if (rest.length === 0) return out;
  const quarantined = await prisma.quarantineChunk.findMany({
    where: { projectId, documentId: { in: rest }, ord: { gte: 0 } },
    select: { documentId: true, ord: true, text: true },
    orderBy: { ord: "asc" },
  });
  for (const c of quarantined) {
    out.set(c.documentId, [...(out.get(c.documentId) ?? []), { index: c.ord, text: c.text }]);
  }
  return out;
}

/**
 * The shortest carry-over taken as one: a shorter match between one chunk's
 * end and the next one's start is more likely chance than the chunker's
 * overlap, and the chunks are kept whole either way.
 */
export const MIN_CHUNK_OVERLAP = 16;

/**
 * `texts`, consecutive chunks of one document, joined back into its text: the
 * chunker (`chunker.ts`) starts each window `overlap` characters before the
 * previous one was cut, so a chunk opens with the previous one's end, and a
 * passage longer than that overlap that straddles the cut is held whole by
 * neither. Each chunk's opening that repeats the previous chunk's end (at least
 * {@link MIN_CHUNK_OVERLAP} characters) is dropped; chunks with no such overlap
 * (a section break) are joined with a newline. Every chunk's text is still in
 * the result, contiguous.
 */
export function joinOverlappingChunks(texts: readonly string[]): string {
  let out = "";
  for (const text of texts) {
    if (out.length === 0) {
      out = text;
      continue;
    }
    const k = overlapOf(out, text);
    out = k > 0 ? out + text.slice(k) : `${out}\n${text}`;
  }
  return out;
}

/** The longest end of `prev` that `next` starts with, if at least {@link MIN_CHUNK_OVERLAP}. */
function overlapOf(prev: string, next: string): number {
  if (next.length < MIN_CHUNK_OVERLAP) return 0;
  const head = next.slice(0, MIN_CHUNK_OVERLAP);
  // Leftmost first, so the longest overlap wins.
  for (let at = prev.indexOf(head, Math.max(0, prev.length - next.length)); at !== -1;) {
    if (next.startsWith(prev.slice(at))) return prev.length - at;
    at = prev.indexOf(head, at + 1);
  }
  return 0;
}
