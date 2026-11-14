import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * #2503 — `scripts/typecheck-chunked.mjs` end to end, on a throwaway project. The pure
 * split is covered by `typecheck-chunks-core.test.mjs`; this proves the runner's own
 * contract: it checks every chunk, reports a shared file's error once, keeps ambient
 * declarations visible to every chunk, and never exits 0 on a chunk that did not run.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(scriptsDir, "typecheck-chunked.mjs");

/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * @param {Record<string, string>} files  path relative to the project -> contents
 * @returns {string} the project's tsconfig path
 */
function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typecheck-chunked-"));
  dirs.push(dir);
  const all = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ES2022"],
      },
      include: ["src/**/*", "tests/**/*"],
    }),
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return path.join(dir, "tsconfig.json");
}

/** Runs from `scripts/`, whose own `typescript` the runner resolves. */
function run(/** @type {string[]} */ ...args) {
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: scriptsDir, encoding: "utf8" });
}

const CLEAN = {
  "src/lib.ts": "export const answer: number = 42;\n",
  // An ambient global that only the shared file declares: a chunk without it would fail.
  "src/globals.d.ts": "declare var sharedGlobal: string;\n",
  "tests/a.test.ts":
    'import { answer } from "../src/lib";\nexport const a: number = answer;\nexport const g: string = sharedGlobal;\n',
  "tests/b.test.ts":
    'import { answer } from "../src/lib";\nexport const b: number = answer + 1;\nexport const g: string = sharedGlobal;\n',
  "tests/c.test.ts": "export const c: string = sharedGlobal;\n",
};

describe("typecheck-chunked", () => {
  it("checks each test file in its own chunk with the shared files, and passes a clean project", () => {
    const res = run("-p", project(CLEAN), "--chunk-size", "1", "--heap", "1024");
    expect(res.stderr).toContain("chunk 1/3");
    expect(res.stderr).toContain("chunk 3/3");
    expect(res.stdout).toBe("");
    expect(res.status).toBe(0);
  });

  it("fails on an error in a test file", () => {
    const res = run(
      "-p",
      project({ ...CLEAN, "tests/c.test.ts": "export const c: number = sharedGlobal;\n" }),
      "--chunk-size",
      "1",
    );
    expect(res.stdout).toContain("tests/c.test.ts");
    expect(res.stdout).toContain("TS2322");
    expect(res.stdout).toContain("Found 1 error.");
    expect(res.status).toBe(1);
  });

  it("reports an error in a shared file once, though every chunk checks it", () => {
    const res = run(
      "-p",
      project({ ...CLEAN, "src/lib.ts": 'export const answer: number = "x";\n' }),
      "--chunk-size",
      "1",
    );
    expect(res.stdout.match(/TS2322/g)).toHaveLength(1);
    expect(res.stdout).toContain("Found 1 error.");
    expect(res.status).toBe(1);
  });

  it("--list-files prints the union of every chunk's program files", () => {
    const res = run("-p", project(CLEAN), "--chunk-size", "1", "--list-files");
    expect(res.status).toBe(0);
    const listed = res.stdout
      .trim()
      .split("\n")
      .filter((f) => !/node_modules/.test(f));
    expect(listed.map((f) => path.basename(f)).sort()).toEqual([
      "a.test.ts",
      "b.test.ts",
      "c.test.ts",
      "globals.d.ts",
      "lib.ts",
    ]);
  });

  it("exits 2, not 0, when a chunk cannot run", () => {
    const res = run("-p", path.join(os.tmpdir(), "typecheck-chunked-missing", "tsconfig.json"));
    expect(res.stderr).toMatch(/chunk 1 did not finish/);
    expect(res.status).toBe(2);
  });

  it.each([
    [["--chunk-size", "400"], /-p <tsconfig> is required/],
    [["-p", "x.json", "--heap", "100"], /--heap must be an integer >= 512/],
    [["-p", "x.json", "--bogus"], /unknown argument --bogus/],
    [["-p"], /-p needs a value/],
  ])("refuses bad arguments %j with exit 2", (args, message) => {
    const res = run(...args);
    expect(res.stderr).toMatch(message);
    expect(res.status).toBe(2);
  });

  it("refuses a chunk size that is not a positive integer with exit 2", () => {
    const res = run("-p", project(CLEAN), "--chunk-size", "0");
    expect(res.stderr).toMatch(/positive integer/);
    expect(res.status).toBe(2);
  });
});
