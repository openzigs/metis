/**
 * Canonical resolver for the API and UI base URLs in the Playwright suite.
 *
 * Background: Issue #183 — three specs ([smoke|async-platform|sdk-alignment].spec.ts)
 * hardcoded a stale `4100` default and read `E2E_API_BASE_URL` while the rest of
 * the suite (and `playwright.config.ts`) used `4101` + `E2E_API_BASE`. Centralising
 * the resolution in a single helper prevents this drift from recurring.
 *
 * The canonical port pair is **4101 (API) / 3101 (UI)**, deliberately distinct
 * from the dev stack (`4000/3000`) and the older smoke ports (`4100/3100`).
 *
 * Env var contract (highest precedence first):
 *   API:  `E2E_API_BASE`  → full URL
 *         `E2E_API_PORT`  → port only, host is `127.0.0.1`
 *         (default)       → `http://127.0.0.1:4101`
 *
 *   UI:   `E2E_BASE_URL`  → full URL
 *         `E2E_UI_PORT`   → port only, host is `127.0.0.1`
 *         (default)       → `http://127.0.0.1:3101`
 */

export const DEFAULT_API_PORT = 4101;
export const DEFAULT_UI_PORT = 3101;

/** Resolve the API base URL, e.g. `http://127.0.0.1:4101`. */
export function apiBase(): string {
  const explicit = process.env.E2E_API_BASE;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const port = Number(process.env.E2E_API_PORT) || DEFAULT_API_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Resolve the UI base URL, e.g. `http://127.0.0.1:3101`. */
export function uiBase(): string {
  const explicit = process.env.E2E_BASE_URL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  const port = Number(process.env.E2E_UI_PORT) || DEFAULT_UI_PORT;
  return `http://127.0.0.1:${port}`;
}
