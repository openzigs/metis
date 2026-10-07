/**
 * #844 — which conditional CI work a change needs. Pure logic only; the I/O
 * (computing the diff, writing `$GITHUB_OUTPUT`) lives in `scripts/ci-changes.mjs`.
 *
 * Two pieces of `ci.yml` are expensive and only rarely affected by a pull request:
 *
 *  - `postgres-adapter` re-runs the whole server unit suite on the Postgres-generated
 *    Prisma client, then a set of integration suites against a real Postgres.
 *  - the `api` job's image build + size gate + container smoke.
 *
 * On a PR they run only when a path below changed. On every other event (`push` to
 * `main`, the nightly `schedule`, a manual dispatch) they always run, so anything
 * the path lists miss is caught on `main` within one merge or one night.
 *
 * Every uncertain case fails OPEN — a diff that could not be computed runs
 * everything. A gate that skips work because it could not see the change is the
 * fail-open shape this repository's gates keep being audited for.
 */

/** Shared by both lists: the gate's own definition and the dependency graph. */
const GATE_AND_DEPENDENCIES = Object.freeze([
  ".github/workflows/ci.yml",
  "scripts/ci-changes.mjs",
  "scripts/lib/ci-changes-core.mjs",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

/**
 * What `postgres-adapter` proves, and so what can change its answer:
 *  - the Postgres schema / migrations and the scheme-selected Prisma adapter;
 *  - every Postgres- or pgvector-specific module and integration suite (by name);
 *  - the test helpers those suites pull in (shared suite bodies, fixtures, the pg
 *    schema helper), and the `src/` modules imported by a suite or by one of those
 *    helpers (`ci-changes-repo.test.mjs` walks the relative imports and fails if one
 *    is not listed here);
 *  - the server's test configuration and dependency manifest.
 *
 * NOT covered on PRs: an arbitrary server unit test that starts to depend on the
 * SQLite client, and a change to a `src/` module that a listed `src/` module imports
 * in turn (the list is not transitive through `src/`). Both are caught on the next
 * `main` push or nightly run.
 */
export const POSTGRES_PATTERNS = Object.freeze([
  ...GATE_AND_DEPENDENCIES,
  "server/package.json",
  "server/prisma/**",
  "server/prisma.config.ts",
  "server/vitest.config.ts",
  "server/vitest.integration.config.ts",
  "server/src/lib/prisma.ts",
  "server/src/lib/db/**",
  "server/**/*postgres*",
  "server/**/*pgvector*",
  // Test code the integration suites import (#846 review).
  "server/tests/helpers/**",
  "server/tests/lib/pg/**",
  // Direct `../src/` imports (and `vi.mock` targets) of the server/tests/*-postgres and
  // *-pgvector integration suites.
  "server/src/lib/auth/jwt.ts",
  "server/src/lib/auth/live-auth-payload.ts",
  "server/src/lib/auth/sso-state-store.ts",
  "server/src/lib/audit/audit-service.ts",
  "server/src/lib/ai/conversation/transcript-store.ts",
  "server/src/lib/config/config-service.ts",
  "server/src/lib/config/key-registry.ts",
  "server/src/lib/connectors/connector-secret-binding.ts",
  "server/src/lib/connectors/network-allowlist.ts",
  "server/src/lib/connectors/repo/repo-service.ts",
  "server/src/lib/mcp/secret-binding.ts",
  "server/src/lib/mcp/status-rooms.ts",
  "server/src/lib/rag/embedder.ts",
  "server/src/lib/rag/knowledge-service.ts",
  "server/src/lib/rag/reindex-lease.ts",
  "server/src/lib/rag/vector-store.ts",
  "server/src/lib/requirements/requirement-version-service.ts",
  "server/src/lib/scheduler/leader-election.ts",
  "server/src/lib/socket/cluster-adapter.ts",
  "server/src/lib/socket/mcp-status-eviction.ts",
  "server/src/lib/socket/registry.ts",
  "server/src/lib/socket/user-disconnect.ts",
  "server/src/lib/vault/binding-write-mark.ts",
  "server/src/lib/vault/vault-service.ts",
  "server/src/middleware/auth.ts",
  "server/src/middleware/error-handler.ts",
  "server/src/routes/connectors.ts",
  "server/src/routes/scim.ts",
  "server/src/routes/vault.ts",
  "server/src/routes/workspaces.ts",
  // `src/` modules reached through the test helpers above.
  "server/src/lib/connectors/db/db-service.ts",
  "server/src/lib/connectors/jira/jira-service.ts",
  "server/src/lib/mcp/lifecycle-manager.ts",
  "server/src/lib/mcp/mcp-service.ts",
  "server/src/lib/socket/server.ts",
  "server/src/routes/jira.ts",
  "server/src/routes/mcp.ts",
]);

/**
 * What the image build reads beyond application source: every Dockerfile and
 * the build context filter, every workspace `package.json` (each Dockerfile
 * copies them for the install layer), the Prisma schema and config the server
 * image ships, the sidecars' own inputs, and the scripts the build, size gate
 * and smoke run.
 *
 * NOT covered on PRs: application source that breaks only inside the image (for
 * example, a new import of a package declared as a devDependency). That is caught
 * on the next `main` push or nightly run.
 */
export const IMAGE_PATTERNS = Object.freeze([
  ...GATE_AND_DEPENDENCIES,
  "Dockerfile.*",
  ".dockerignore",
  "**/package.json",
  "tsconfig.base.json",
  "server/prisma/**",
  "server/prisma.config.ts",
  "server/embeddings-svc/**",
  // Inputs that can break or bloat an image without failing typecheck (#846
  // review): the standalone output config Dockerfile.ui copies, what each
  // builder's build emits, and static assets counted by the size gate.
  "ui/next.config.*",
  "ui/public/**",
  "server/tsconfig*.json",
  "packages/shared/tsconfig*.json",
  "metis-sql-lineage/requirements*.txt",
  "scripts/lib/verify-image-size.mjs",
  "scripts/lib/smoke-server-image.mjs",
  "scripts/lib/prune-pnpm-store.mjs",
]);

/** Paths listed in a reason before the rest are summarised as "+N more". */
const REASON_PATH_LIMIT = 5;

/**
 * `*` within one path segment: classic two-pointer wildcard match with
 * backtracking to the last star. Linear-ish and regex-free on purpose — a
 * RegExp built from a pattern is a ReDoS shape Semgrep blocks, and these lists
 * need nothing a regex adds.
 *
 * @param {string} seg
 * @param {string} pat
 * @returns {boolean}
 */
function segmentMatches(seg, pat) {
  let s = 0;
  let p = 0;
  let star = -1;
  let mark = 0;
  while (s < seg.length) {
    if (p < pat.length && pat[p] !== "*" && pat[p] === seg[s]) {
      s += 1;
      p += 1;
    } else if (p < pat.length && pat[p] === "*") {
      star = p;
      mark = s;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === "*") p += 1;
  return p === pat.length;
}

/**
 * A minimal glob over `/`-separated paths: a `**` segment spans zero or more
 * directories, `*` stays inside one segment, every other character is literal.
 *
 * @param {string} file
 * @param {string} glob
 * @returns {boolean}
 */
export function matchesGlob(file, glob) {
  const f = file.split("/");
  const g = glob.split("/");
  /** @type {(i: number, j: number) => boolean} */
  const walk = (i, j) => {
    if (j === g.length) return i === f.length;
    if (g[j] === "**") {
      for (let k = i; k <= f.length; k += 1) if (walk(k, j + 1)) return true;
      return false;
    }
    return i < f.length && segmentMatches(f[i], g[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/**
 * @param {readonly string[]} files
 * @param {readonly string[]} patterns
 * @returns {string[]} the files that match at least one pattern
 */
export function matchesAny(files, patterns) {
  return files.filter((f) => patterns.some((g) => matchesGlob(f, g)));
}

/**
 * @param {string} label
 * @param {string[]} hits
 * @returns {{ run: boolean, reason: string }}
 */
function byPaths(label, hits) {
  if (hits.length === 0) return { run: false, reason: `no ${label}-relevant paths changed` };
  const shown = hits.slice(0, REASON_PATH_LIMIT).join(", ");
  const more = hits.length > REASON_PATH_LIMIT ? ` (+${hits.length - REASON_PATH_LIMIT} more)` : "";
  return { run: true, reason: `changed: ${shown}${more}` };
}

/**
 * @typedef {{ run: boolean, reason: string }} Decision
 * @typedef {{ postgres: Decision, images: Decision }} Classification
 */

/**
 * @param {{ eventName: string, files: string[] | null, headRef: string }} input
 *   `files` is null when the diff could not be computed.
 * @returns {Classification}
 */
export function classifyChanges({ eventName, files, headRef }) {
  if (eventName !== "pull_request") {
    const all = { run: true, reason: `${eventName} event: always runs` };
    return { postgres: { ...all }, images: { ...all } };
  }
  if (files === null) {
    const all = { run: true, reason: "changed paths could not be computed: running everything" };
    return { postgres: { ...all }, images: { ...all } };
  }
  const postgres = byPaths("Postgres", matchesAny(files, POSTGRES_PATTERNS));
  // #51 — a Dependabot PR always builds and smokes metis-server, whatever it bumped.
  const images = headRef.startsWith("dependabot/")
    ? { run: true, reason: "Dependabot PR: always builds metis-server (#51)" }
    : byPaths("image", matchesAny(files, IMAGE_PATTERNS));
  return { postgres, images };
}

/**
 * @param {Classification} result
 * @returns {string} `$GITHUB_OUTPUT` lines
 */
export function formatOutputs(result) {
  return `postgres=${result.postgres.run}\nimages=${result.images.run}\n`;
}
