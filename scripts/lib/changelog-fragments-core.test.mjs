import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTOMATED_DEPENDENCY_AUTHORS,
  DEPENDENCY_MANIFEST_RULES,
  EXEMPT_RULES,
  FRAGMENT_DIR,
  MAX_ENTRY_LINES,
  MAX_LINE_CHARS,
  NON_FRAGMENT_FILES,
  SECTIONS,
  classifyChangedPaths,
  classifyPath,
  groupEntryBlocks,
  insertVersionSection,
  isAutomatedDependencyAuthor,
  isFragmentBasename,
  parseFragment,
  renderVersionSection,
  verifyChangelogFragments,
} from "./changelog-fragments-core.mjs";

/**
 * @param {Record<string, string>} [frontmatter]
 * @param {string} [body]
 */
function fragmentText(frontmatter = { issue: "1191", section: "Added" }, body = "- An entry.") {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) lines.push(`${key}: ${value}`);
  lines.push("---", "", body, "");
  return lines.join("\n");
}

describe("parseFragment", () => {
  it("accepts a well-formed fragment", () => {
    const result = parseFragment("1191-changelog-fragments.md", fragmentText());
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.issue).toBe(1191);
    expect(result.section).toBe("Added");
    expect(result.entries).toEqual(["- An entry."]);
  });

  it("accepts every Keep a Changelog section", () => {
    for (const section of SECTIONS) {
      const result = parseFragment("1-x.md", fragmentText({ issue: "1", section }));
      expect(result.ok, `${section} should be accepted`).toBe(true);
      expect(result.section).toBe(section);
    }
  });

  it("accepts nested continuation bullets alongside a top-level one", () => {
    const result = parseFragment(
      "1191-nested.md",
      fragmentText(undefined, "- Top level.\n  - Nested detail."),
    );
    expect(result.problems).toEqual([]);
    expect(result.entries).toEqual(["- Top level.", "  - Nested detail."]);
  });

  it.each([
    ["no issue prefix", "changelog-fragments.md"],
    ["an uppercase slug", "1191-Changelog.md"],
    ["a trailing hyphen", "1191-changelog-.md"],
    ["the wrong extension", "1191-changelog.txt"],
  ])("rejects a filename with %s", (_label, filename) => {
    const result = parseFragment(filename, fragmentText());
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("<issue>-<kebab-slug>.md");
  });

  it("rejects unreadable contents", () => {
    const result = parseFragment("1191-x.md", null);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("missing or unreadable");
  });

  it("rejects a file with no frontmatter block", () => {
    const result = parseFragment("1191-x.md", "- Just a bullet, no frontmatter.\n");
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("no closed --- frontmatter block");
  });

  it("rejects an unclosed frontmatter block", () => {
    const result = parseFragment("1191-x.md", "---\nissue: 1191\nsection: Added\n\n- Entry.\n");
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("no closed --- frontmatter block");
  });

  it("rejects a missing section", () => {
    const result = parseFragment("1191-x.md", fragmentText({ issue: "1191" }));
    expect(result.problems.join("\n")).toContain('missing "section"');
  });

  it("rejects an unknown section", () => {
    const result = parseFragment("1191-x.md", fragmentText({ issue: "1191", section: "Improved" }));
    expect(result.problems.join("\n")).toContain('section is "Improved"');
    expect(result.section).toBeNull();
  });

  it("rejects a missing issue", () => {
    const result = parseFragment("1191-x.md", fragmentText({ section: "Added" }));
    expect(result.problems.join("\n")).toContain('missing "issue"');
  });

  it("rejects a non-numeric issue", () => {
    const result = parseFragment("1191-x.md", fragmentText({ issue: "#1191", section: "Fixed" }));
    expect(result.problems.join("\n")).toContain('issue is "#1191"');
    expect(result.issue).toBeNull();
  });

  it("rejects frontmatter and filename disagreeing about the issue", () => {
    const result = parseFragment("1191-x.md", fragmentText({ issue: "1188", section: "Added" }));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("does not match the filename's 1191");
  });

  it("rejects an empty body", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, ""));
    expect(result.problems.join("\n")).toContain("no entry text");
  });

  it("rejects prose that is not a bullet", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, "This PR refactors things."));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("must start with a top-level bullet");
  });

  it("rejects a body of only indented bullets", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, "  - Only nested."));
    expect(result.problems.join("\n")).toContain("must start with a top-level bullet");
  });

  it("rejects an unindented non-bullet line after a valid bullet", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, "- Entry.\nStray prose."));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("neither a bullet nor an indented continuation");
  });

  it("accepts a soft-wrapped entry — the shape the first real fragment used", () => {
    const result = parseFragment(
      "1191-x.md",
      fragmentText(
        undefined,
        "- A long entry that runs past the line\n  and wraps onto the next line.",
      ),
    );
    expect(result.problems).toEqual([]);
    expect(result.entries).toHaveLength(2);
  });

  it(`rejects more than ${MAX_ENTRY_LINES} entry lines`, () => {
    const body = Array.from({ length: MAX_ENTRY_LINES + 1 }, (_, i) => `- Entry ${i}.`).join("\n");
    const result = parseFragment("1191-x.md", fragmentText(undefined, body));
    expect(result.problems.join("\n")).toContain(`over the ${MAX_ENTRY_LINES}-line cap`);
  });

  it(`accepts exactly ${MAX_ENTRY_LINES} entry lines — the cap is not off by one`, () => {
    const body = Array.from({ length: MAX_ENTRY_LINES }, (_, i) => `- Entry ${i}.`).join("\n");
    expect(parseFragment("1191-x.md", fragmentText(undefined, body)).ok).toBe(true);
  });

  it("rejects the 7,786-character single line that motivated the cap", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, `- ${"x".repeat(7784)}`));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(`over the ${MAX_LINE_CHARS}-character cap`);
  });

  it(`accepts a line of exactly ${MAX_LINE_CHARS} characters`, () => {
    const line = `- ${"x".repeat(MAX_LINE_CHARS - 2)}`;
    expect(line.length).toBe(MAX_LINE_CHARS);
    expect(parseFragment("1191-x.md", fragmentText(undefined, line)).ok).toBe(true);
  });

  it("rejects an entry that hand-writes the issue reference the assembler appends", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, "- Did a thing (#1191)."));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain('already contains "(#1191)"');
  });

  it("allows an entry referencing a DIFFERENT issue", () => {
    expect(
      parseFragment("1191-x.md", fragmentText(undefined, "- Follows on from (#1188).")).ok,
    ).toBe(true);
  });
});

