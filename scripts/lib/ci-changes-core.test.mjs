import { describe, expect, it } from "vitest";

import {
  IMAGE_PATTERNS,
  POSTGRES_PATTERNS,
  classifyChanges,
  formatOutputs,
  globToRegExp,
  matchesAny,
} from "./ci-changes-core.mjs";

/**
 * #844 — the pure half of the CI path gate. `scripts/ci-changes.mjs` gathers the
 * changed paths; this module decides which conditional work runs.
 */

describe("globToRegExp", () => {
  it("matches a literal path exactly, and nothing longer or shorter", () => {
    const re = globToRegExp("pnpm-lock.yaml");
    expect(re.test("pnpm-lock.yaml")).toBe(true);
    expect(re.test("ui/pnpm-lock.yaml")).toBe(false);
    expect(re.test("pnpm-lock.yaml.bak")).toBe(false);
  });

  it("`*` stays inside one path segment", () => {
    const re = globToRegExp("Dockerfile.*");
    expect(re.test("Dockerfile.server")).toBe(true);
    expect(re.test("Dockerfile.server/x")).toBe(false);
  });

  it("`**/` spans zero or more directories", () => {
    const re = globToRegExp("**/package.json");
    expect(re.test("package.json")).toBe(true);
    expect(re.test("server/package.json")).toBe(true);
    expect(re.test("packages/shared/package.json")).toBe(true);
    expect(re.test("server/package.json.orig")).toBe(false);
  });

  it("a trailing `/**` takes everything below the directory, but not a sibling prefix", () => {
    const re = globToRegExp("server/prisma/**");
    expect(re.test("server/prisma/schema.prisma")).toBe(true);
    expect(re.test("server/prisma/postgres/migrations/1/migration.sql")).toBe(true);
    expect(re.test("server/prisma-clients/x")).toBe(false);
  });

  it("escapes regex metacharacters instead of interpreting them", () => {
    const re = globToRegExp("a+b.(c).ts");
    expect(re.test("a+b.(c).ts")).toBe(true);
    expect(re.test("aab.(c).ts")).toBe(false);
    expect(re.test("a+bx(c).ts")).toBe(false);
  });
});

describe("matchesAny", () => {
  it("returns the files that hit at least one pattern", () => {
    expect(matchesAny(["a.md", "server/prisma/x.sql"], ["server/prisma/**"])).toEqual([
      "server/prisma/x.sql",
    ]);
    expect(matchesAny(["a.md"], ["server/prisma/**"])).toEqual([]);
  });
});

describe("pinned path lists", () => {
  const pg = (/** @type {string} */ f) => matchesAny([f], POSTGRES_PATTERNS).length > 0;
  const img = (/** @type {string} */ f) => matchesAny([f], IMAGE_PATTERNS).length > 0;

  it.each([
    "server/prisma/postgres/schema.prisma",
    "server/prisma/postgres/migrations/20260101000000_x/migration.sql",
    "server/prisma/schema.prisma",
    "server/prisma.config.ts",
    "server/src/lib/prisma.ts",
    "server/src/lib/db/prisma-errors.ts",
    "server/src/lib/auth/sso-state-store-postgres.ts",
    "server/src/lib/rag/vector-store-pgvector.ts",
    "server/tests/leader-election-postgres.integration.test.ts",
    "server/vitest.config.ts",
    "server/vitest.integration.config.ts",
    "server/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".github/workflows/ci.yml",
    "scripts/ci-changes.mjs",
    "scripts/lib/ci-changes-core.mjs",
  ])("postgres-adapter runs for %s", (f) => {
    expect(pg(f)).toBe(true);
  });

  it.each([
    "README.md",
    "docs/ARCHITECTURE.md",
    "ui/app/page.tsx",
    "e2e/tests/login.spec.ts",
    "server/src/routes/projects.ts",
    ".changes/unreleased/844-ci.md",
  ])("postgres-adapter does NOT run for %s", (f) => {
    expect(pg(f)).toBe(false);
  });

  it.each([
    "Dockerfile.server",
    "Dockerfile.ui",
    "Dockerfile.embeddings",
    "Dockerfile.sql-lineage",
    ".dockerignore",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "package.json",
    "server/package.json",
    "ui/package.json",
    "packages/shared/package.json",
    "server/embeddings-svc/index.js",
    "tsconfig.base.json",
    "server/prisma/postgres/schema.prisma",
    "server/prisma.config.ts",
    "metis-sql-lineage/requirements.txt",
    "scripts/lib/verify-image-size.mjs",
    "scripts/lib/smoke-server-image.mjs",
    "scripts/lib/prune-pnpm-store.mjs",
    ".github/workflows/ci.yml",
    "scripts/ci-changes.mjs",
    "scripts/lib/ci-changes-core.mjs",
  ])("the image build runs for %s", (f) => {
    expect(img(f)).toBe(true);
  });

  it.each(["README.md", "ui/app/page.tsx", "server/src/routes/projects.ts", "e2e/x.spec.ts"])(
    "the image build does NOT run for %s",
    (f) => {
      expect(img(f)).toBe(false);
    },
  );
});

