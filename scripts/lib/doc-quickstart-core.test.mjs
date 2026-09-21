import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  findDeveloperHomePaths,
  findScriptReferences,
  isResolvableReference,
  lineOf,
  PLACEHOLDER_HOME_NAMES,
  PNPM_BUILTIN_COMMANDS,
} from "./doc-quickstart-core.mjs";

/**
 * Sample offenders are ASSEMBLED, never written as literals.
 *
 * The repository arms below scan `scripts/` — this file included. A literal offender
 * here would make the gate red forever, or force an exemption in exactly the file most
 * likely to grow one. Concatenation dodges both: the string exists at runtime and not
 * in the source. The sibling company-identifier gate takes the same route.
 */
const U = "/" + "Users";
const H = "/" + "home";

/** @param {string} account */
const macHome = (account) => `${U}/${account}/`;
/** @param {string} account */
const linuxHome = (account) => `${H}/${account}/`;

describe("findDeveloperHomePaths", () => {
  it("flags a macOS home belonging to a named account", () => {
    const hits = findDeveloperHomePaths(`( cd "${macHome("jdoe")}actions-runner-2" )`);
    expect(hits).toHaveLength(1);
    expect(hits[0].account).toBe("jdoe");
  });

  it("flags a Linux home", () => {
    const hits = findDeveloperHomePaths(`# Graph Report - ${linuxHome("jdoe")}_work/metis`);
    expect(hits.map((hit) => hit.account)).toEqual(["jdoe"]);
  });

  it("flags the WSL spelling of a Windows home", () => {
    const hits = findDeveloperHomePaths(`cd /mnt/c${U}/jdoe/Development/metis`);
    expect(hits.map((hit) => hit.account)).toEqual(["jdoe"]);
  });

  it("reports the line the path sits on", () => {
    const hits = findDeveloperHomePaths(`one\ntwo\n${macHome("jdoe")}x\n`);
    expect(hits[0].line).toBe(3);
  });

  it("finds every occurrence, not just the first", () => {
    const text = `${macHome("jdoe")}a\n${macHome("asmith")}b\n`;
    expect(findDeveloperHomePaths(text).map((hit) => hit.account)).toEqual(["jdoe", "asmith"]);
  });

  it("passes a documented placeholder account", () => {
    for (const placeholder of PLACEHOLDER_HOME_NAMES) {
      expect(findDeveloperHomePaths(`${macHome(placeholder)}hf-cache`)).toEqual([]);
    }
  });

  it("passes an angle-bracket placeholder, which is the preferred spelling", () => {
    expect(findDeveloperHomePaths(`cd /mnt/c${U}/<you>/Development/metis`)).toEqual([]);
  });

  it("does not read a SCIM route as an account name", () => {
    // `/scim/v2/Users/u1` appears throughout the server tests. Dropping the
    // lookbehind from HOME_PATH_PATTERN makes this arm report account "u1".
    expect(findDeveloperHomePaths(`.patch("/scim/v2${U}/u1")`)).toEqual([]);
    expect(findDeveloperHomePaths(`.patch("/scim/v2${U}/u1/roles/x")`)).toEqual([]);
  });

  it("ignores a home root with nothing under it", () => {
    expect(findDeveloperHomePaths(`the tree lives under ${U}`)).toEqual([]);
    expect(findDeveloperHomePaths(`${H}/`)).toEqual([]);
  });

  it("returns nothing for text with no paths at all", () => {
    expect(findDeveloperHomePaths("git clone https://github.com/openzigs/metis.git")).toEqual([]);
  });
});

describe("findScriptReferences", () => {
  it("reads a bare npm run invocation", () => {
    expect(findScriptReferences("npm run prisma:generate")).toEqual([
      { manager: "npm", script: "prisma:generate", line: 1 },
    ]);
  });

  it("reads a bare pnpm invocation", () => {
    expect(findScriptReferences("pnpm db:migrate")).toEqual([
      { manager: "pnpm", script: "db:migrate", line: 1 },
    ]);
  });

  it("keeps a trailing comment out of the script name", () => {
    expect(findScriptReferences("pnpm bootstrap                # generates .env")).toEqual([
      { manager: "pnpm", script: "bootstrap", line: 1 },
    ]);
  });

  it("tolerates the indentation a fenced block carries", () => {
    expect(findScriptReferences("    pnpm dev")[0].script).toBe("dev");
  });

  it("ignores a workspace-filtered invocation, which names no root script", () => {
    expect(findScriptReferences("pnpm --filter @metis/server prisma generate")).toEqual([]);
  });

  it("ignores prose that merely mentions a command mid-sentence", () => {
    expect(findScriptReferences("Then run npm run dev from the project root.")).toEqual([]);
  });

  it("numbers references by the line they appear on", () => {
    expect(findScriptReferences("a\nb\npnpm dev\n")[0].line).toBe(3);
  });
});