/**
 * The entry grammar, stated as a corpus rather than as prose.
 *
 * A validator that rejects text which renders correctly everywhere gets worked
 * around rather than followed, and nothing upstream normalises markdown here —
 * `.prettierignore` contains `*.md`, so prettier will never rewrite a `*` bullet
 * into a `-`. So the accepted set covers all three CommonMark bullet markers,
 * and every rejection has to NAME the construct and the alternative: a rejection
 * a writer cannot act on is one they route around.
 */
describe("parseFragment: the entry grammar", () => {
  it.each([
    ["a hyphen bullet", "- An entry."],
    ["an asterisk bullet", "* An entry."],
    ["a plus bullet", "+ An entry."],
    ["a nested asterisk bullet", "- Top level.\n  * Nested detail."],
    ["a nested plus bullet", "* Top level.\n  + Nested detail."],
    ["a soft-wrapped continuation", "- An entry that\n  wraps."],
    ["a blank line between bullets", "- One.\n\n- Two."],
    ["an indented code fence", "- An entry.\n  ```ts\n  const x = 1;\n  ```"],
    ["an indented table", "- An entry.\n  | a | b |\n  | - | - |"],
  ])("accepts %s", (_label, body) => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, body));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ["an ordered-list item", "1. An entry.", "an ordered-list item", '- "'],
    ["a heading", "- An entry.\n### Details", "a markdown heading", "### Added"],
    ["a thematic break", "- An entry.\n---", "a thematic break", "delete it"],
    [
      "an unindented code fence",
      "- An entry.\n```ts\nconst x = 1;\n```",
      "an unindented code fence",
      "indent the whole fence",
    ],
    [
      "an unindented table row",
      "- An entry.\n| a | b |",
      "an unindented table row",
      "indent the table",
    ],
  ])("rejects %s, naming the construct and the alternative", (_label, body, what, alternative) => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, body));
    expect(result.ok).toBe(false);
    const joined = result.problems.join("\n");
    expect(joined).toContain(what);
    expect(joined).toContain(alternative);
  });

  it("rejects a bold lead-in with the generic, still-actionable message", () => {
    const result = parseFragment("1191-x.md", fragmentText(undefined, "**Added** a thing."));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("indent it by two spaces");
  });

  it("does not mistake bold or a break for a bullet", () => {
    // `**bold**` and `***` both start with the asterisk that is now a bullet
    // marker; a bullet needs whitespace after the marker, and these have none.
    for (const body of ["**Bold lead-in.**", "***"]) {
      expect(parseFragment("1191-x.md", fragmentText(undefined, body)).ok).toBe(false);
    }
  });

  it("preserves the author's bullet marker through assembly", () => {
    const fragment = parseFragment(
      "1191-x.md",
      fragmentText({ issue: "1191", section: "Added" }, "* An asterisk entry."),
    );
    const out = renderVersionSection({
      fragments: [fragment],
      version: "1.1.0",
      date: "2026-08-01",
    });
    // Assembly appends the reference and changes nothing else — rewriting the
    // marker would mean the assembler edits entry text, and an indented fence
    // could contain a line that looks like a bullet.
    expect(out).toContain("* An asterisk entry. (#1191)");
  });
});

