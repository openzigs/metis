/**
 * Epic #129 (#146) — importing an Agent Skills directory: supporting files are
 * bounded, text-only, credential-free and path-safe; a flat import groups into
 * skills exactly as the directory layout says.
 */
import { describe, expect, it } from "vitest";
import {
  groupSkillImport,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  OVERSIZE_FILE_SENTINEL,
  SkillBundleError,
  validateSkillFiles,
} from "./skill-bundle.js";
import { normalizeSkillFilePath } from "./skills.js";

describe("normalizeSkillFilePath", () => {
  it.each([
    ["references/REFERENCE.md", "references/REFERENCE.md"],
    ["assets/template v2.md", "assets/template v2.md"],
    ["  scripts/run.py  ", "scripts/run.py"],
  ])("accepts %j", (raw, out) => {
    expect(normalizeSkillFilePath(raw)).toBe(out);
  });

  it.each([
    "../secrets.env",
    "references/../../etc/passwd",
    "/etc/passwd",
    "C:/windows/win.ini",
    "references\\evil.md",
    "./references/a.md",
    "a//b.md",
    "a/b/c/d/e.md",
    "SKILL.md",
    "refs/\u0000x",
    "refs/%2e%2e/x",
    "",
    42,
  ])("rejects %j", (raw) => {
    expect(normalizeSkillFilePath(raw)).toBeNull();
  });
});

describe("validateSkillFiles", () => {
  it("returns sized, hashed files", () => {
    const [f] = validateSkillFiles([{ path: "references/a.md", content: "hello" }]);
    expect(f).toMatchObject({ path: "references/a.md", sizeBytes: 5 });
    expect(f!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects traversal, binary, oversize, duplicates, too many and credentials — with the reason", () => {
    const bad = (files: Array<{ path: string; content: string }>, re: RegExp) =>
      expect(() => validateSkillFiles(files)).toThrow(re);
    bad([{ path: "../x.md", content: "a" }], /relative/);
    bad([{ path: "a.bin", content: "a\u0000b" }], /not a text file/);
    bad([{ path: "big.md", content: "x".repeat(MAX_SKILL_FILE_BYTES + 1) }], /limit is/);
    bad([{ path: "big.md", content: OVERSIZE_FILE_SENTINEL }], /larger than/);
    bad(
      [
        { path: "a.md", content: "1" },
        { path: "a.md", content: "2" },
      ],
      /twice/,
    );
    bad(
      Array.from({ length: MAX_SKILL_FILES + 1 }, (_, i) => ({ path: `f${i}.md`, content: "x" })),
      /at most/,
    );
    bad([{ path: "k.md", content: ["AKIA", "Q3EGRTXXXXZ7Y2WB"].join("") }], /credential/);
    expect(() => validateSkillFiles([{ path: "../x", content: "a" }])).toThrow(SkillBundleError);
  });

  it("caps the bundle's total size", () => {
    const eighth = "x".repeat(MAX_SKILL_FILE_BYTES - 1);
    const files = Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.md`, content: eighth }));
    expect(() => validateSkillFiles(files)).toThrow(/in total/);
  });
});

describe("groupSkillImport", () => {
  it("groups a SKILL.md directory with its supporting files, nested skills keep their own", () => {
    const out = groupSkillImport([
      { path: "pdf/SKILL.md", contents: "PDF" },
      { path: "pdf/references/FORMS.md", contents: "forms" },
      { path: "pdf/scripts/extract.py", contents: "print(1)" },
      { path: "pdf/inner/SKILL.md", contents: "INNER" },
      { path: "pdf/inner/notes.md", contents: "inner notes" },
      { path: "loose.skill.md", contents: "LOOSE" },
      { path: "legacy.md", contents: "LEGACY" },
    ]);
    expect(out.map((e) => [e.path, e.source])).toEqual([
      ["pdf/SKILL.md", "PDF"],
      ["pdf/inner/SKILL.md", "INNER"],
      ["loose.skill.md", "LOOSE"],
      ["legacy.md", "LEGACY"],
    ]);
    expect(out[0]!.files.map((f) => f.path).sort()).toEqual([
      "references/FORMS.md",
      "scripts/extract.py",
    ]);
    expect(out[1]!.files).toEqual([{ path: "notes.md", content: "inner notes" }]);
  });

  it("with no SKILL.md every file is its own skill (the pre-#146 inline import)", () => {
    const out = groupSkillImport([
      { path: "a.md", contents: "A" },
      { path: "b.md", contents: "B" },
    ]);
    expect(out.map((e) => e.path)).toEqual(["a.md", "b.md"]);
    expect(out.every((e) => e.files.length === 0)).toBe(true);
  });

  it("a root SKILL.md claims the other root files; backslash paths are normalised", () => {
    const out = groupSkillImport([
      { path: "SKILL.md", contents: "ROOT" },
      { path: "references\\guide.md", contents: "g" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.files).toEqual([{ path: "references/guide.md", content: "g" }]);
  });
});
