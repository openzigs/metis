/**
 * Stable server-package-root resolution.
 *
 * Several on-disk data directories (`data/repo-clones`, `data/lancedb`,
 * `data/uploads`, etc.) default to a path joined onto `process.cwd()`, and
 * their env-var overrides (e.g. `REPO_CLONE_DIR=./data/repo-clones`) are
 * relative too. `process.cwd()` is NOT stable across every invocation context
 * in this codebase (scripts, CLIs, and workers can be launched from the repo
 * root, from `server/`, or even from inside `server/data/...` itself), so a
 * relative default/override silently resolves to a different absolute path
 * depending on who resolves it — producing duplicated/nested directories like
 * `server/data/repo-clones/server/data/repo-clones/<id>` instead of one
 * consistent tree.
 *
 * `resolveServerRoot()` anchors to the location of THIS compiled/transpiled
 * file instead, which is invariant to the caller's cwd: in a packaged build it
 * lives under `dist/lib/`, in `tsx` dev under `src/lib/` — either way that's
 * two directories below the `server/` package root.
 *
 * Mirrors the equivalent local helper in `lib/db/migration-guard.ts`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveServerRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // This file lives at `<serverRoot>/src/lib/server-root.ts` (tsx dev) or
  // `<serverRoot>/dist/lib/server-root.js` (packaged build), so the server root
  // is TWO levels up from its directory:
  //   src/lib  -> ../.. = server/
  //   dist/lib -> ../.. = server/
  // Historically this used a single `..`, which yielded `server/src` (dev) and
  // `server/dist` (build). That silently relocated every `resolveDataDir()`
  // consumer -- most visibly `REPO_CLONE_DIR`, so ingest cloned into
  // `server/src/data/repo-clones/<id>` while every cwd-relative reader looked in
  // `server/data/repo-clones/<id>` and found nothing.
  return path.resolve(here, "..", "..");
}

/**
 * Resolve a `data/<name>` directory anchored to the server root, honoring an
 * optional env-var override. A RELATIVE override is resolved against the
 * server root (not `process.cwd()`) so it can never drift; an ABSOLUTE
 * override is used as-is.
 */
export function resolveDataDir(envValue: string | undefined, ...defaultSegments: string[]): string {
  const raw = envValue?.trim();
  if (raw) return path.resolve(resolveServerRoot(), raw);
  return path.resolve(resolveServerRoot(), "data", ...defaultSegments);
}
