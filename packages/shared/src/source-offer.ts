/**
 * #1296 — **the AGPL-3.0 §13 network source offer, as data.**
 *
 * §13 is the obligation with no Apache-2.0 equivalent and the one easiest to miss:
 * because METIS is offered over a network, a remote user must be given an
 * opportunity to receive the Corresponding Source *of the running version*. A
 * `LICENSE` file in the repository does not discharge that — it says nothing about
 * which commit the process in front of the user was built from.
 *
 * This module is the single definition of that offer. It is deliberately in
 * `@metis/shared` and deliberately PURE, because three surfaces have to agree on it
 * and disagreement between them is the failure mode:
 *
 *   * `server/src/routes/source.ts` serves it unauthenticated at `/source` and
 *     `/api/source`;
 *   * `ui/src/components/layout/source-offer-footer.tsx` renders it in a footer on
 *     every page, including the sign-in page;
 *   * `scripts/lib/license-metadata-core.mjs` holds the same SPDX id for the ten
 *     manifests, and its live test asserts the two never drift.
 *
 * ## Why the validation is not ceremony
 *
 * Both inputs are environment variables, and both end up inside an `href` the
 * browser will follow. An unvalidated commit interpolated into a URL turns a build
 * variable into a link target; an unvalidated repository URL turns one into a
 * scheme. So a commit must be a bare hex sha and a repository must be an absolute
 * `https:` URL, and anything else is refused *before* interpolation rather than
 * escaped afterwards. Refusal degrades the offer — repository instead of commit —
 * which is the right direction: §13 is better served by a link to the project than
 * by no link at all.
 *
 * ## Why precedence is over valid values, not over set-ness
 *
 * `METIS_SOURCE_COMMIT` wins when it holds a sha. When it holds `$GIT_SHA` — a
 * template that never expanded, which is how this variable is usually got wrong —
 * the next variable is tried. Stopping at the first *set* variable would let one
 * unexpanded template delete the commit from a deployment where `GIT_COMMIT` was
 * right all along.
 */

/** SPDX identifier of the outbound licence. `-only`, never `-or-later` (#1296). */
export const OUTBOUND_LICENSE_ID = "AGPL-3.0-only";

/** Human-readable name for the same licence, for UI copy. */
export const OUTBOUND_LICENSE_NAME = "GNU Affero General Public License v3.0 only";

/** Canonical location of the licence text. */
export const OUTBOUND_LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

/**
 * Where the unmodified source lives. A deployment of a MODIFIED METIS must point
 * {@link SOURCE_REPOSITORY_ENV_VAR} at its own repository — §13 obliges it to offer
 * *its* Corresponding Source, not ours.
 */
export const DEFAULT_SOURCE_REPOSITORY_URL = "https://github.com/openzigs/metis";

/** Environment variables consulted for the deployed commit, in precedence order. */
export const SOURCE_COMMIT_ENV_VARS = [
  "METIS_SOURCE_COMMIT",
  "GIT_COMMIT",
  "SOURCE_COMMIT",
] as const;

/** Environment variable that overrides {@link DEFAULT_SOURCE_REPOSITORY_URL}. */
export const SOURCE_REPOSITORY_ENV_VAR = "METIS_SOURCE_REPOSITORY_URL";

/** Length an abbreviated sha is displayed at — git's own default. */
const SHORT_COMMIT_LENGTH = 7;

/**
 * A bare hex sha, 7 to 40 characters. Anchored at both ends so nothing can ride
 * along behind a valid prefix (`<sha>-dirty`, `<sha>" onmouseover=`).
 */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * An absolute `https:` URL: one or more hostname labels, an optional port, and
 * optional path segments drawn from RFC 3986's unreserved and sub-delim sets.
 *
 * A regex rather than `new URL`, because `@metis/shared` compiles against
 * `lib: ["ES2023"]` with neither DOM nor Node types — `URL` is not in scope, and
 * widening the lib for one validator would pull browser globals into a package the
 * server imports. The character set is the security-relevant part: `<`, `>`, `"`,
 * `'`, backslash, whitespace and control characters cannot appear, so a value that
 * passes cannot break out of an `href` attribute or carry markup.
 */
