/**
 * #2337 — server status lines still use the names of the old controls ("Deep
 * ingest complete: …", "… 45 RAG chunks.", "run Sync again"). The buttons are
 * now "Full re-read" and "Update" and the count is "sections indexed", so the
 * lines are shown in the same words. Only those names change; the rest of the
 * server's sentence is shown as written.
 */
const REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bDeep ingest\b/gi, "Full re-read"],
  [/\bRAG chunks\b/g, "sections indexed"],
  [/^Sync\b/, "Update"],
  [/\bSync again\b/g, "Update again"],
  [/\bnext Sync\b/g, "next Update"],
];

export function analystCopy(message: string): string {
  return REPLACEMENTS.reduce((text, [pattern, word]) => text.replace(pattern, word), message);
}
