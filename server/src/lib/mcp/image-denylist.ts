/**
 * Issue #392 — MCP image denylist (defence-in-depth over the allowlist).
 *
 * The allowlist (#275) constrains *which registries* and *which paths*
 * may host an MCP image; it cannot stop an operator with a permissive
 * `MCP_IMAGE_ALLOWLIST` from registering a known-vulnerable upstream
 * tag. This module adds a denylist that rejects exact `image@version`
 * combinations published in advisories against widely-deployed MCP
 * server images.
 *
 * Wired into:
 *   - `MCPRegistryService.create()` / `update()` (validation layer)
 *   - `docker-stdio` provisioner pre-flight (so DB rows imported before
 *     a denylist update are still blocked at run time).
 *
 * Operators may opt out of an individual entry via
 * `MCP_IMAGE_DENYLIST_OVERRIDE` (CSV of `image@version` tokens). Each
 * override admission emits a WARN audit event so the bypass is visible
 * in the audit trail.
 *
 * Intentional behaviour:
 *   - Wildcard entries (`vulnerable === "*"`) require a parseable tag to
 *     match — completely untagged or digest-pinned references bypass them
 *     because the operator has either deferred pinning to runtime
 *     (`:latest`) or already pinned an immutable artefact verified
 *     out-of-band.
 *   - Non-wildcard entries deny-by-default when the supplied reference
 *     cannot be evaluated as semver (`:latest`, `:dev`, `:nightly`, or
 *     digest pin). Otherwise an attacker could bypass the deny by
 *     re-tagging `excel-mcp-server:0.1.5` as `excel-mcp-server:latest`.
 *     Operators must explicitly pin a real semver tag, pin a digest AND
 *     acknowledge it via `MCP_IMAGE_DENYLIST_OVERRIDE`, or set the
 *     override entry for the unparseable reference (e.g.
 *     `excel-mcp-server@latest`).
 *   - Matching uses `stripImageTag(image) === entry.image` OR the last
 *     `/`-separated segment so `ghcr.io/foo/excel-mcp-server:0.1.5`
 *     matches `excel-mcp-server`. Substring matches are NOT supported
 *     to avoid `excel-mcp-server-clone` shadowing.
 */
import semver from "semver";
import { stripImageTag } from "./image-allowlist.js";

export interface DenylistEntry {
  /**
   * Canonical image name. Matched against the tag-stripped full image
   * reference OR its basename (last `/`-separated segment).
   */
  image: string;
  /**
   * `node-semver` range describing vulnerable versions, or `"*"` to
   * deny every tagged version (used for advisories where the published
   * advisory does not enumerate fixed versions and the operator must
   * pin a known-good digest).
   */
  vulnerable: string;
  /** Advisory identifier surfaced in the API error and audit event. */
  cve: string;
}

/**
 * Default seed list. Sourced from the 2026 Q2 MCP advisory cluster.
 * Extending this requires a security review — coordinate with the
 * runbook in `docs/SECURITY.md` §3.5.
 */
export const DEFAULT_DENYLIST: readonly DenylistEntry[] = [
  { image: "excel-mcp-server", vulnerable: "<=0.1.7", cve: "CVE-2026-40576" },
  { image: "n8n-mcp", vulnerable: "<2.47.4", cve: "CVE-2026-39974" },
  // mcp-server-git: triple advisory cluster, no published patched range
  // — operators must pin to a known-good digest.
  { image: "mcp-server-git", vulnerable: "*", cve: "CVE-2025-68143" },
  // The TS SDK is shipped as an npm package; we still record it so a
  // wrapper image that bakes in the SDK matches by basename.
  { image: "@modelcontextprotocol/sdk", vulnerable: "*", cve: "CVE-2026-25536" },
  { image: "mcp-go", vulnerable: "*", cve: "CVE-2026-33252" },
  { image: "mcp-java", vulnerable: "<1.0.0", cve: "CVE-2026-35568" },
  { image: "mcp-inspector", vulnerable: "*", cve: "CVE-2025-49596" },
];

export interface DenyVerdict {
  cve: string;
  matchedEntry: DenylistEntry;
  /** The original image reference passed to `isImageDenied`. */
  image: string;
  /**
   * Reference portion used for override matching. Always non-null on a
   * verdict — for tagged images this is the tag (`"0.1.5"`, `"latest"`),
   * for digest-pinned images it is the digest (`"sha256:abc..."`).
   */
  version: string;
  /**
   * Why the verdict fired:
   *   - `"vulnerable_range"` — tag parsed and satisfied the entry's
   *     semver range (or wildcard).
   *   - `"unparseable_tag"` — non-wildcard entry matched but the tag
   *     (or digest) cannot be evaluated against semver, so we deny
   *     by default.
   */
  reason: "vulnerable_range" | "unparseable_tag";
}

