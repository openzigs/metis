/**
 * #729 — slug `pattern` attributes must compile under the `v` flag.
 *
 * Browsers compile an input's `pattern` as `new RegExp(`^(?:${p})$`, "v")`. An
 * invalid one logs a console error and is then ignored, so the field's
 * client-side validation is silently off.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE_SLUG_PATTERN } from "@/lib/slug-pattern";

/** Compile the way the HTML constraint-validation algorithm does. */
function compileAsBrowser(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, "v");
}

function listSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listSources(full);
    return /\.tsx$/.test(name) ? [full] : [];
  });
}

describe("WORKSPACE_SLUG_PATTERN", () => {
  it("is a valid v-flag regular expression", () => {
    expect(() => compileAsBrowser(WORKSPACE_SLUG_PATTERN)).not.toThrow();
  });

  it("accepts exactly what the server's workspace slug regex accepts", () => {
    const server = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
    const browser = compileAsBrowser(WORKSPACE_SLUG_PATTERN);
    const samples = [
      "engineering",
      "walkthrough-706",
      "a1",
      "a-b-c",
      "a",
      "-lead",
      "trail-",
      "Upper",
      "has space",
      "under_score",
      "",
    ];
    for (const s of samples) {
      expect(browser.test(s), s).toBe(server.test(s));
    }
  });
});

describe("pattern attributes in ui/src", () => {
  const srcDir = path.resolve(__dirname, "../src");
  const literals = listSources(srcDir).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/\bpattern="([^"]*)"/g)].map((m) => ({
      file: path.relative(srcDir, file),
      pattern: m[1],
    })),
  );

  it.each(literals)("$file: $pattern compiles with the v flag", ({ pattern }) => {
    expect(() => compileAsBrowser(pattern)).not.toThrow();
  });
});