describe("isFragmentBasename", () => {
  it.each(["1191-changelog-fragments.md", "900-x.md", "not-numbered.md", "weird name.md"])(
    "accepts %s",
    (name) => {
      // Deliberately loose: a malformed NAME must still be read and rejected by
      // parseFragment with a message. Skipping it here is how a file escapes
      // validation while still counting as "a fragment this branch added".
      expect(isFragmentBasename(name)).toBe(true);
    },
  );

  it.each([".sneaky.md", ".gitkeep", "README.md", "", null, undefined])("rejects %s", (name) => {
    expect(isFragmentBasename(name)).toBe(false);
  });

  it("rejects every declared infrastructure file", () => {
    for (const name of NON_FRAGMENT_FILES) expect(isFragmentBasename(name)).toBe(false);
  });

  it("is the SAME decision the diff side makes — the two cannot drift", () => {
    // The bypass this closes was two hand-kept-in-sync filters disagreeing about
    // dotfiles. Asserting agreement over a corpus is what stops that recurring.
    const corpus = [
      "1191-x.md",
      ".sneaky.md",
      ".gitkeep",
      "README.md",
      "no-issue-number.md",
      ".hidden-dir-looking.md",
    ];
    const { fragments } = classifyChangedPaths(corpus.map((name) => `${FRAGMENT_DIR}/${name}`));
    expect(fragments).toEqual(
      corpus.filter(isFragmentBasename).map((name) => `${FRAGMENT_DIR}/${name}`),
    );
  });
});

describe("groupEntryBlocks", () => {
  it("starts a new block at each top-level bullet", () => {
    expect(groupEntryBlocks(["- One.", "- Two."])).toEqual([["- One."], ["- Two."]]);
  });

  it("keeps continuation and nested lines with the bullet above", () => {
    expect(groupEntryBlocks(["- One.", "  wrapped.", "  - nested.", "- Two."])).toEqual([
      ["- One.", "  wrapped.", "  - nested."],
      ["- Two."],
    ]);
  });

  it("tolerates a body that opens with an indented line", () => {
    expect(groupEntryBlocks(["  orphan.", "- One."])).toEqual([["  orphan."], ["- One."]]);
  });

  it("returns nothing for no lines", () => {
    expect(groupEntryBlocks([])).toEqual([]);
  });
});

describe("classifyPath / classifyChangedPaths", () => {
  it.each([
    "server/src/routes/projects.ts",
    "ui/app/page.tsx",
    "packages/shared/src/index.ts",
    "scripts/lib/changelog-fragments-core.mjs",
    "CLAUDE.md",
    "Dockerfile.server",
    ".github/workflows/ci.yml",
  ])("requires a fragment for %s", (filePath) => {
    expect(classifyPath(filePath).exempt).toBe(false);
  });

  it.each([
    ".changes/unreleased/1191-x.md",
    "CHANGELOG.md",
    "docs/ARCHITECTURE.md",
    "graphify-out/graph.json",
    ".claude/agent-memory/code-issue/MEMORY.md",
    "eval-results/corpus-02.json",
    "pnpm-lock.yaml",
    "e2e/specs/login.spec.ts",
    "server/tests/lib/foo.test.ts",
    "scripts/lib/changelog-fragments-core.test.mjs",
  ])("exempts %s", (filePath) => {
    expect(classifyPath(filePath).exempt).toBe(true);
    expect(classifyPath(filePath).why).toBeTruthy();
  });

  it("every exempt rule carries a reason", () => {
    for (const rule of EXEMPT_RULES) expect(rule.why.length).toBeGreaterThan(0);
  });

  it("separates fragments from other exempt paths", () => {
    const result = classifyChangedPaths([
      "server/src/a.ts",
      "docs/b.md",
      `${FRAGMENT_DIR}/1191-x.md`,
      `${FRAGMENT_DIR}/README.md`,
      `${FRAGMENT_DIR}/.gitkeep`,
      `${FRAGMENT_DIR}/.sneaky.md`,
    ]);
    expect(result.requiring).toEqual(["server/src/a.ts"]);
    expect(result.fragments).toEqual([`${FRAGMENT_DIR}/1191-x.md`]);
    expect(result.exempt).toContain("docs/b.md");
    // README.md, .gitkeep and any dotfile are exempt but must not count AS a
    // fragment, or touching the docs would satisfy the gate. They are reported
    // rather than dropped, so the author is told why the file did not count.
    expect(result.ignoredInFragmentDir).toEqual([
      `${FRAGMENT_DIR}/README.md`,
      `${FRAGMENT_DIR}/.gitkeep`,
      `${FRAGMENT_DIR}/.sneaky.md`,
    ]);
  });

  it("ignores empty and non-string entries", () => {
    const result = classifyChangedPaths(["", null, undefined, "server/src/a.ts"]);
    expect(result.requiring).toEqual(["server/src/a.ts"]);
  });
});

