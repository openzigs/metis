import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  chdirToRepoRoot,
  gitDiagnosis,
  notACheckoutMessage,
  resolveRepoRoot,
} from "./repo-root.mjs";

/**
 * Unit tests for the shared repository anchor (#1381).
 *
 * The runner-level proof — that `check-no-nul` scans 4,363 files from `server/` and not
 * 2,363 — lives in `check-no-nul-runner.test.mjs` and `gate-cwd-anchoring.test.mjs`,
 * because only a spawned process can be given a different working directory. What is
 * testable here, and is deliberately not left to the runners, is the FAILURE branch:
 * a gate whose error path has never been executed is the shape that fails open.
 */

describe("gitDiagnosis", () => {
  it("names a missing git binary rather than quoting an empty stderr", () => {
    const enoent = Object.assign(new Error("spawnSync git ENOENT"), { code: "ENOENT" });

    expect(gitDiagnosis(enoent)).toBe("the `git` executable was not found on PATH");
  });

  it("quotes git's own first stderr line, from a Buffer", () => {
    const failed = Object.assign(new Error("Command failed: git rev-parse --show-toplevel"), {
      stderr: Buffer.from(
        "fatal: not a git repository (or any of the parent directories): .git\n",
        "utf8",
      ),
    });

    expect(gitDiagnosis(failed)).toBe(
      "fatal: not a git repository (or any of the parent directories): .git",
    );
  });

  it("falls back to the error message when git said nothing", () => {
    expect(gitDiagnosis(new Error("something else\nsecond line"))).toBe("something else");
  });

  it("does not throw on a non-Error", () => {
    expect(gitDiagnosis(undefined)).toBe("git failed for an unknown reason");
  });
});

describe("notACheckoutMessage", () => {
  const message = notACheckoutMessage("check-no-nul", new Error("boom"));

  it("leads with the gate's own name and the fact that nothing was scanned", () => {
    expect(message.split("\n")[0]).toBe("check-no-nul: not a git checkout — NOTHING was scanned.");
  });

  it("is prose, not a stack trace", () => {
    // The whole complaint in #1381's second half: both gates crashed with an
    // `execFileSync` stack trace, which tells a tarball consumer nothing actionable.
    expect(message).not.toMatch(/^\s+at /m);
    expect(message).toContain("Run it from inside a clone");
  });

  it("says why exiting 0 would be wrong, so the decision survives the next reader", () => {
    expect(message).toContain("unknown is not clean");
  });

  it("is the same text for either gate apart from the gate's name", () => {
    // #1381 asks for the two gates to AGREE outside a checkout. They share this
    // function, and this arm is what would notice if one of them stopped.
    const other = notACheckoutMessage("verify-no-company-identifiers", new Error("boom"));

    expect(other.replace("verify-no-company-identifiers:", "check-no-nul:")).toBe(message);
  });
});

describe("resolveRepoRoot", () => {
  it("returns the path git printed, trimmed by the caller's toplevel", () => {
    const result = resolveRepoRoot({ gate: "g", toplevel: () => "/repo" });

    expect(result).toEqual({ ok: true, root: "/repo" });
  });

  it("fails — not throws — when there is no repository", () => {
    const result = resolveRepoRoot({
      gate: "g",
      toplevel: () => {
        throw Object.assign(new Error("Command failed"), {
          stderr: "fatal: not a git repository\n",
        });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("g: not a git checkout");
  });

  it("treats an EMPTY path from a successful git as unknown, not as the root", () => {
    // `git rev-parse` exiting 0 with no path is not a state git produces today. It is
    // rejected anyway because the alternative — `chdir("")` — throws from somewhere
    // else entirely, or on another platform silently does nothing and leaves the gate
    // scanning the caller's subtree again.
    const result = resolveRepoRoot({ gate: "g", toplevel: () => "" });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("git printed no path");
  });

  it("finds THIS repository with the real git, from the test process's own cwd", () => {
    const result = resolveRepoRoot({ gate: "g" });

    expect(result.ok).toBe(true);
    expect(result.ok === true && existsSync(path.join(result.root, "package.json"))).toBe(true);
    // Vitest runs this file with cwd = scripts/, a subdirectory. The root it resolves
    // must be the ancestor holding this very file, not the cwd.
    expect(result.ok === true && existsSync(path.join(result.root, "scripts", "lib"))).toBe(true);
    expect(fileURLToPath(import.meta.url).startsWith(result.ok === true ? result.root : "\0")).toBe(
      true,
    );
  });
});

describe("chdirToRepoRoot", () => {
  it("moves the process to the root and returns it", () => {
    /** @type {string[]} */
    const moved = [];

    const root = chdirToRepoRoot("g", { toplevel: () => "/repo", chdir: (d) => moved.push(d) });

    expect(root).toBe("/repo");
    expect(moved).toEqual(["/repo"]);
  });

  it("really moves the process with the DEFAULT chdir, not only an injected one", () => {
    // The injected-chdir arm above proves the wiring; this proves the default is the
    // real `process.chdir`. Without it the two defaults below are the only untested
    // lines in the module, and they are the ones that do the work in production.
    const before = process.cwd();
    const parent = path.dirname(before);
    try {
      expect(chdirToRepoRoot("g", { toplevel: () => parent })).toBe(parent);
      expect(process.cwd()).toBe(parent);
    } finally {
      process.chdir(before);
    }
  });

  it("by DEFAULT prints the message to stderr and exits 1", () => {
    // The exit path is the entire no-repository decision. Executing it here — rather
    // than only in a spawned gate, which v8 does not measure — is what stops it being
    // a branch nobody has ever run.
    /** @type {string[]} */
    const errors = [];
    /** @type {unknown[]} */
    const exits = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((m) => errors.push(String(m)));
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(/** @type {never} */ ((code) => void exits.push(code)));

    try {
      chdirToRepoRoot("g", {
        toplevel: () => {
          throw new Error("nope");
        },
        chdir: () => {
          throw new Error("must not chdir when there is no repository");
        },
      });
    } finally {
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(exits).toEqual([1]);
    expect(errors[0]).toContain("g: not a git checkout");
  });

  it("fails without moving when there is no repository", () => {
    /** @type {string[]} */
    const moved = [];
    /** @type {string[]} */
    const failures = [];

    chdirToRepoRoot("g", {
      toplevel: () => {
        throw new Error("nope");
      },
      chdir: (d) => moved.push(d),
      fail: (m) => /** @type {never} */ (/** @type {unknown} */ (failures.push(m))),
    });

    expect(moved).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("NOTHING was scanned");
  });
});
