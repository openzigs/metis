/**
 * The global `express.json` / `urlencoded` body limit, in bytes — 10 MiB,
 * matching MAX_DOCUMENT_BYTES for upload routes. Exported so a route whose
 * schema caps a body can be tested against the real parser limit (#557).
 */
export const JSON_LIMIT_BYTES = 10 * 1024 * 1024;
