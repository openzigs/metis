import { describe, expect, it } from "vitest";

import {
  auditOwnership,
  extractPnpmCommands,
  resolvePnpmTest,
  shellWords,
  splitJobs,
  testOwnership,
} from "./ci-test-ownership-core.mjs";

/** A small monorepo shaped like this one: the root's `test` fans out recursively. */
const PACKAGES = [
  { name: "root", dir: ".", hasTest: true, testScript: "pnpm -r --filter '!@x/e2e' run test" },
  { name: "@x/server", dir: "server", hasTest: true },
  { name: "@x/ui", dir: "ui", hasTest: true },
  { name: "@x/shared", dir: "packages/shared", hasTest: true },
  { name: "@x/e2e", dir: "e2e", hasTest: true },
  { name: "@x/docs", dir: "docs", hasTest: false },
];

describe("shellWords", () => {
  it("keeps quoted filters as one word without their quotes", () => {
    expect(shellWords(`pnpm -r --filter '!@x/ui' --filter "!@x/e2e" run test`)).toEqual([
      "pnpm",
      "-r",
      "--filter",
      "!@x/ui",
      "--filter",
      "!@x/e2e",
      "run",
      "test",
    ]);
  });
});

describe("resolvePnpmTest", () => {
  it("a bare `pnpm test` in a package directory runs that package", () => {
    expect(resolvePnpmTest("pnpm test", "ui", PACKAGES)).toEqual(["@x/ui"]);
    expect(resolvePnpmTest("pnpm run test", "server", PACKAGES)).toEqual(["@x/server"]);
  });

  it("a bare `pnpm test` at the root expands the root's recursive script", () => {
    expect(resolvePnpmTest("pnpm test", ".", PACKAGES)).toEqual([
      "@x/server",
      "@x/shared",
      "@x/ui",
    ]);
  });

  it("only-negative filters typed at the root select the ROOT too, which re-runs everything", () => {
    // The trap measured on #4: without `!root`, the root's own `test` script runs.
    expect(
      resolvePnpmTest("pnpm -r --filter '!@x/ui' --filter '!@x/server' run test", ".", PACKAGES),
    ).toEqual(["@x/e2e", "@x/server", "@x/shared", "@x/ui"]);
    expect(
      resolvePnpmTest(
        "pnpm -r --filter '!root' --filter '!@x/ui' --filter '!@x/server' run test",
        ".",
        PACKAGES,
      ),
    ).toEqual(["@x/e2e", "@x/shared"]);
  });

  it("positive filters select only what they name, by name or ./dir", () => {
    expect(resolvePnpmTest("pnpm --filter @x/shared test", ".", PACKAGES)).toEqual(["@x/shared"]);
    expect(resolvePnpmTest("pnpm --filter=./server run test", ".", PACKAGES)).toEqual([
      "@x/server",
    ]);
    expect(resolvePnpmTest("pnpm -F @x/ui -F @x/shared test", ".", PACKAGES)).toEqual([
      "@x/shared",
      "@x/ui",
    ]);
  });

  it("negative filters subtract from positive ones", () => {
    expect(
      resolvePnpmTest("pnpm -r --filter ./server --filter '!@x/server' test", ".", PACKAGES),
    ).toEqual([]);
  });

  it("bare -r starts from every package", () => {
    expect(resolvePnpmTest("pnpm --recursive --filter '!root' run test", ".", PACKAGES)).toEqual([
      "@x/e2e",
      "@x/server",
      "@x/shared",
      "@x/ui",
    ]);
  });

  it("skips packages with no test script", () => {
    expect(resolvePnpmTest("pnpm --filter ./docs test", ".", PACKAGES)).toEqual([]);
  });

  it.each([
    "pnpm exec vitest run src/a.test.ts",
    "pnpm test:integration prisma-postgres-connection",
    "pnpm install --frozen-lockfile --prod=false",
    "pnpm --filter @x/e2e exec playwright test a.spec.ts",
    "pnpm lint",
    "npm test",
  ])("%s is not a full unit-suite run", (cmd) => {
    expect(resolvePnpmTest(cmd, "server", PACKAGES)).toEqual([]);
  });

  it("fails loudly on a bare `pnpm test` in a directory that is not a package", () => {
    expect(() => resolvePnpmTest("pnpm test", "nowhere", PACKAGES)).toThrow(
      /no workspace package at nowhere/,
    );
  });

  it("refuses a root script that recurses into itself forever", () => {
    const loop = [{ name: "root", dir: ".", hasTest: true, testScript: "pnpm test" }];
    expect(() => resolvePnpmTest("pnpm test", ".", loop, 5)).toThrow(/recursion too deep/);
  });
});

