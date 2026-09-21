/**
 * Dev-file classifier — Epic #701 / Issue #702.
 *
 * Identifies files whose contents are conventionally treated as
 * "development environment" — and therefore where committed database
 * credentials are intentional and safe to surface to operators inside
 * Metis (still vault-stored, still audit-logged, still opt-in per project).
 *
 * SECURITY: When in doubt, return `isDevFile: false`. The classifier is
 * an *allow* list, not a *deny* list — production-pattern names are
 * excluded *explicitly* and ambiguous names (`application.properties`,
 * bare `.env`) fall through to the safe default. Callers must combine
 * this with the `Project.allowCredentialScan` opt-in flag before
 * extracting credentials.
 */

/**
 * Explicit production-pattern filenames whose credentials must NEVER be
 * surfaced, even when callers opt in. Matched against the basename.
 */
const PROD_FILENAMES = new Set<string>([
  "application-prod.properties",
  "application-prod.yml",
  "application-prod.yaml",
  "application-production.properties",
  "application-production.yml",
  "application-production.yaml",
  ".env.production",
  ".env.prod",
  "docker-compose.prod.yml",
  "docker-compose.prod.yaml",
  "docker-compose.production.yml",
  "docker-compose.production.yaml",
]);

/**
 * Exact dev-pattern filenames whose committed credentials are conventionally
 * treated as development-environment secrets.
 */
const DEV_FILENAMES = new Set<string>([
  "docker-compose.yml",
  "docker-compose.yaml",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.dev.yml",
  "docker-compose.dev.yaml",
  "application-dev.properties",
  "application-dev.yml",
  "application-dev.yaml",
  "application-local.properties",
  "application-local.yml",
  "application-local.yaml",
  "application-test.properties",
  "application-test.yml",
  "application-test.yaml",
  ".env.local",
  ".env.development",
  ".env.dev",
  ".env.test",
]);

/**
 * Path-segment dev marker — matches anything that contains a `dev`, `local`,
 * `test`, or `development` token bounded by word characters.
 *
 * The classifier inspects the *full path*, not just the basename, so files
 * nested under e.g. `src/test/resources/datasource.properties` are also
 * treated as dev artefacts.
 *
 * SECURITY: `staging` is intentionally NOT treated as a dev marker.
 * Staging environments often share production credentials, and surfacing
 * `application-staging.properties` / `.env.staging` / `config/staging/*`
 * passwords through the same UI affordance as dev would be an OWASP
 * A02/A04 hazard. Staging-pathed files fall through to the safe default
 * (isDevFile: false) unless a team explicitly opts in via project config.
 */
const DEV_PATH_SEGMENT = /\b(dev|local|test|development)\b/i;

/**
 * Path-segment prod marker — short-circuits the path-segment check below so
 * that a file under `config/production/application.properties` is NOT
 * eligible for credential extraction even if the basename is ambiguous.
 */
const PROD_PATH_SEGMENT = /\b(prod|production)\b/i;

export interface ClassifyResult {
  isDevFile: boolean;
  reason: string;
}

/**
 * Classify a file path as dev / non-dev. Pure function — no I/O, no side
 * effects. Path may be relative or absolute; only the segments matter.
 */
export function classifyDevFile(filePath: string): ClassifyResult {
  // Normalise separators so callers can pass either Windows or POSIX paths.
  const normalised = filePath.replace(/\\/g, "/");
  const basename = normalised.slice(normalised.lastIndexOf("/") + 1);
  const basenameLower = basename.toLowerCase();

  // 1. Explicit prod allowlist always wins — even if a parent directory
  //    happens to contain the word "dev".
  if (PROD_FILENAMES.has(basenameLower)) {
    return { isDevFile: false, reason: `production-pattern filename '${basename}'` };
  }

  // 2. Explicit dev allowlist.
  if (DEV_FILENAMES.has(basenameLower)) {
    return { isDevFile: true, reason: `dev-pattern filename '${basename}'` };
  }

  // 3. Path-segment heuristic. If any segment of the path is a prod
  //    marker, refuse — even if the path also contains a dev marker
  //    somewhere else.
  if (PROD_PATH_SEGMENT.test(normalised)) {
    return { isDevFile: false, reason: "production-pattern path segment" };
  }

  if (DEV_PATH_SEGMENT.test(normalised)) {
    return { isDevFile: true, reason: "dev-pattern path segment" };
  }

  // 4. Safe default — ambiguous filenames (bare `.env`,
  //    `application.properties`, `application.yml`) do NOT permit
  //    credential extraction.
  return { isDevFile: false, reason: "no dev marker" };
}