describe("isResolvableReference", () => {
  const scripts = new Set(["dev", "db:migrate"]);

  it("resolves a script that exists", () => {
    expect(isResolvableReference({ manager: "npm", script: "dev", line: 1 }, scripts)).toBe(true);
  });

  it("rejects a script that does not exist", () => {
    expect(
      isResolvableReference({ manager: "npm", script: "prisma:generate", line: 1 }, scripts),
    ).toBe(false);
  });

  it("resolves a pnpm builtin that is not a script", () => {
    expect(isResolvableReference({ manager: "pnpm", script: "install", line: 1 }, scripts)).toBe(
      true,
    );
    expect(PNPM_BUILTIN_COMMANDS.has("install")).toBe(true);
  });

  it("does NOT extend the builtin allowance to npm run", () => {
    // `npm run install` runs a script called "install"; it is not `npm install`.
    expect(isResolvableReference({ manager: "npm", script: "install", line: 1 }, scripts)).toBe(
      false,
    );
  });
});

describe("lineOf", () => {
  it("returns 1 for an offset on the first line", () => {
    expect(lineOf("abc\ndef", 0)).toBe(1);
    expect(lineOf("abc\ndef", 2)).toBe(1);
  });

  it("counts newlines before the offset", () => {
    expect(lineOf("abc\ndef\nghi", 9)).toBe(3);
  });

  it("clamps an offset past the end rather than running away", () => {
    expect(lineOf("abc\ndef", 999)).toBe(2);
  });
});

/**
 * Repository arms.
 *
 * These are the ones that were red before #1383 and are the reason the module exists;
 * the unit arms above only prove the scanners can see what these assert is absent.
 */
describe("the publishable tree", () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

  /** @param {string[]} paths */
  const tracked = (paths) =>
    execFileSync("git", ["ls-files", "-z", ...paths], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8")
      .split("\0")
      .filter((file) => file.length > 0);

  it("carries no developer home path in docs/ or scripts/", () => {
    const files = tracked(["docs", "scripts"]);
    // A scan that opened nothing reports clean. `git ls-files docs scripts` enumerates
    // the CURRENT directory's subtree, so running this from anywhere but the repo root
    // silently returns an empty list and the assertion below passes having checked
    // nothing — the fail-open shape #1215 measured on the sibling NUL gate. Pin the
    // enumeration, not just its verdict.
    expect(files.length).toBeGreaterThan(100);

    const offenders = [];
    for (const file of files) {
      let text;
      try {
        text = readFileSync(`${root}/${file}`, "utf8");
      } catch (error) {
        // A tracked path absent from this worktree holds nothing, which is a knowable
        // answer. Any OTHER error means a file this scan claims to have checked was
        // never opened, so it must not be swallowed — a bare `catch { continue }` is
        // what took the sibling NUL gate from exit 1 to exit 0 while still reporting
        // the file as scanned (#1215).
        if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue;
        throw error;
      }
      for (const hit of findDeveloperHomePaths(text)) {
        offenders.push(`${file}:${hit.line} ${hit.match}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("promises no command the root package.json cannot run, in USER_GUIDE.md", () => {
    const scriptNames = new Set(
      Object.keys(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).scripts ?? {}),
    );
    const text = readFileSync(`${root}/docs/USER_GUIDE.md`, "utf8");
    const references = findScriptReferences(text);
    // Same fail-open: if the extractor stopped matching — a fence style changes, the
    // regex loses its `m` flag — every reference resolves because there are none.
    expect(references.length).toBeGreaterThan(0);

    const unresolved = references
      .filter((reference) => !isResolvableReference(reference, scriptNames))
      .map(
        (reference) =>
          `docs/USER_GUIDE.md:${reference.line} ${reference.manager} ${reference.script}`,
      );
    expect(unresolved).toEqual([]);
  });

  it("gives the quickstart a clone command that actually clones", () => {
    const text = readFileSync(`${root}/docs/USER_GUIDE.md`, "utf8");
    const cloneLines = text
      .split("\n")
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => entry.line.startsWith("git clone"));

    expect(cloneLines.length).toBeGreaterThan(0);
    for (const entry of cloneLines) {
      // A clone argument is a URL, an scp-style remote, a path, or an explicitly
      // marked `<placeholder>`. Prose is none of those.
      expect(entry.line).toMatch(/^git clone (?:https?:\/\/\S+|git@\S+|\.{0,2}\/\S+|<[a-z-]+>)$/);
    }
  });
});
