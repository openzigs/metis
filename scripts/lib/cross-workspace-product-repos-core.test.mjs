/**
 * #1258 — the read-only cross-workspace product-repo audit. The SQL is also run
 * against the real migrated schema in
 * `server/tests/product-repo-read-access-1258.sqlite.test.ts`; this file pins
 * the selection rules, the read-only open and the runner's argument handling on
 * a minimal hand-built schema.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CROSS_WORKSPACE_PRODUCT_REPOS_SQL,
  formatReport,
  listCrossWorkspaceProductRepos,
  openReadOnly,
  parseArgs,
} from "./cross-workspace-product-repos-core.mjs";

const RUNNER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "audit-cross-workspace-product-repos.mjs",
);

const SCHEMA = `
CREATE TABLE "products" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "createdById" TEXT NOT NULL);
CREATE TABLE "projects" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "productId" TEXT);
CREATE TABLE "repo_connections" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL);
CREATE TABLE "product_repos" ("id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL, "repoConnectionId" TEXT NOT NULL);
CREATE TABLE "workspace_members" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL, "userId" TEXT NOT NULL);
`;

/**
 * alice is in ws1, mallory in ws2.
 *   P-mixed   (alice): repos in ws1 and ws2              → both rows listed
 *   P-clean   (alice): repos in ws1 only, plus legacy    → nothing listed
 *   P-bound   (alice): bound to a ws1 project, one ws2 repo → the ws2 row
 *   P-foreign (alice): a single ws2 repo, alice not in ws2 → listed
 *   P-legacy  (alice): a ws1 repo and a legacy repo       → nothing listed
 */
function seed(db) {
  db.exec(SCHEMA);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  run(`INSERT INTO "workspace_members" VALUES ('m1','ws1','alice'), ('m2','ws2','mallory')`);
  for (const [id, ws, productId] of [
    ["pa", "ws1", null],
    ["pa2", "ws1", null],
    ["pb", "ws2", null],
    ["pl", null, null],
    ["pbound", "ws1", "P-bound"],
  ]) {
    run(`INSERT INTO "projects" VALUES (?, ?, ?)`, id, ws, productId);
  }
  for (const [id, projectId] of [
    ["rc-a", "pa"],
    ["rc-a2", "pa2"],
    ["rc-b", "pb"],
    ["rc-l", "pl"],
  ]) {
    run(`INSERT INTO "repo_connections" VALUES (?, ?)`, id, projectId);
  }
  for (const id of ["P-mixed", "P-clean", "P-bound", "P-foreign", "P-legacy"]) {
    run(`INSERT INTO "products" VALUES (?, ?, 'alice')`, id, `${id} name`);
  }
  let n = 0;
  for (const [productId, rc] of [
    ["P-mixed", "rc-a"],
    ["P-mixed", "rc-b"],
    ["P-clean", "rc-a"],
    ["P-clean", "rc-a2"],
    ["P-clean", "rc-l"],
    ["P-bound", "rc-b"],
    ["P-foreign", "rc-b"],
    ["P-legacy", "rc-a"],
    ["P-legacy", "rc-l"],
  ]) {
    n += 1;
    run(`INSERT INTO "product_repos" VALUES (?, ?, ?)`, `pr-${n}`, productId, rc);
  }
}

