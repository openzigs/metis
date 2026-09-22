import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, pruneUnreachable, runPrune } from "./prune-pnpm-store.mjs";

/**
 * Builds a miniature pnpm isolated-linker layout on disk:
 *
 *   <root>/node_modules/.pnpm/<key>/node_modules/<name>   real package dir
 *   <root>/node_modules/.pnpm/<key>/node_modules/<dep>    symlink to the dep's real dir
 *   <importer>/node_modules/<name>                         symlink to the real dir
 *
 * which is exactly the shape `pnpm install --prod` leaves in the image's
 * prod-deps stage (#34).
 */
let root: string;
let store: string;

function storeKey(name: string, version: string) {
  return `${name.replace("/", "+")}@${version}`;
}

function realDir(name: string, version: string) {
  return path.join(store, storeKey(name, version), "node_modules", name);
}

function addPackage(name: string, version: string, deps: Array<[string, string]> = []) {
  const dir = realDir(name, version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  for (const [depName, depVersion] of deps) {
    const link = path.join(store, storeKey(name, version), "node_modules", depName);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(realDir(depName, depVersion), link, "dir");
  }
}

function link(importerDir: string, name: string, version: string) {
  const l = path.join(importerDir, "node_modules", name);
  fs.mkdirSync(path.dirname(l), { recursive: true });
  fs.symlinkSync(realDir(name, version), l, "dir");
}

function storeEntries() {
  return fs
    .readdirSync(store)
    .filter((e) => e !== "node_modules")
    .sort();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-pnpm-store-"));
  store = path.join(root, "node_modules", ".pnpm");
  fs.mkdirSync(store, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("pruneUnreachable", () => {
  it("keeps every package reachable from an importer, transitively", () => {
    addPackage("leaf", "1.0.0");
    addPackage("mid", "1.0.0", [["leaf", "1.0.0"]]);
    addPackage("@scope/top", "2.0.0", [["mid", "1.0.0"]]);
    link(path.join(root, "server"), "@scope/top", "2.0.0");

    const res = pruneUnreachable({ storeDir: store, importerDirs: [path.join(root, "server")] });

    expect(res.removed).toEqual([]);
    expect(storeEntries()).toEqual(["@scope+top@2.0.0", "leaf@1.0.0", "mid@1.0.0"]);
  });

  it("removes a subtree reachable only through an excluded edge", () => {
    // Mirrors the real bug: `prisma` (the CLI) is a runtime dependency of the server
    // AND a peer of @prisma/client, and its tree (studio-core, dev, pglite ...) is
    // dead weight in the runtime image.
    addPackage("studio", "1.0.0");
    addPackage("shared-dep", "1.0.0");
    addPackage("prisma", "7.0.0", [
      ["studio", "1.0.0"],
      ["shared-dep", "1.0.0"],
    ]);
    addPackage("@prisma/client", "7.0.0", [
      ["prisma", "7.0.0"],
      ["shared-dep", "1.0.0"],
    ]);
    const server = path.join(root, "server");
    link(server, "prisma", "7.0.0");
    link(server, "@prisma/client", "7.0.0");

    const res = pruneUnreachable({
      storeDir: store,
      importerDirs: [server],
      exclude: ["prisma"],
    });

    expect(res.removed.sort()).toEqual(["prisma@7.0.0", "studio@1.0.0"]);
    // shared-dep is still reachable through @prisma/client and must survive.
    expect(storeEntries()).toEqual(["@prisma+client@7.0.0", "shared-dep@1.0.0"]);
  });

  it("excludes a scoped name on every edge, not just at the importer", () => {
    addPackage("@github/copilot-linuxmusl-x64", "1.0.0");
    addPackage("@github/copilot", "1.0.0", [["@github/copilot-linuxmusl-x64", "1.0.0"]]);
    addPackage("@github/copilot-sdk", "0.3.0", [["@github/copilot", "1.0.0"]]);
    addPackage("keep-me", "1.0.0");
    const server = path.join(root, "server");
    link(server, "@github/copilot-sdk", "0.3.0");
    link(server, "keep-me", "1.0.0");

    pruneUnreachable({
      storeDir: store,
      importerDirs: [server],
      exclude: ["@github/copilot-sdk"],
    });

    expect(storeEntries()).toEqual(["keep-me@1.0.0"]);
  });

  it("dry run reports without deleting", () => {
    addPackage("orphan", "1.0.0");
    const res = pruneUnreachable({ storeDir: store, importerDirs: [], dryRun: true });
    expect(res.removed).toEqual(["orphan@1.0.0"]);
    expect(storeEntries()).toEqual(["orphan@1.0.0"]);
  });

  it("tolerates dangling links, workspace links and missing importer dirs", () => {
    addPackage("real", "1.0.0");
    const server = path.join(root, "server");
    link(server, "real", "1.0.0");
    // Dangling: an optional platform package that was never installed.
    fs.symlinkSync(
      path.join(store, "nope@1.0.0", "node_modules", "nope"),
      path.join(server, "node_modules", "nope"),
    );
    // Workspace link: points outside the store and is not a store entry.
    const shared = path.join(root, "packages", "shared");
    fs.mkdirSync(shared, { recursive: true });
    fs.symlinkSync(shared, path.join(server, "node_modules", "shared"), "dir");
    // A plain directory (like `.bin`) is not an edge.
    fs.mkdirSync(path.join(server, "node_modules", ".bin"));

    const res = pruneUnreachable({
      storeDir: store,
      importerDirs: [server, path.join(root, "does-not-exist")],
    });

    expect(res.removed).toEqual([]);
    expect(res.kept).toEqual(["real@1.0.0"]);
  });

  it("never treats the store's own hoist directory as an entry to delete", () => {
    addPackage("orphan", "1.0.0");
    fs.mkdirSync(path.join(store, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(store, "lock.yaml"), "");

    const res = pruneUnreachable({ storeDir: store, importerDirs: [] });

    expect(res.removed).toEqual(["orphan@1.0.0"]);
    expect(fs.existsSync(path.join(store, "node_modules"))).toBe(true);
    expect(fs.existsSync(path.join(store, "lock.yaml"))).toBe(true);
  });

  it("throws when the store directory does not exist", () => {
    expect(() =>
      pruneUnreachable({ storeDir: path.join(root, "missing"), importerDirs: [] }),
    ).toThrow(/store directory not found/);
  });
});

describe("parseArgs", () => {
  it("collects repeated --importer and --exclude flags", () => {
    expect(
      parseArgs([
        "--store",
        "/s",
        "--importer",
        "/a",
        "--importer",
        "/b",
        "--exclude",
        "prisma",
        "--dry-run",
      ]),
    ).toEqual({ storeDir: "/s", importerDirs: ["/a", "/b"], exclude: ["prisma"], dryRun: true });
  });

  it("rejects a missing --store and a flag with no value", () => {
    expect(() => parseArgs(["--importer", "/a"])).toThrow(/--store is required/);
    expect(() => parseArgs(["--store"])).toThrow(/--store needs a value/);
    expect(() => parseArgs(["--store", "/s", "--bogus"])).toThrow(/unknown argument/);
  });
});

describe("runPrune", () => {
  it("prints a summary and returns 0", () => {
    addPackage("orphan", "1.0.0");
    const lines: string[] = [];
    const code = runPrune(["--store", store], { log: (m: string) => lines.push(m), err: () => {} });
    expect(code).toBe(0);
    expect(lines.join("\n")).toMatch(/removed 1 unreachable store entr/);
    expect(storeEntries()).toEqual([]);
  });

  it("returns 2 on bad arguments", () => {
    const errs: string[] = [];
    const code = runPrune([], { log: () => {}, err: (m: string) => errs.push(m) });
    expect(code).toBe(2);
    expect(errs.join("\n")).toMatch(/--store is required/);
  });
});