/**
 * Extract the `:tag` portion of an image reference.
 *
 * Returns `null` for digest-pinned (`@sha256:…`) or untagged inputs
 * because in both cases we cannot evaluate a semver range.
 */
export function parseImageVersion(image: string): string | null {
  if (image.includes("@")) return null; // digest pin — skip
  const lastSlash = image.lastIndexOf("/");
  const tail = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  const colonIdx = tail.indexOf(":");
  if (colonIdx === -1) return null;
  const tag = tail.slice(colonIdx + 1);
  return tag.length > 0 ? tag : null;
}

/**
 * Extract the digest portion of an `image@digest` reference, or `null`
 * if the reference is not digest-pinned.
 */
function parseImageDigest(image: string): string | null {
  const at = image.lastIndexOf("@");
  if (at <= 0 || at === image.length - 1) return null;
  return image.slice(at + 1);
}

function imageBasename(stripped: string): string {
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}

/**
 * Returns a verdict if `image` matches a denylist entry, otherwise `null`.
 *
 * Behaviour matrix:
 *   | entry.vulnerable | input ref            | verdict                         |
 *   |------------------|----------------------|---------------------------------|
 *   | semver range     | parseable tag in rng | deny, reason=vulnerable_range   |
 *   | semver range     | parseable tag, safe  | null (allow)                    |
 *   | semver range     | unparseable tag      | deny, reason=unparseable_tag    |
 *   | semver range     | digest pin           | deny, reason=unparseable_tag    |
 *   | semver range     | untagged             | null (no ref to evaluate)       |
 *   | "*" (wildcard)   | tagged (any)         | deny, reason=vulnerable_range   |
 *   | "*" (wildcard)   | digest / untagged    | null (operator pinned artefact) |
 */
export function isImageDenied(
  image: string,
  denylist: readonly DenylistEntry[] = DEFAULT_DENYLIST,
): DenyVerdict | null {
  if (!image) return null;
  const stripped = stripImageTag(image);
  const basename = imageBasename(stripped);
  const tag = parseImageVersion(image);
  const digest = parseImageDigest(image);
  for (const entry of denylist) {
    if (entry.image !== stripped && entry.image !== basename) continue;
    if (entry.vulnerable === "*") {
      // Wildcard entries keep their conservative bypass for unpinned and
      // digest-pinned references — operators who pin a digest have
      // committed to an immutable artefact verified out-of-band.
      if (tag === null) continue;
      return {
        cve: entry.cve,
        matchedEntry: entry,
        image,
        version: tag,
        reason: "vulnerable_range",
      };
    }
    // Non-wildcard entry: deny-by-default on anything we cannot evaluate.
    if (tag === null && digest === null) continue; // truly untagged — no ref to deny
    if (tag === null && digest !== null) {
      return {
        cve: entry.cve,
        matchedEntry: entry,
        image,
        version: digest,
        reason: "unparseable_tag",
      };
    }
    // tag !== null
    const coerced = semver.coerce(tag!);
    if (!coerced) {
      return {
        cve: entry.cve,
        matchedEntry: entry,
        image,
        version: tag!,
        reason: "unparseable_tag",
      };
    }
    if (semver.satisfies(coerced, entry.vulnerable)) {
      return {
        cve: entry.cve,
        matchedEntry: entry,
        image,
        version: tag!,
        reason: "vulnerable_range",
      };
    }
  }
  return null;
}

export interface OverrideEntry {
  image: string;
  version: string;
}

/**
 * Parse `MCP_IMAGE_DENYLIST_OVERRIDE` (CSV of `image@version`).
 * Tokens without an `@` separator are silently dropped — operators
 * MUST pin both image AND version to acknowledge the bypass.
 */
export function parseOverrideCsv(csv: string | null | undefined): readonly OverrideEntry[] {
  if (!csv) return [];
  const out: OverrideEntry[] = [];
  for (const raw of csv.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const at = tok.lastIndexOf("@");
    if (at <= 0 || at === tok.length - 1) continue;
    out.push({ image: tok.slice(0, at), version: tok.slice(at + 1) });
  }
  return out;
}

/**
 * Returns `true` when `verdict.image@verdict.version` is explicitly
 * acknowledged in the operator's override list.
 */
export function isOverrideMatch(
  verdict: DenyVerdict,
  overrides: readonly OverrideEntry[],
): boolean {
  const stripped = stripImageTag(verdict.image);
  const basename = imageBasename(stripped);
  return overrides.some(
    (o) => (o.image === stripped || o.image === basename) && o.version === verdict.version,
  );
}