/**
 * The automated-dependency-author exemption (Issue #1270).
 *
 * Every arm here is a PAIR: the same path, classified once with the bot author
 * and once without. A test that only proved the bot passes would be half a gate
 * — it could not tell an author exemption apart from deleting the rule.
 */
describe("isAutomatedDependencyAuthor", () => {
  it.each(["dependabot[bot]", "app/dependabot", "Dependabot[bot]", "  dependabot[bot]  "])(
    "recognises %j",
    (author) => {
      expect(isAutomatedDependencyAuthor(author)).toBe(true);
    },
  );

  it.each([
    // Bare `dependabot` is the one spelling a human login could take, and no
    // real caller produces it: Actions sends `dependabot[bot]`, gh sends
    // `app/dependabot`.
    "dependabot",
    // A substring test would hand the exemption to every one of these.
    "dependabot-mirror",
    "not-dependabot[bot]",
    "dependabot[bot]x",
    "xdependabot[bot]",
    "renovate[bot]",
    "github-actions[bot]",
    "mcronin",
    "",
  ])("does NOT recognise %j", (author) => {
    expect(isAutomatedDependencyAuthor(author)).toBe(false);
  });

  it.each([null, undefined, 0, {}, [], ["dependabot[bot]"]])(
    "treats the non-string %j as unknown, which is the STRICT reading",
    (author) => {
      expect(isAutomatedDependencyAuthor(author)).toBe(false);
    },
  );

  it("every accepted spelling is already lowercase and unforgeable as a human login", () => {
    for (const login of AUTOMATED_DEPENDENCY_AUTHORS) {
      expect(login).toBe(login.toLowerCase());
      // GitHub usernames are alphanumeric plus hyphens; both accepted spellings
      // carry a character no username may contain, so neither can be taken.
      expect(/[^a-z0-9-]/.test(login)).toBe(true);
    }
  });

  it("every dependency-manifest rule carries a reason", () => {
    for (const rule of DEPENDENCY_MANIFEST_RULES) expect(rule.why.length).toBeGreaterThan(0);
  });
});

describe("classifyPath: the author exemption is an INTERSECTION of author and path", () => {
  const BOT = "dependabot[bot]";

  it.each([
    "package.json",
    "ui/package.json",
    "server/package.json",
    "server/copilot-svc/package.json",
    "packages/shared/package.json",
    "pnpm-workspace.yaml",
    ".github/workflows/ci.yml",
    ".github/workflows/sast.yml",
    ".github/actions/setup/action.yml",
  ])("%s requires an entry from a human and NOT from the bot", (filePath) => {
    expect(classifyPath(filePath).exempt).toBe(false);
    expect(classifyPath(filePath, { author: "mcronin" }).exempt).toBe(false);

    const bot = classifyPath(filePath, { author: BOT });
    expect(bot.exempt).toBe(true);
    expect(bot.viaAuthor).toBe(true);
    expect(bot.why).toBeTruthy();
  });

  it.each([
    "server/src/routes/projects.ts",
    "ui/app/page.tsx",
    "packages/shared/src/index.ts",
    "scripts/lib/changelog-fragments-core.mjs",
    "Dockerfile.server",
    "CLAUDE.md",
    // Near-misses for the manifest patterns: the rules are anchored, so a file
    // that merely CONTAINS a manifest name is not one.
    "server/package.json.bak",
    "docs-package.json/thing.ts",
    ".github/workflows-old/ci.yml",
    ".github/workflows/nested/ci.yml",
    "vendor/.github/workflows/ci.yml",
  ])("%s requires an entry even from the bot", (filePath) => {
    expect(classifyPath(filePath, { author: BOT }).exempt).toBe(false);
    expect(classifyPath(filePath, { author: BOT }).viaAuthor).toBe(false);
  });

  it("a path exempt for EVERYONE is not attributed to the author", () => {
    // `pnpm-lock.yaml` and `docs/` were exempt before #1270 and stay exempt for
    // humans; reporting them as author-exempt would overstate what the new rule
    // does and make the log misleading.
    for (const filePath of ["pnpm-lock.yaml", "docs/ARCHITECTURE.md", "e2e/a.spec.ts"]) {
      const bot = classifyPath(filePath, { author: BOT });
      expect(bot.exempt).toBe(true);
      expect(bot.viaAuthor).toBe(false);
    }
  });

  it("classifyChangedPaths reports the author-exempt subset separately", () => {
    const result = classifyChangedPaths(
      ["server/package.json", "pnpm-lock.yaml", "docs/x.md", "server/src/a.ts"],
      { author: BOT },
    );
    expect(result.authorExempt).toEqual(["server/package.json"]);
    expect(result.requiring).toEqual(["server/src/a.ts"]);
    expect(result.exempt).toContain("pnpm-lock.yaml");
  });

  it("reports NO author-exempt paths when the author is unknown", () => {
    const result = classifyChangedPaths(["server/package.json", "pnpm-lock.yaml"]);
    expect(result.authorExempt).toEqual([]);
    expect(result.requiring).toEqual(["server/package.json"]);
  });
});