describe("classifyChanges", () => {
  const docsOnly = ["README.md", "docs/x.md"];

  it("runs everything on a push, a schedule and a manual dispatch, whatever changed", () => {
    for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
      const r = classifyChanges({ eventName, files: docsOnly, headRef: "" });
      expect({ eventName, postgres: r.postgres.run, images: r.images.run }).toEqual({
        eventName,
        postgres: true,
        images: true,
      });
      expect(r.postgres.reason).toMatch(eventName);
    }
  });

  it("skips both on a pull request that touches neither list, and says why", () => {
    const r = classifyChanges({ eventName: "pull_request", files: docsOnly, headRef: "x" });
    expect(r.postgres).toEqual({ run: false, reason: "no Postgres-relevant paths changed" });
    expect(r.images).toEqual({ run: false, reason: "no image-relevant paths changed" });
  });

  it("runs only the matching one, naming the first matched paths", () => {
    const r = classifyChanges({
      eventName: "pull_request",
      files: ["README.md", "server/src/lib/prisma.ts"],
      headRef: "x",
    });
    expect(r.postgres.run).toBe(true);
    expect(r.postgres.reason).toContain("server/src/lib/prisma.ts");
    expect(r.images.run).toBe(false);

    const i = classifyChanges({
      eventName: "pull_request",
      files: ["Dockerfile.ui"],
      headRef: "x",
    });
    expect(i.images.run).toBe(true);
    expect(i.postgres.run).toBe(false);
  });

  it("caps the listed paths in a reason so a huge diff stays readable", () => {
    const files = Array.from({ length: 12 }, (_, n) => `server/prisma/m${n}.sql`);
    const r = classifyChanges({ eventName: "pull_request", files, headRef: "x" });
    expect(r.postgres.reason).toContain("m0.sql");
    expect(r.postgres.reason).not.toContain("m5.sql");
    expect(r.postgres.reason).toContain("+7 more");
  });

  it("fails OPEN when the diff could not be computed", () => {
    const r = classifyChanges({ eventName: "pull_request", files: null, headRef: "x" });
    expect(r.postgres.run).toBe(true);
    expect(r.images.run).toBe(true);
    expect(r.postgres.reason).toMatch(/could not be computed/);
  });

  it("always builds the images on a Dependabot PR (#51), even with no matching path", () => {
    const r = classifyChanges({
      eventName: "pull_request",
      files: [".github/workflows/codeql.yml"],
      headRef: "dependabot/github_actions/foo",
    });
    expect(r.images.run).toBe(true);
    expect(r.images.reason).toMatch(/Dependabot/);
    expect(r.postgres.run).toBe(false);
  });
});

describe("formatOutputs", () => {
  it("writes GITHUB_OUTPUT lines as the literal strings the workflow compares", () => {
    const r = classifyChanges({ eventName: "pull_request", files: ["Dockerfile.ui"], headRef: "" });
    expect(formatOutputs(r)).toBe("postgres=false\nimages=true\n");
  });
});
