/**
 * #1069 — which upstream URL the `/api/*` catch-all proxy may request.
 *
 * Next decodes each catch-all segment, so ONE element of `path` can hold `/`,
 * `\` or `?` (`..%2F..%2Fchat%2Fstream` arrives as `"../../chat/stream"`), and
 * `new URL` then normalises the joined path to a different upstream route.
 * Two rules follow, and both are applied by the route handler:
 *
 *   1. a segment that could change the route is refused before a URL is built;
 *   2. every per-route decision (the `/auth` exclusion, the Spec Kit timeout)
 *      is made from the RESOLVED `pathname`, never from the raw segments, and
 *      a resolved path outside the upstream base is refused.
 *
 * Server-only: imported by the route handler, never by a client component.
 */

/** `.` and `..`, and the percent-encoded spellings `new URL` treats the same way. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** True for `.`, `..`, `%2e`, `.%2E` … — a segment `new URL` resolves away. */
export function isDotSegment(segment: string): boolean {
  return DOT_SEGMENT.test(segment);
}

/** C0 controls and DEL: `new URL` strips tab, CR and LF, so `".\t."` becomes `".."`. */
function hasControlCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i += 1) {
    const code = segment.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when one decoded catch-all segment could make the upstream URL name a
 * different route than the segments say: it holds a path separator (`/`, `\`),
 * starts a query or fragment (`?`, `#`), holds a control character, or is a
 * dot segment.
 */
export function isUnsafeProxySegment(segment: string): boolean {
  return /[/\\?#]/.test(segment) || hasControlCharacter(segment) || isDotSegment(segment);
}

/** The base's path without a trailing slash: `/api` for `http://host:4000/api`. */
export function upstreamBasePath(base: string): string {
  return new URL(base).pathname.replace(/\/+$/, "");
}

/**
 * The resolved path below the upstream base (`projects/p1/files` for
 * `/api/projects/p1/files`), or `null` when the URL is on another origin or
 * its path is not under `<base path>/` — `/api/` with the default base.
 */
export function pathBelowUpstreamBase(url: URL, base: string): string | null {
  const prefix = `${upstreamBasePath(base)}/`;
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(prefix)) return null;
  return url.pathname.slice(prefix.length);
}
