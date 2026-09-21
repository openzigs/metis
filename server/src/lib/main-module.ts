/**
 * "Was this ESM module run directly, or imported?" — done so it also works on
 * Windows (#785).
 *
 * The idiom this replaces, used by `scripts/prefetch-embeddings-model.ts`:
 *
 * ```ts
 * import.meta.url === new URL(`file://${process.argv[1]}`).href
 * ```
 *
 * On POSIX that is fine. On Windows `process.argv[1]` is a backslashed drive
 * path (`C:\Users\dev\metis\server\scripts\prefetch-embeddings-model.ts`), and
 * hand-splicing it after `file://` leans on the WHATWG URL parser's special-case
 * handling of `file:` URLs. That mostly works — and "mostly" is the problem,
 * because the three ways it does NOT work all fail the same silent way:
 *
 *   - **`#` or `?` in the path.** `new URL("file://C:\proj#1\x.ts")` parses `#1\x.ts`
 *     as a FRAGMENT, yielding `file:///C:/proj#1\x.ts`. A repo cloned under
 *     `C:\proj#1\` therefore never matches.
 *   - **A literal `%` in the path.** `C:\pct%20dir\` round-trips as an already-decoded
 *     `%20`, where `import.meta.url` carries the encoded `%2520`. No match.
 *   - **Drive-letter case.** `c:\...` vs `C:\...` produce different hrefs, and
 *     `import.meta.url` is not guaranteed to agree with whatever cased argv the
 *     shell handed us.
 *
 * The failure mode is what makes this worth fixing rather than tolerating: when
 * the guard is false, the script **imports cleanly, runs nothing, and exits 0**.
 * A Windows dev on a corp network runs `pnpm prefetch:embeddings` to populate the
 * HF cache before going offline, sees a clean exit, and discovers at the next
 * `HF_HUB_OFFLINE=1` boot that no weights were ever downloaded. A prefetch that
 * silently no-ops is worse than one that crashes.
 *
 * `node:url`'s `pathToFileURL` is the documented, platform-correct inverse of
 * `fileURLToPath` and percent-encodes `#`, `?` and `%` properly. We layer one
 * normalization on top: uppercase a leading drive letter, so `c:` and `C:` compare
 * equal.
 */
import { pathToFileURL } from "node:url";

/** Injection seam — `pathToFileURL` is platform-dependent and cannot be exercised
 *  for win32 while running on macOS/Linux, so tests substitute a win32-shaped one. */
export type FileUrlConverter = (p: string) => { href: string };

/**
 * Canonicalize a `file:` href for comparison.
 *
 * Uppercases a leading Windows drive letter (`file:///c:/…` → `file:///C:/…`).
 * Node emits an uppercase drive in `import.meta.url`, but `pathToFileURL` faithfully
 * preserves whatever case it was handed, so the two can disagree on nothing but a
 * letter's case. Everything else is left exactly as-is — in particular the path is
 * NOT lowercased, because Windows paths are case-INsensitive but the percent-encoding
 * of a path is not, and a blanket lowercase would break a repo under `C:\Src\Metis`.
 */
export function normalizeFileUrl(href: string): string {
  return href.replace(
    /^(file:\/\/\/)([a-z])(:|%3a)/i,
    (_m, prefix: string, drive: string, colon: string) =>
      `${prefix}${drive.toUpperCase()}${colon.toLowerCase() === "%3a" ? "%3A" : ":"}`,
  );
}

/**
 * True when `importMetaUrl` names the file Node was launched with.
 *
 * @param importMetaUrl `import.meta.url` from the calling module.
 * @param argv1 `process.argv[1]` — the entry script. `undefined` (e.g. `node -e`)
 *              is never a match.
 */
export function isMainModule(
  importMetaUrl: string,
  argv1: string | undefined = process.argv[1],
  toFileUrl: FileUrlConverter = pathToFileURL,
): boolean {
  if (!argv1) return false;
  let entryHref: string;
  try {
    entryHref = toFileUrl(argv1).href;
  } catch {
    // A path `pathToFileURL` refuses is definitionally not the module we are in.
    return false;
  }
  return normalizeFileUrl(entryHref) === normalizeFileUrl(importMetaUrl);
}