describe("the ten real dependabot PRs open on 2026-08-06 (#1270)", () => {
  /**
   * Captured verbatim from `gh pr view <n> --json files`, not written by hand:
   * #1249 required exactly this and it caught a fabricated measurement.
   *
   * @type {{ capturedAt: string, prs: Record<string, { author: string, title: string, files: string[] }> }}
   */
  const corpus = JSON.parse(
    fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/dependabot-pr-files.json"),
      "utf8",
    ),
  );

  const numbers = ["1248", "1212", "1204", "1203", "1202", "1200", "1199", "1198", "1197", "596"];

  it("the corpus is the ten PRs named in the issue, all authored by dependabot", () => {
    expect(Object.keys(corpus.prs).sort()).toEqual([...numbers].sort());
    for (const pr of Object.values(corpus.prs)) {
      expect(isAutomatedDependencyAuthor(pr.author)).toBe(true);
      expect(pr.files.length).toBeGreaterThan(0);
    }
  });

  it.each(numbers)("PR #%s: PASSES for dependabot with no fragment", (number) => {
    const pr = corpus.prs[number];
    const report = verifyChangelogFragments({
      changedPaths: pr.files,
      fragmentFiles: {},
      baseFragments: [],
      author: pr.author,
    });
    expect(report.requiring).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it.each(numbers)("PR #%s: the SAME paths still FAIL for a human with no fragment", (number) => {
    const pr = corpus.prs[number];
    const report = verifyChangelogFragments({
      changedPaths: pr.files,
      fragmentFiles: {},
      baseFragments: [],
      author: "mcronin",
    });
    // #1240 and #1241 moved CVSS 7.0+ advisories by hand and both entries were
    // worth having. Exempting the manifests outright (option 1) would have lost
    // them; this arm is what proves the author rule did not.
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("adds no changelog fragment");
  });

  it("PR #1197's lone ui/package.json is the minimal case, and it flips on the author", () => {
    // The narrowest PR in the corpus: one path, and every other signal identical
    // between the two arms. If the exemption keyed on anything but the author,
    // this pair could not differ.
    const files = corpus.prs["1197"].files;
    expect(files).toEqual(["ui/package.json"]);
    const shared = { changedPaths: files, fragmentFiles: {}, baseFragments: [] };
    expect(verifyChangelogFragments({ ...shared, author: "dependabot[bot]" }).ok).toBe(true);
    expect(verifyChangelogFragments({ ...shared, author: "app/dependabot" }).ok).toBe(true);
    expect(verifyChangelogFragments({ ...shared, author: "mcronin" }).ok).toBe(false);
    expect(verifyChangelogFragments({ ...shared, author: null }).ok).toBe(false);
    expect(verifyChangelogFragments(shared).ok).toBe(false);
  });

  it("a bot PR reaching OUTSIDE the manifest set still fails, and says how to fix it", () => {
    // The exemption is scoped on purpose. An author-only rule would let this
    // through — a bot silently rewriting source with no entry and no signal.
    const report = verifyChangelogFragments({
      changedPaths: [...corpus.prs["1204"].files, "server/src/lib/db.ts"],
      fragmentFiles: {},
      baseFragments: [],
      author: "dependabot[bot]",
    });
    expect(report.ok).toBe(false);
    expect(report.requiring).toEqual(["server/src/lib/db.ts"]);
    const text = report.problems.join("\n");
    expect(text).toContain("DEPENDENCY_MANIFEST_RULES");
    expect(text).toContain("exempt on dependency manifests only");
  });

  it("the exemption does NOT touch the OTHER half of the gate — fragments still parse", () => {
    // #1215's fail-open here was an input that could not be read counting as
    // "nothing to check". An exemption that short-circuited the whole function
    // would be the same defect by a different door, so a malformed fragment on
    // disk must still fail a fully-exempt bot PR.
    const report = verifyChangelogFragments({
      changedPaths: corpus.prs["1204"].files,
      fragmentFiles: { "999-broken.md": "---\nissue: notanumber\n---\nbroken\n" },
      baseFragments: [],
      author: "dependabot[bot]",
    });
    expect(report.requiring).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain('frontmatter is missing "section"');
  });
});

describe("verifyChangelogFragments", () => {
  const good = { "1191-x.md": fragmentText() };

  /** @param {Partial<Parameters<typeof verifyChangelogFragments>[0]>} input */
  const verify = (input) =>
    verifyChangelogFragments({ changedPaths: [], fragmentFiles: {}, baseFragments: [], ...input });

  it("passes when source changed and a fragment was added", () => {
    const report = verify({
      changedPaths: ["server/src/a.ts", `${FRAGMENT_DIR}/1191-x.md`],
      fragmentFiles: good,
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.contributed).toEqual([`${FRAGMENT_DIR}/1191-x.md`]);
  });

  it("FAILS when source changed and no fragment was added", () => {
    const report = verify({ changedPaths: ["server/src/a.ts"] });
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain("adds no changelog fragment");
    expect(report.problems.join("\n")).toContain("server/src/a.ts");
  });

  it("passes when only exempt paths changed", () => {
    const report = verify({ changedPaths: ["docs/ARCHITECTURE.md", "server/tests/a.test.ts"] });
    expect(report.ok).toBe(true);
    expect(report.requiring).toEqual([]);
  });

  it("passes on an empty change set", () => {
    expect(verify({}).ok).toBe(true);
  });

  it("FAILS on a malformed fragment even when one was added", () => {
    const report = verify({
      changedPaths: ["server/src/a.ts", `${FRAGMENT_DIR}/1191-x.md`],
      fragmentFiles: { "1191-x.md": fragmentText({ issue: "1191", section: "Nonsense" }) },
    });
    expect(report.ok).toBe(false);
    expect(report.problems.join("\n")).toContain('section is "Nonsense"');
  });

  it("truncates a long requiring list but reports the true count", () => {
    const changedPaths = Array.from({ length: 9 }, (_, i) => `server/src/f${i}.ts`);
    const report = verify({ changedPaths });
    expect(report.requiring).toHaveLength(9);
    expect(report.problems.join("\n")).toContain("changes 9 non-exempt file(s)");
    expect(report.problems.join("\n")).toContain("and 4 more");
  });

  it("REFUSES to run without baseFragments rather than assuming none exist", () => {
    // Defaulting this to [] would read as "nothing pre-exists", which is the
    // fail-open reading and exactly the shape #1168 shipped.
    expect(() =>
      // @ts-expect-error deliberately omitting the required input
      verifyChangelogFragments({ changedPaths: [], fragmentFiles: {} }),
    ).toThrow(/requires baseFragments/);
  });

  /**
   * The three ways a branch passed the gate with no real fragment. Each is an
   * IDENTITY mutation — which file counts as a fragment — rather than a content
   * mutation, and every one of them exited 0 before the intersection landed.
   */
  describe("no fragment of this branch's own", () => {
    const sourceChanged = ["server/src/a.ts"];

    it("BYPASS A: a dotfile counts for nothing, and is named in the failure", () => {
      const report = verify({
        changedPaths: [...sourceChanged, `${FRAGMENT_DIR}/.sneaky.md`],
        // The disk reader never returns it, which is the whole asymmetry.
        fragmentFiles: {},
      });
      expect(report.ok).toBe(false);
      expect(report.contributed).toEqual([]);
      expect(report.problems.join("\n")).toContain(".sneaky.md");
      expect(report.problems.join("\n")).toContain("not a fragment");
    });

    it("BYPASS B: editing a fragment already on the base ref is not a contribution", () => {
      const report = verify({
        changedPaths: [...sourceChanged, `${FRAGMENT_DIR}/900-theirs.md`],
        fragmentFiles: { "900-theirs.md": fragmentText({ issue: "900", section: "Fixed" }) },
        baseFragments: ["900-theirs.md"],
      });
      expect(report.ok).toBe(false);
      expect(report.contributed).toEqual([]);
      expect(report.problems.join("\n")).toContain("already on the base ref");
    });

    it("BYPASS C: deleting a fragment is not a contribution", () => {
      const report = verify({
        changedPaths: [...sourceChanged, `${FRAGMENT_DIR}/900-theirs.md`],
        fragmentFiles: {},
        baseFragments: ["900-theirs.md"],
      });
      expect(report.ok).toBe(false);
      expect(report.contributed).toEqual([]);
      expect(report.problems.join("\n")).toContain("adds no changelog fragment");
    });

    it("withdrawing your OWN fragment leaves nothing behind", () => {
      // Committed on the branch, then deleted before the gate ran: the path is
      // in the diff but there is no file, and the base never had one.
      const report = verify({
        changedPaths: [...sourceChanged, `${FRAGMENT_DIR}/1191-x.md`],
        fragmentFiles: {},
      });
      expect(report.ok).toBe(false);
      expect(report.contributed).toEqual([]);
      expect(report.problems.join("\n")).toContain("not on disk");
    });

    it("a NEW fragment that does not parse is not a contribution either", () => {
      const report = verify({
        changedPaths: [...sourceChanged, `${FRAGMENT_DIR}/1191-x.md`],
        fragmentFiles: { "1191-x.md": "no frontmatter at all\n" },
      });
      expect(report.ok).toBe(false);
      expect(report.contributed).toEqual([]);
      expect(report.problems.join("\n")).toContain("does not parse");
    });

    it("but a real fragment still passes while touching all three", () => {
      // The over-blocking guard: none of the above is a reason to reject a
      // branch that did write its own entry.
      const report = verify({
        changedPaths: [
          ...sourceChanged,
          `${FRAGMENT_DIR}/.sneaky.md`,
          `${FRAGMENT_DIR}/900-theirs.md`,
          `${FRAGMENT_DIR}/1191-x.md`,
        ],
        fragmentFiles: {
          "900-theirs.md": fragmentText({ issue: "900", section: "Fixed" }),
          ...good,
        },
        baseFragments: ["900-theirs.md"],
      });
      expect(report.problems).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.contributed).toEqual([`${FRAGMENT_DIR}/1191-x.md`]);
    });

    it("does not demand a fragment for an exempt-only branch that deletes one", () => {
      // A release cut deletes every fragment and changes nothing requiring an
      // entry; that must not fail.
      const report = verify({
        changedPaths: ["CHANGELOG.md", `${FRAGMENT_DIR}/900-theirs.md`],
        fragmentFiles: {},
        baseFragments: ["900-theirs.md"],
      });
      expect(report.ok).toBe(true);
    });
  });
});

describe("renderVersionSection", () => {
  const added = parseFragment(
    "1191-a.md",
    fragmentText({ issue: "1191", section: "Added" }, "- Added a thing."),
  );
  const fixed = parseFragment(
    "1100-b.md",
    fragmentText({ issue: "1100", section: "Fixed" }, "- Fixed a thing."),
  );
  const alsoAdded = parseFragment(
    "1050-c.md",
    fragmentText({ issue: "1050", section: "Added" }, "- Added an earlier thing."),
  );

  it("renders sections in Keep a Changelog order, not fragment order", () => {
    const out = renderVersionSection({
      fragments: [fixed, added],
      version: "1.1.0",
      date: "2026-08-01",
    });
    expect(out.indexOf("### Added")).toBeLessThan(out.indexOf("### Fixed"));
  });

  it("appends the issue reference to every top-level bullet", () => {
    const out = renderVersionSection({ fragments: [added], version: "1.1.0", date: "2026-08-01" });
    expect(out).toContain("- Added a thing. (#1191)");
  });

  it("puts the reference before a nested sub-point, not after it", () => {
    const nested = parseFragment(
      "7-n.md",
      fragmentText({ issue: "7", section: "Added" }, "- Top.\n  - Nested."),
    );
    const out = renderVersionSection({ fragments: [nested], version: "1.1.0", date: "2026-08-01" });
    expect(out).toContain("- Top. (#7)");
    expect(out).toContain("  - Nested.\n");
    expect(out).not.toContain("Nested. (#7)");
  });

  it("puts the reference at the END of a soft-wrapped entry, not mid-sentence", () => {
    const wrapped = parseFragment(
      "7-w.md",
      fragmentText(
        { issue: "7", section: "Added" },
        "- A long entry that runs on\n  and finishes here.",
      ),
    );
    const out = renderVersionSection({
      fragments: [wrapped],
      version: "1.1.0",
      date: "2026-08-01",
    });
    expect(out).toContain("- A long entry that runs on\n  and finishes here. (#7)");
    expect(out).not.toContain("runs on (#7)");
  });

  it("references each of several entries in one fragment independently", () => {
    const multi = parseFragment(
      "7-m.md",
      fragmentText({ issue: "7", section: "Added" }, "- First entry.\n- Second entry."),
    );
    const out = renderVersionSection({ fragments: [multi], version: "1.1.0", date: "2026-08-01" });
    expect(out).toContain("- First entry. (#7)");
    expect(out).toContain("- Second entry. (#7)");
  });

  it("orders entries within a section by issue number", () => {
    const out = renderVersionSection({
      fragments: [added, alsoAdded],
      version: "1.1.0",
      date: "2026-08-01",
    });
    expect(out.indexOf("earlier thing")).toBeLessThan(out.indexOf("Added a thing"));
  });

  it("writes the heading in the shape CHANGELOG.md already uses", () => {
    const out = renderVersionSection({ fragments: [added], version: "1.1.0", date: "2026-08-01" });
    expect(out.split("\n")[0]).toBe("## [v1.1.0] - 2026-08-01");
  });

  it("accepts a v-prefixed version and does not double the prefix", () => {
    const out = renderVersionSection({ fragments: [added], version: "v2.0.0", date: "2026-08-01" });
    expect(out.split("\n")[0]).toBe("## [v2.0.0] - 2026-08-01");
  });

  it("omits sections with no fragments", () => {
    const out = renderVersionSection({ fragments: [added], version: "1.1.0", date: "2026-08-01" });
    expect(out).not.toContain("### Fixed");
    expect(out).not.toContain("### Security");
  });

  it.each(["", "1.1", "next", "1.1.0.0"])("throws on invalid version %s", (version) => {
    expect(() => renderVersionSection({ fragments: [added], version, date: "2026-08-01" })).toThrow(
      /Invalid version/,
    );
  });

  it.each(["", "2026-8-1", "01-08-2026"])("throws on invalid date %s", (date) => {
    expect(() => renderVersionSection({ fragments: [added], version: "1.1.0", date })).toThrow(
      /Invalid date/,
    );
  });

  it("throws when there is nothing to release", () => {
    expect(() =>
      renderVersionSection({ fragments: [], version: "1.1.0", date: "2026-08-01" }),
    ).toThrow(/nothing to release/);
  });
});

describe("insertVersionSection", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- A legacy entry.",
    "",
    "## [v1.0.0] - 2026-04-25",
    "",
    "- The first release.",
    "",
  ].join("\n");
  const rendered = "## [v1.1.0] - 2026-08-01\n\n### Added\n\n- New. (#1)\n";

  it("inserts below [Unreleased] and above the previous version", () => {
    const out = insertVersionSection(changelog, rendered);
    expect(out.indexOf("## [Unreleased]")).toBeLessThan(out.indexOf("## [v1.1.0]"));
    expect(out.indexOf("## [v1.1.0]")).toBeLessThan(out.indexOf("## [v1.0.0]"));
  });

  it("leaves the legacy [Unreleased] body untouched", () => {
    expect(insertVersionSection(changelog, rendered)).toContain("- A legacy entry.");
  });

  it("keeps exactly one blank line before the next heading", () => {
    const out = insertVersionSection(changelog, rendered);
    expect(out).toContain("- New. (#1)\n\n## [v1.0.0]");
  });

  it("appends when [Unreleased] is the only heading", () => {
    const out = insertVersionSection("# Changelog\n\n## [Unreleased]\n\n- Legacy.\n", rendered);
    expect(out).toContain("- Legacy.");
    expect(out).toContain("## [v1.1.0]");
    expect(out.indexOf("- Legacy.")).toBeLessThan(out.indexOf("## [v1.1.0]"));
  });

  it("inserts above the first heading when there is no [Unreleased]", () => {
    const out = insertVersionSection(
      "# Changelog\n\n## [v1.0.0] - 2026-04-25\n\n- First.\n",
      rendered,
    );
    expect(out.indexOf("## [v1.1.0]")).toBeLessThan(out.indexOf("## [v1.0.0]"));
  });

  it("appends to a file with no ## heading at all", () => {
    expect(insertVersionSection("# Changelog\n", rendered)).toContain("## [v1.1.0]");
  });

  it("tolerates a non-string changelog", () => {
    expect(insertVersionSection(null, rendered)).toContain("## [v1.1.0]");
  });

  it("round-trips: assembled output re-parses as the same entries", () => {
    const fragment = parseFragment(
      "1191-x.md",
      fragmentText({ issue: "1191", section: "Added" }, "- A round-tripped entry."),
    );
    const section = renderVersionSection({
      fragments: [fragment],
      version: "1.1.0",
      date: "2026-08-01",
    });
    const out = insertVersionSection(changelog, section);
    expect(out).toContain("### Added\n\n- A round-tripped entry. (#1191)");
  });
});