const WORKFLOW = `name: CI
on: push
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Test
        run: pnpm -r --filter '!root' --filter '!@x/ui' --filter '!@x/server' --filter '!@x/e2e' run test
  ui:
    runs-on: ubuntu-latest
    steps:
      - name: Test UI
        working-directory: ui
        run: pnpm test
  server:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: server
    steps:
      - name: Test server
        run: |
          echo start
          pnpm test && echo done
  pg:
    runs-on: ubuntu-latest
    steps:
      - name: Unit suite on the pg client
        working-directory: server
        run: >-
          pnpm test
      - name: Integration
        working-directory: server
        run: pnpm test:integration x
  e2e:
    runs-on: ubuntu-latest
    steps:
      - name: Playwright
        run: pnpm --filter @x/e2e test --reporter=list
other: {}
`;

describe("splitJobs / extractPnpmCommands", () => {
  it("finds every job under jobs:, and stops at the next top-level key", () => {
    expect([...splitJobs(WORKFLOW).keys()]).toEqual(["api", "ui", "server", "pg", "e2e"]);
    expect(splitJobs("name: x\n").size).toBe(0);
  });

  it("reads inline and block runs, step and job-default working directories", () => {
    const jobs = splitJobs(WORKFLOW);
    expect(extractPnpmCommands("ui", jobs.get("ui") ?? [])).toEqual([
      { job: "ui", step: "Test UI", dir: "ui", command: "pnpm test" },
    ]);
    expect(extractPnpmCommands("server", jobs.get("server") ?? [])).toEqual([
      { job: "server", step: "Test server", dir: "server", command: "pnpm test" },
    ]);
    expect(extractPnpmCommands("pg", jobs.get("pg") ?? []).map((c) => c.command)).toEqual([
      "pnpm test",
      "pnpm test:integration x",
    ]);
  });
});

describe("testOwnership + auditOwnership", () => {
  it("maps each package to the jobs that run its full suite", () => {
    const owners = testOwnership(WORKFLOW, PACKAGES);
    expect(Object.fromEntries(owners)).toEqual({
      "@x/server": ["server", "pg"],
      "@x/ui": ["ui"],
      "@x/shared": ["api"],
      "@x/e2e": ["e2e"],
    });
    expect(auditOwnership(owners, { pg: ["@x/server"] })).toEqual([]);
  });

  it("reports a suite that runs in two default-configuration jobs", () => {
    const dup = WORKFLOW.replace("--filter '!@x/ui' ", "");
    expect(auditOwnership(testOwnership(dup, PACKAGES), { pg: ["@x/server"] })).toEqual([
      "@x/ui: unit suite runs in 2 jobs (api, ui)",
    ]);
  });

  it("reports a suite that no job runs — the silent coverage hole", () => {
    const gone = WORKFLOW.replace("          pnpm test && echo done", "          echo nothing");
    expect(auditOwnership(testOwnership(gone, PACKAGES), { pg: ["@x/server"] })).toEqual([
      "@x/server: no job runs its unit suite",
    ]);
  });

  it("does not let a variant-configuration job stand in for the default run", () => {
    // Only `pg` (the Postgres client) still runs the server suite: that is a hole.
    const onlyPg = WORKFLOW.replace("          pnpm test && echo done", "          echo nothing");
    const problems = auditOwnership(testOwnership(onlyPg, PACKAGES), { pg: ["@x/server"] });
    expect(problems).toContain("@x/server: no job runs its unit suite");
  });

  it("reports a variant job that stopped running what it is declared to re-run", () => {
    const noPg = WORKFLOW.replace(
      "        run: >-\n          pnpm test\n",
      "        run: echo skipped\n",
    );
    expect(auditOwnership(testOwnership(noPg, PACKAGES), { pg: ["@x/server"] })).toEqual([
      "pg: declared to re-run @x/server under its own configuration, but does not",
    ]);
  });

  it("honours an explicit exemption", () => {
    const noE2e = WORKFLOW.replace(
      "run: pnpm --filter @x/e2e test --reporter=list",
      "run: echo off",
    );
    const owners = testOwnership(noE2e, PACKAGES);
    expect(auditOwnership(owners, { pg: ["@x/server"] })).toEqual([
      "@x/e2e: no job runs its unit suite",
    ]);
    expect(auditOwnership(owners, { pg: ["@x/server"] }, ["@x/e2e"])).toEqual([]);
  });
});
