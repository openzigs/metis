import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PREPARED_MARKER,
  apiServerCommand,
  assertStackPrepared,
  prepareStack,
  resolveStackPaths,
  uiServerCommand,
} from "./e2e-stack.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("resolveStackPaths", () => {
  it("defaults to e2e/test-results/stack-data under the repo root", () => {
    const paths = resolveStackPaths("/repo", {});
    expect(paths.dataRoot).toBe(path.resolve("/repo/e2e/test-results/stack-data"));
    expect(paths.dbFile).toBe(path.join(paths.dataRoot, "metis-e2e.db"));
    expect(paths.uploadsDir).toBe(path.join(paths.dataRoot, "uploads"));
    expect(paths.lanceDir).toBe(path.join(paths.dataRoot, "lancedb"));
    expect(paths.marker).toBe(path.join(paths.dataRoot, PREPARED_MARKER));
    expect(paths.databaseUrl).toBe(`file:${paths.dbFile}`);
  });

  it("honours E2E_DATA_DIR and makes a relative value absolute", () => {
    expect(resolveStackPaths("/repo", { E2E_DATA_DIR: "/abs/data" }).dataRoot).toBe(
      path.resolve("/abs/data"),
    );
    const rel = resolveStackPaths("/repo", { E2E_DATA_DIR: "rel/data" }).dataRoot;
    expect(path.isAbsolute(rel)).toBe(true);
    expect(rel).toBe(path.resolve("rel/data"));
  });
});

describe("prepareStack / assertStackPrepared", () => {
  /** @type {string} */
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "e2e-stack-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A migrate stub that creates the SQLite file, as `prisma migrate deploy` does. */
  const fakeMigrate = (/** @type {string[]} */ calls) => (/** @type {string} */ url) => {
    calls.push(url);
    writeFileSync(url.slice("file:".length), "");
  };

  it("wipes stale state, recreates the dirs, migrates, then writes the marker", () => {
    const paths = resolveStackPaths(tmp, { E2E_DATA_DIR: path.join(tmp, "data") });
    mkdirSync(paths.dataRoot, { recursive: true });
    const stale = path.join(paths.dataRoot, "stale.db");
    writeFileSync(stale, "old run");

    /** @type {string[]} */
    const calls = [];
    /** @type {boolean[]} */
    const markerSeenDuringMigrate = [];
    prepareStack(paths, {
      migrate: (url) => {
        // The data dirs exist before migrate runs, and the marker does not.
        expect(existsSync(paths.uploadsDir)).toBe(true);
        expect(existsSync(paths.lanceDir)).toBe(true);
        markerSeenDuringMigrate.push(existsSync(paths.marker));
        fakeMigrate(calls)(url);
      },
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    });

    expect(existsSync(stale)).toBe(false);
    expect(calls).toEqual([paths.databaseUrl]);
    expect(markerSeenDuringMigrate).toEqual([false]);
    expect(JSON.parse(readFileSync(paths.marker, "utf8"))).toEqual({
      preparedAt: "2026-09-29T00:00:00.000Z",
      dbFile: paths.dbFile,
    });
    expect(() => assertStackPrepared(paths)).not.toThrow();
  });

  it("throws and writes no marker when migrate leaves no database", () => {
    const paths = resolveStackPaths(tmp, { E2E_DATA_DIR: path.join(tmp, "data") });
    expect(() => prepareStack(paths, { migrate: () => {} })).toThrow(/expected SQLite database/);
    expect(existsSync(paths.marker)).toBe(false);
  });

  it("stamps the marker with the real clock when no clock is injected", () => {
    const paths = resolveStackPaths(tmp, { E2E_DATA_DIR: path.join(tmp, "data") });
    prepareStack(paths, { migrate: fakeMigrate([]) });
    const { preparedAt } = JSON.parse(readFileSync(paths.marker, "utf8"));
    expect(Number.isNaN(Date.parse(preparedAt))).toBe(false);
  });

  it("assertStackPrepared names #323 when the stack was never prepared", () => {
    const paths = resolveStackPaths(tmp, { E2E_DATA_DIR: path.join(tmp, "data") });
    expect(() => assertStackPrepared(paths)).toThrow(/#323/);
  });
});

describe("web server commands", () => {
  it("API: prepares the data root before the server starts, and only on success", () => {
    const cmd = apiServerCommand();
    const prep = cmd.indexOf("node scripts/prepare-e2e-stack.mjs");
    const boot = cmd.indexOf("tsx src/index.ts");
    expect(prep).toBe(0);
    expect(boot).toBeGreaterThan(prep);
    expect(cmd.slice(prep, boot)).toMatch(/&&/);
    expect(cmd).not.toMatch(/;|\|\|/);
  });

  it("UI: serves a webpack production build, never a dev compiler (#342)", () => {
    const cmd = uiServerCommand(3999);
    expect(cmd).toBe(
      "pnpm --filter @metis/ui exec next build --webpack && " +
        "pnpm --filter @metis/ui exec next start -p 3999",
    );
    // Neither Turbopack nor any `next dev` compiler runs during the suite.
    expect(cmd).not.toMatch(/next dev|--turbo/);
  });

  it("the runner the API command names exists", () => {
    expect(existsSync(path.join(REPO_ROOT, "scripts", "prepare-e2e-stack.mjs"))).toBe(true);
  });

  it("playwright.config.ts builds both web servers from these helpers", () => {
    const config = readFileSync(path.join(REPO_ROOT, "e2e", "playwright.config.ts"), "utf8");
    expect(config).toMatch(/command:\s*apiServerCommand\(\)/);
    expect(config).toMatch(/command:\s*uiServerCommand\(PORT_UI\)/);
    expect(config).not.toMatch(/exec next dev/);
  });

  it("global-setup.ts asserts the stack was prepared and no longer resets it", () => {
    const setup = readFileSync(path.join(REPO_ROOT, "e2e", "global-setup.ts"), "utf8");
    expect(setup).toMatch(/assertStackPrepared\(/);
    expect(setup).not.toMatch(/rmSync|migrate deploy/);
  });
});

/**
 * #332 — the e2e stack set INGEST_QUEUE=off and specs described ingest as
 * synchronous, but no server code reads that variable: every e2e upload is
 * queued. Fail if the e2e harness cites it again while the server ignores it.
 */
describe("INGEST_QUEUE (#332)", () => {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", "test-results", "playwright-report", ".next"].includes(entry.name)) {
        return [];
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
    });
  const citing = (/** @type {string} */ dir) =>
    walk(path.join(REPO_ROOT, dir))
      .filter((file) => readFileSync(file, "utf8").includes("INGEST_QUEUE"))
      .map((file) => path.relative(REPO_ROOT, file));

  it("is not cited by the e2e harness unless the server reads it", () => {
    // Guard the walker itself: an empty scan would pass vacuously.
    expect(walk(path.join(REPO_ROOT, "e2e")).length).toBeGreaterThan(10);
    expect(walk(path.join(REPO_ROOT, "server/src")).length).toBeGreaterThan(10);
    const serverReads = citing("server/src").length > 0;
    if (serverReads) return;
    expect([...citing("e2e"), ...citing("server/scripts")]).toEqual([]);
  });
});