describe("#1258 — cross-workspace product repo audit", () => {
  let dir;
  let dbPath;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-1258-"));
    dbPath = path.join(dir, "audit.db");
    const db = new DatabaseSync(dbPath);
    seed(db);
    db.close();
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists exactly the rows that cross a workspace boundary", () => {
    const db = openReadOnly(dbPath);
    try {
      const rows = listCrossWorkspaceProductRepos(db);
      expect(rows.map((r) => `${r.productId}:${r.repoConnectionId}`)).toEqual([
        "P-bound:rc-b",
        "P-foreign:rc-b",
        "P-mixed:rc-a",
        "P-mixed:rc-b",
      ]);
      const mixedB = rows.find((r) => r.productId === "P-mixed" && r.repoConnectionId === "rc-b");
      expect(mixedB).toMatchObject({
        productName: "P-mixed name",
        productCreatedById: "alice",
        repoProjectId: "pb",
        repoWorkspaceId: "ws2",
        productWorkspaceCount: 2,
        creatorIsMember: 0,
      });
      const mixedA = rows.find((r) => r.productId === "P-mixed" && r.repoConnectionId === "rc-a");
      expect(mixedA.creatorIsMember).toBe(1);
      const foreign = rows.find((r) => r.productId === "P-foreign");
      expect(foreign.productWorkspaceCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("opens the database read-only: a write is refused", () => {
    const db = openReadOnly(dbPath);
    try {
      expect(() => db.exec(`DELETE FROM "product_repos"`)).toThrow(/readonly/i);
    } finally {
      db.close();
    }
    const check = new DatabaseSync(dbPath, { readOnly: true });
    expect(check.prepare(`SELECT COUNT(*) AS n FROM "product_repos"`).get().n).toBe(9);
    check.close();
  });

  it("refuses to create a database that does not exist", () => {
    const missing = path.join(dir, "missing.db");
    expect(() => openReadOnly(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("is a single SELECT statement", () => {
    const sql = CROSS_WORKSPACE_PRODUCT_REPOS_SQL.trim();
    expect(sql.startsWith("WITH")).toBe(true);
    expect(sql).not.toMatch(/;\s*\S/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/i);
  });

  it("formats an empty and a non-empty report", () => {
    expect(formatReport([])).toBe("0 product repo attachments cross a workspace boundary.");
    const one = formatReport([
      {
        productId: "p",
        productName: "P",
        repoConnectionId: "rc",
        repoProjectId: "proj",
        repoWorkspaceId: "ws",
        productWorkspaceCount: 2,
        creatorIsMember: 0,
      },
    ]);
    expect(one).toContain("product p (P) <- repo connection rc [project proj, workspace ws]");
    expect(one).toContain("creatorIsMember=no");
    expect(one).toMatch(/1 product repo attachment crosses a workspace boundary\.$/);
    const two = formatReport([
      { productId: "p", creatorIsMember: 1 },
      { productId: "q", creatorIsMember: 1 },
    ]);
    expect(two).toContain("creatorIsMember=yes");
    expect(two).toMatch(/2 product repo attachments cross a workspace boundary\.$/);
  });

  it("parses the runner's arguments", () => {
    expect(parseArgs([])).toEqual({ db: null, sql: false, json: false, help: false });
    expect(parseArgs(["--db", "x.db", "--json"])).toEqual({
      db: "x.db",
      sql: false,
      json: true,
      help: false,
    });
    expect(parseArgs(["--sql"]).sql).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(() => parseArgs(["--db"])).toThrow(/needs a path/);
    expect(() => parseArgs(["--db", "--json"])).toThrow(/needs a path/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });

  it("runs end to end through the runner without writing", () => {
    const before = fs.statSync(dbPath).mtimeMs;
    const text = execFileSync(process.execPath, [RUNNER, "--db", dbPath], { encoding: "utf8" });
    expect(text).toContain("4 product repo attachments cross a workspace boundary.");
    const json = JSON.parse(
      execFileSync(process.execPath, [RUNNER, "--db", dbPath, "--json"], { encoding: "utf8" }),
    );
    expect(json).toHaveLength(4);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before);
    const sql = execFileSync(process.execPath, [RUNNER, "--sql"], { encoding: "utf8" });
    expect(sql.trim()).toBe(CROSS_WORKSPACE_PRODUCT_REPOS_SQL.trim());
  });

  it("exits 1 on a bad argument or an unreadable database", () => {
    for (const args of [["--bogus"], ["--db", path.join(dir, "missing.db")]]) {
      expect(() =>
        execFileSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", stdio: "pipe" }),
      ).toThrow();
    }
  });
});
