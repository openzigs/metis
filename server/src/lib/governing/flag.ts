/**
 * Epic #1866 (#1868) — the governing-documents feature flag.
 *
 * Off by default: `GOVERNING_DOCS_ENABLED=1` turns it on, and nothing else does
 * (not `"true"`), the convention `SEMANTIC_CACHE_ENABLED` set
 * (`lib/ai/semantic-cache.ts`). Every governing route, job and analysis hook
 * gates on this one helper, and it stays off until a held-out reading of the
 * shipped behaviour passes (#1878). Read at call time, so a test or an
 * operator's restart sees a change without a module reload.
 */

export const GOVERNING_DOCS_ENABLED_ENV = "GOVERNING_DOCS_ENABLED";

export function isGoverningDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[GOVERNING_DOCS_ENABLED_ENV] === "1";
}