const REPOSITORY_URL_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?(?:\/[a-z0-9._~%!$&'()*+,;=:@-]+)*\/?$/i;

/** The §13 offer, as a serialisable document. */
export interface SourceOffer {
  /** SPDX identifier — always {@link OUTBOUND_LICENSE_ID}. */
  readonly license: string;
  /** Human-readable licence name. */
  readonly licenseName: string;
  /** Canonical URL of the licence text. */
  readonly licenseUrl: string;
  /** Repository holding the Corresponding Source. Always an absolute https URL. */
  readonly repositoryUrl: string;
  /** The deployed commit, lowercased, or `null` when the environment did not say. */
  readonly commit: string | null;
  /** {@link commit} abbreviated for display, or `null`. */
  readonly commitShort: string | null;
  /** Tree URL for {@link commit}, or `null` when the commit is unknown. */
  readonly commitUrl: string | null;
  /** Source archive URL for {@link commit}, or `null` when the commit is unknown. */
  readonly archiveUrl: string | null;
  /**
   * The one URL a single link should target: the commit when known, the repository
   * otherwise. Always an absolute https URL, so a caller may use it as an `href`
   * without re-checking the scheme.
   */
  readonly sourceUrl: string;
  /** Whether {@link commit} is known — cheaper for a template than a null check. */
  readonly commitKnown: boolean;
}

/** The subset of an environment this module reads. */
export type SourceOfferEnv = Readonly<Record<string, string | undefined>>;

/**
 * Reduce a raw environment value to a commit sha, or `null` if it is not one.
 *
 * @param raw value as the environment supplied it
 * @returns a lowercase hex sha of 7-40 characters, or `null`
 */
export function normalizeSourceCommit(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!COMMIT_PATTERN.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

/**
 * Reduce a raw environment value to a repository URL, or `null` if it is not a
 * usable one.
 *
 * `https:` only. Plaintext `http:` is refused rather than upgraded: a source offer
 * served over a tamperable transport is not much of an offer, and rewriting an
 * operator's scheme behind their back hides the misconfiguration instead of
 * surfacing it. A trailing `/` or `.git` is stripped so the derived tree and
 * archive URLs resolve.
 *
 * @param raw value as the environment supplied it
 * @returns an absolute https URL with no trailing slash or `.git`, or `null`
 */
export function normalizeSourceRepositoryUrl(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (!REPOSITORY_URL_PATTERN.test(trimmed)) return null;

  // Always non-empty: anything matching the pattern retains its `https://host`
  // prefix, which neither strip can reach. No emptiness guard, because there is no
  // input that would reach one.
  return trimmed.replace(/\/+$/, "").replace(/\.git$/i, "");
}

/**
 * Abbreviate a sha for display.
 *
 * @param commit a normalized commit, or `null`
 * @returns the first seven characters, the whole sha if it is already shorter, or
 *   `null` when the commit is unknown
 */
export function shortenSourceCommit(commit: string | null): string | null {
  if (commit === null) return null;
  return commit.slice(0, SHORT_COMMIT_LENGTH);
}

/**
 * Read the deployed commit from an environment.
 *
 * @param env environment to read
 * @returns the first variable in {@link SOURCE_COMMIT_ENV_VARS} holding a valid
 *   sha, or `null` when none does
 */
function readCommit(env: SourceOfferEnv): string | null {
  for (const name of SOURCE_COMMIT_ENV_VARS) {
    const candidate = normalizeSourceCommit(env[name]);
    if (candidate !== null) return candidate;
  }
  return null;
}

/**
 * Build the §13 source offer for this process.
 *
 * The environment is a REQUIRED parameter, not a `process.env` default. Two reasons,
 * and the second is the load-bearing one: every test then supplies its own
 * environment and none can pass by accident off the ambient one; and `@metis/shared`
 * is bundled into the browser, where `process` does not exist and its own tsconfig
 * declares no Node types — a `process.env` default here does not compile, which is
 * the type system telling the truth about where this code runs. The server passes
 * `process.env`; the UI passes the `NEXT_PUBLIC_*` values Next.js inlined at build.
 *
 * @param env environment to read
 * @returns a complete offer, never partially populated and never throwing
 */
export function buildSourceOffer(env: SourceOfferEnv): SourceOffer {
  const repositoryUrl =
    normalizeSourceRepositoryUrl(env[SOURCE_REPOSITORY_ENV_VAR]) ?? DEFAULT_SOURCE_REPOSITORY_URL;
  const commit = readCommit(env);
  const commitUrl = commit === null ? null : `${repositoryUrl}/tree/${commit}`;

  return {
    license: OUTBOUND_LICENSE_ID,
    licenseName: OUTBOUND_LICENSE_NAME,
    licenseUrl: OUTBOUND_LICENSE_URL,
    repositoryUrl,
    commit,
    commitShort: shortenSourceCommit(commit),
    commitUrl,
    archiveUrl: commit === null ? null : `${repositoryUrl}/archive/${commit}.tar.gz`,
    sourceUrl: commitUrl ?? repositoryUrl,
    commitKnown: commit !== null,
  };
}

/**
 * Re-derive an offer from a document that claims to be one — used by the UI footer on
 * the JSON it fetched from `/api/source`.
 *
 * This deliberately reads **only** `commit` and `repositoryUrl` from the document and
 * rebuilds every other field with {@link buildSourceOffer}. A document whose
 * `sourceUrl` disagrees with its own `commit` therefore cannot influence the rendered
 * link at all — the link is recomputed, not trusted. That closes the case where
 * something between the browser and the server (a proxy, a captive portal, a
 * misrouted `/api/*` handler) returns a well-shaped body with a hostile `href` in it,
 * without the footer needing to know how to escape one.
 *
 * @param value parsed JSON of unknown shape
 * @returns a rebuilt offer, or `null` when the value is not an object
 */
export function parseSourceOffer(value: unknown): SourceOffer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const commit = typeof record.commit === "string" ? record.commit : undefined;
  const repositoryUrl = typeof record.repositoryUrl === "string" ? record.repositoryUrl : undefined;

  return buildSourceOffer({
    METIS_SOURCE_COMMIT: commit,
    [SOURCE_REPOSITORY_ENV_VAR]: repositoryUrl,
  });
}
