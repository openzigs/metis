/**
 * #1036 — one change with sub-aspects, instead of one "requirement" per heading.
 *
 * The fixtures are the VERBATIM issue texts impact analysis was given in
 * walkthrough run 7 (`__fixtures__/miniflux-*.md`). A condensed fixture is what
 * let #1045 pass in test and fail in production, so these are not paraphrased.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changeFromRequest,
  extractChangesByShape,
  parseChangeRequest,
  requestGateText,
  requestRetrievalText,
  shapeAwareChangeExtractor,
} from "./change-request.js";
import { seedQueries } from "./change-seeds.js";
import { extractChangesHeuristically } from "./extract-changes.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (issue: number): string =>
  readFileSync(join(here, "__fixtures__", `miniflux-${issue}.md`), "utf8");

const ISSUE_4478 = fixture(4478);
const ISSUE_4336 = fixture(4336);
const ISSUE_4479 = fixture(4479);
const ISSUE_4386 = fixture(4386);

/** A genuine multi-requirement document (the #964 fixture's shape). */
const MULTI_REQUIREMENT_DOC = `# Release 2.0 requirements

## Password reset

Users must be able to request a password reset link by email.

## Session timeout

The idle session timeout is changed from 30 minutes to 15 minutes.

Notification channels:

- Add a Slack notification channel.
- Delete the unused pager channel.`;

describe("parseChangeRequest — the verbatim run-7 #4478 issue (#1036)", () => {
  const request = parseChangeRequest(ISSUE_4478)!;

  it("reads the issue as ONE request, titled without the form's [Feature]: prefix", () => {
    expect(request).not.toBeNull();
    expect(request.title).toBe("Mark all as read older than X");
    expect(request.kind).toBe("feature");
  });

  it("does not repeat a summary that only restates the title", () => {
    expect(request.primaryRequest).toBe("Mark all as read older than X");
  });

  it("keeps the proposed solution as a sub-aspect of that request", () => {
    expect(request.subAspects).toEqual([
      {
        heading: "Proposed Solution",
        text: "A dropdown on the mark as read for times. Times could be configured in settings.",
      },
    ]);
  });

  it("keeps the problem statement and the alternatives as context, not as requests", () => {
    expect(request.context.map((s) => s.heading)).toEqual([
      "What problem does this feature solve?",
      "Alternatives Considered",
    ]);
  });

  it("drops the form's empty-field placeholder and says why", () => {
    expect(request.ignored).toEqual([
      { heading: "Additional Context", text: "_No response_", reason: "placeholder" },
    ]);
  });
});

describe("parseChangeRequest — noise a pasted issue carries (#1036)", () => {
  it("drops a bare URL line but keeps the sentence around it (#4479)", () => {
    const request = parseChangeRequest(ISSUE_4479)!;
    const ignored = request.ignored.map((i) => `${i.reason}: ${i.text}`);
    expect(ignored).toContain(
      "url: https://github.com/miniflux/v2/blob/main/internal/googlereader/README.md",
    );
    const description = request.context.find((s) => s.heading === "Description")!;
    expect(description.text).toContain("As per the google reader api doc");
    expect(description.text).not.toContain("https://");
  });

  it("drops the version field (#4479)", () => {
    const request = parseChangeRequest(ISSUE_4479)!;
    expect(request.ignored).toContainEqual({
      heading: "Version",
      text: "2.3.3",
      reason: "version",
    });
    expect(request.kind).toBe("bug");
  });

  it("drops the sign-off, the version and the browser, and keeps every numbered step (#4386)", () => {
    const request = parseChangeRequest(ISSUE_4386)!;
    expect(request.ignored).toContainEqual({
      heading: "Additional Context",
      text: "Thank you for Miniflux!",
      reason: "sign-off",
    });
    expect(request.ignored).toContainEqual({
      heading: "Version",
      text: "2.3.1",
      reason: "version",
    });
    expect(request.ignored).toContainEqual({
      heading: "Browser",
      text: "Chrome",
      reason: "environment",
    });
    const steps = request.context.find((s) => s.heading === "Steps to Reproduce")!;
    expect(steps.text.split("\n")).toHaveLength(4);
  });

  it("treats what the reporter expected as part of the request, and what happened as context (#4386)", () => {
    const request = parseChangeRequest(ISSUE_4386)!;
    expect(request.subAspects.map((s) => s.heading)).toEqual(["Expected Behavior"]);
    expect(request.context.map((s) => s.heading)).toContain("Actual Behavior");
  });

  it("reads an issue written with its own headings, not a form's (#4336)", () => {
    const request = parseChangeRequest(ISSUE_4336)!;
    expect(request.title).toBe("Track reading time — add read_at timestamp to entries");
    // No summary section: the title is the request.
    expect(request.primaryRequest).toBe(request.title);
    // "API changes" and "Database migration" are not form headings; inside an
    // issue they elaborate the request.
    expect(request.subAspects.map((s) => s.heading)).toEqual([
      "Proposed Solution",
      "API changes",
      "Database migration",
    ]);
    expect(request.context.map((s) => s.heading)).toEqual(["Problem", "Why"]);
  });

  it("takes the first line as the title when the paste has no # heading", () => {
    const text = ISSUE_4336.replace(/^# /, "");
    expect(parseChangeRequest(text)!.title).toBe(
      "Track reading time — add read_at timestamp to entries",
    );
  });

  it("does not read a '#' inside a code fence as a heading", () => {
    const text = [
      "# [Bug]: build fails",
      "### Bug Summary",
      "The build fails.",
      "### Steps to Reproduce",
      "```sh",
      "# install first",
      "make build",
      "```",
    ].join("\n\n");
    const request = parseChangeRequest(text)!;
    expect(request.context).toHaveLength(1);
    expect(request.context[0]!.text).toContain("# install first");
  });
});

describe("parseChangeRequest — choosing the mode from the input's shape (#1036)", () => {
  it("returns null for a genuine multi-requirement document", () => {
    expect(parseChangeRequest(MULTI_REQUIREMENT_DOC)).toBeNull();
  });

  it("returns null for plain paragraphs and bullet lists", () => {
    expect(parseChangeRequest("First requirement.\n\nSecond one.")).toBeNull();
    expect(parseChangeRequest("- alpha\n- beta\n- gamma")).toBeNull();
    expect(parseChangeRequest("")).toBeNull();
  });

  it("is not an issue on ONE recognised heading — the near miss", () => {
    // A requirements doc may well have a "Summary" section. One form heading is
    // not a form.
    const text = "# Billing\n\n## Summary\n\nInvoices.\n\n## Refunds\n\nRefunds must be audited.";
    expect(parseChangeRequest(text)).toBeNull();
  });

  it("is not an issue on ONE recognised heading and nothing else — the threshold itself", () => {
    // No unknown heading here, so the "template headings must outnumber the
    // others" rule passes (1 > 0) and ONLY the two-heading minimum says no. The
    // fixture above is turned away by that other rule, and left the minimum
    // unpinned (PR #1090 panel).
    const one = "# Billing\n\n## Summary\n\nInvoices are sent monthly.";
    expect(parseChangeRequest(one)).toBeNull();
    // The same text with a second template heading IS an issue.
    const two = `${one}\n\n## Problem\n\nThey arrive late.`;
    expect(parseChangeRequest(two)?.title).toBe("Billing");
  });

  it("stays a document when its own headings are as many as the template ones", () => {
    // Background + Problem, then one section per requirement: a requirements
    // document that opens the way an issue does.
    const text = [
      "# Account security",
      "## Background",
      "Accounts are being taken over.",
      "## Problem",
      "There is no second factor.",
      "## Password reset",
      "Users must be able to request a password reset link by email.",
      "## Session timeout",
      "The idle session timeout is changed from 30 minutes to 15 minutes.",
    ].join("\n\n");
    expect(parseChangeRequest(text)).toBeNull();
    // One more template heading than unknown ones is an issue (the #4336 shape: 3 to 2).
    expect(parseChangeRequest(`${text}\n\n## Why\n\nCompliance asked.`)).not.toBeNull();
  });

  it("stays a document when a heading introduces a requirement list", () => {
    const text = [
      "# Checkout redesign",
      "## Problem",
      "Checkout is slow.",
      "## Proposed Solution",
      "Rebuild it.",
      "## Requirements",
      "- Pay by card.\n- Pay by invoice.",
    ].join("\n\n");
    expect(parseChangeRequest(text)).toBeNull();
  });

  it("stays a document when it has more than one top-level title", () => {
    const text = "# A\n\n## Problem\n\nx\n\n## Proposed Solution\n\ny\n\n# B\n\n## Problem\n\nz";
    expect(parseChangeRequest(text)).toBeNull();
  });
});

describe("changeFromRequest (#1036)", () => {
  it("builds one change whose body carries the request, its sub-aspects and its context", () => {
    const change = changeFromRequest(parseChangeRequest(ISSUE_4478)!);
    expect(change.title).toBe("Mark all as read older than X");
    expect(change.changeType).toBe("added");
    expect(change.body).toContain("Proposed Solution:\nA dropdown on the mark as read for times.");
    expect(change.body).toContain("Right now you can either mark a page as read");
    expect(change.body).not.toContain("_No response_");
    expect(change.bodyDelta).toBe(change.body.length);
    expect(change.request?.title).toBe(change.title);
  });

  it("types a bug report as a modification of existing behaviour", () => {
    expect(changeFromRequest(parseChangeRequest(ISSUE_4386)!).changeType).toBe("modified");
  });

  it("does not let an incidental verb in the context decide the change type", () => {
    // "Alternatives Considered" mentions nothing here, but #4336's context says
    // "updates whenever an entry is modified" — the request itself is an addition.
    expect(changeFromRequest(parseChangeRequest(ISSUE_4336)!).changeType).toBe("added");
  });
});

describe("requestRetrievalText (#1036)", () => {
  it("leaves out the alternatives the reporter rejected", () => {
    const text = requestRetrievalText(parseChangeRequest(ISSUE_4478)!);
    expect(text).toContain("A dropdown on the mark as read for times");
    expect(text).not.toContain("miniflux-sanity");
  });

  it("leaves out code fences, which name JSON keys and SQL rather than code to find", () => {
    const text = requestRetrievalText(parseChangeRequest(ISSUE_4336)!);
    expect(text).toContain("Add a `read_at` TIMESTAMP column");
    expect(text).not.toContain("CREATE INDEX");
    expect(text).not.toContain('"title": "..."');
  });
});

describe("shapeAwareChangeExtractor (#1036)", () => {
  it("returns ONE change for each of the run-7 issues the splitter cut into 5 to 12", async () => {
    for (const text of [ISSUE_4478, ISSUE_4336, ISSUE_4479, ISSUE_4386]) {
      expect(extractChangesHeuristically(text).length).toBeGreaterThanOrEqual(5);
      expect(await shapeAwareChangeExtractor.extract(text)).toHaveLength(1);
    }
  });

  it("keeps today's splitter for a multi-requirement document", async () => {
    const changes = await shapeAwareChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    expect(changes).toEqual(extractChangesHeuristically(MULTI_REQUIREMENT_DOC));
    expect(changes.length).toBeGreaterThan(1);
    expect(changes.every((c) => c.request === undefined)).toBe(true);
  });
});

describe("parseChangeRequest — GitHub's stock markdown templates use bold lines, not headings (PR #1090 review)", () => {
  // github.com → New issue → the default "Bug report" and "Feature request"
  // templates, as they arrive in a paste. No `#` heading anywhere.
  const BUG = [
    "**Describe the bug**",
    "Marking a page as read leaves the unread counter unchanged.",
    "",
    "**To Reproduce**",
    "Steps to reproduce the behavior:",
    "1. Go to the unread page",
    "2. Click on 'Mark this page as read'",
    "",
    "**Expected behavior**",
    "The counter drops by the number of entries on the page.",
    "",
    "**Screenshots**",
    "_No response_",
    "",
    "**Desktop (please complete the following information):**",
    " - OS: macOS",
    " - Browser: Firefox",
    "",
    "**Additional context**",
    "It worked in 2.2.",
  ].join("\n");
  const FEATURE = [
    "**Is your feature request related to a problem? Please describe.**",
    "I can only mark a page or everything as read.",
    "",
    "**Describe the solution you'd like**",
    "Mark all as read older than X days.",
    "",
    "**Describe alternatives you've considered**",
    "A tool called `miniflux-sanity` stores a cutoff and can do this.",
    "",
    "**Additional context**",
    "None.",
  ].join("\n");

  it("reads the stock bug report as ONE change, typed as a bug", () => {
    const changes = extractChangesByShape(BUG);
    expect(changes).toHaveLength(1);
    const request = changes[0]!.request!;
    expect(request.kind).toBe("bug");
    expect(changes[0]!.changeType).toBe("modified");
    expect(request.primaryRequest).toBe(
      "Marking a page as read leaves the unread counter unchanged.",
    );
    expect(request.subAspects.map((s) => s.heading)).toEqual(["Expected behavior"]);
    expect(request.context.map((s) => s.heading)).toEqual(["To Reproduce", "Additional context"]);
    // The environment block and the empty field carry no request.
    expect(request.ignored.map((i) => [i.reason, i.text])).toEqual([
      ["placeholder", "_No response_"],
      ["environment", "- OS: macOS"],
      ["environment", "- Browser: Firefox"],
    ]);
  });

  it("reads the stock feature request as ONE change, and keeps the rejected alternative out of the search", () => {
    const changes = extractChangesByShape(FEATURE);
    expect(changes).toHaveLength(1);
    const request = changes[0]!.request!;
    expect(request.kind).toBe("feature");
    expect(request.subAspects.map((s) => s.heading)).toEqual(["Describe the solution you'd like"]);
    expect(request.context.map((s) => s.heading)).toEqual([
      "Is your feature request related to a problem? Please describe.",
      "Describe alternatives you've considered",
    ]);
    // "None." under Additional context is an empty field, not context.
    expect(request.ignored).toEqual([
      { heading: "Additional context", text: "None.", reason: "placeholder" },
    ]);
    expect(requestRetrievalText(request)).toContain("Mark all as read older than X days.");
    expect(requestRetrievalText(request)).not.toContain("miniflux-sanity");
  });

  it("accepts a typographic apostrophe and `__bold__`", () => {
    const text = FEATURE.replace("you'd", "you\u2019d").replaceAll("**", "__");
    expect(extractChangesByShape(text)).toHaveLength(1);
  });

  it("leaves a bold line that is not a template label as prose", () => {
    const doc = "**Refunds**\n\nRefunds must be audited.\n\n**Invoices**\n\nInvoices are monthly.";
    expect(parseChangeRequest(doc)).toBeNull();
    // Inside an issue, an emphasised sentence stays part of its section.
    const request = parseChangeRequest(
      "# T\n\n### Summary\n\nDo it.\n\n**Important**\n\n### Problem\n\nIt is slow.",
    )!;
    expect(request.primaryRequest).toContain("**Important**");
  });

  it("does not read a bold line inside a code fence as a heading", () => {
    const text = `${BUG}\n\n\`\`\`md\n**Describe the bug**\n\`\`\``;
    const request = parseChangeRequest(text)!;
    expect(request.context.at(-1)!.text).toContain("**Describe the bug**");
  });
});

describe("a requirements document marked up in bold is not one issue (#1036, PR #1090 review 2)", () => {
  const requirements = (mark: (label: string) => string) =>
    [
      "Release 4 requirements",
      mark("Background"),
      "The export is manual today.",
      mark("Context"),
      "Three teams depend on it.",
      mark("REQ-1 Export"),
      "The system shall export invoices as CSV.",
      mark("REQ-2 Import"),
      "The system shall import invoices from CSV.",
      mark("REQ-3 Audit"),
      "The system shall record who ran each export.",
    ].join("\n\n");

  it("goes to the splitter with `#` headings — the behaviour bold has to match", () => {
    const text = requirements((label) => `### ${label}`);
    expect(parseChangeRequest(text)).toBeNull();
    expect(extractChangesByShape(text).length).toBeGreaterThan(1);
  });

  it.each([
    ["**bold**", (label: string) => `**${label}**`],
    ["__bold__", (label: string) => `__${label}__`],
    ["**bold**:", (label: string) => `**${label}**:`],
    ["**bold** with trailing spaces", (label: string) => `**${label}**   `],
  ])(
    "goes to the splitter with %s labels: unknown labels count against the template",
    (_n, mark) => {
      const text = requirements(mark);
      expect(parseChangeRequest(text)).toBeNull();
      const changes = extractChangesByShape(text);
      expect(changes.length).toBeGreaterThan(1);
      expect(changes.every((c) => c.request === undefined)).toBe(true);
      // Each requirement is read, where one issue would have buried them in "Context".
      const all = changes.map((c) => `${c.title}\n${c.body}`).join("\n");
      for (const shall of ["export invoices as CSV", "import invoices from CSV", "who ran each"]) {
        expect(all).toContain(shall);
      }
    },
  );

  it.each([
    ["**bold**", (label: string) => `**${label}**`],
    ["**bold**:", (label: string) => `**${label}**:`],
    ["**bold** and twenty trailing spaces", (label: string) => `**${label}**${" ".repeat(20)}`],
    ["**bold**: and twenty trailing spaces", (label: string) => `**${label}**:${" ".repeat(20)}`],
    ["**bold** and a trailing tab", (label: string) => `**${label}**\t`],
  ])("still reads a real bold-template bug report as ONE change, marked %s", (_n, mark) => {
    const bug = [
      "Counter does not update",
      mark("Describe the bug"),
      "Marking a page as read leaves the unread counter unchanged.",
      mark("To Reproduce"),
      "1. Open the unread page\n2. Click mark page as read",
      mark("Expected behavior"),
      "The counter drops by the number of entries on the page.",
      mark("Additional context"),
      "Seen on 2.3.3.",
    ].join("\n\n");
    const changes = extractChangesByShape(bug);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.request!.kind).toBe("bug");
    expect(changes[0]!.request!.subAspects.map((s) => s.heading)).toEqual(["Expected behavior"]);
  });

  it("one emphasised line in a real issue does not tip it: unknown labels must reach the known count", () => {
    const text =
      "# T\n\n### Summary\n\nDo it.\n\n**Important**\n\n### Problem\n\nIt is slow.\n\n### Proposed Solution\n\nCache it.";
    const request = parseChangeRequest(text)!;
    expect(request).not.toBeNull();
    // …and the line stays prose in its section; it opens none.
    expect(request.primaryRequest).toContain("**Important**");
    expect(request.subAspects.map((s) => s.heading)).toEqual(["Proposed Solution"]);
  });

  it("does not count a bold line inside a code fence", () => {
    const text =
      "# T\n\n### Summary\n\nDo it.\n\n### Problem\n\n```md\n**One**\n\n**Two**\n\n**Three**\n```";
    expect(parseChangeRequest(text)).not.toBeNull();
  });
});

describe("requestGateText — what the request asks, without what surrounds it (#791, PR #1090 review)", () => {
  const ISSUE = [
    "# [Feature]: Prune old entries",
    "### Feature Summary",
    "Delete entries older than 30 days.",
    "### What problem does this feature solve?",
    "The database grows. We should track how big it gets.",
    "### Proposed Solution",
    "A nightly job. Record on the feed when it was last pruned. The old script keeps a log.",
    "### Alternatives Considered",
    "ALTER TABLE feeds ADD COLUMN pruned_at TIMESTAMPTZ; was suggested and should be stored.",
  ].join("\n\n");
  const [change] = extractChangesByShape(ISSUE);
  const gateText = requestGateText(change!);

  it("asks with the primary request and the sub-aspects, and no context section", () => {
    expect(gateText.ask).toContain("Delete entries older than 30 days.");
    expect(gateText.ask).toContain("A nightly job.");
    expect(gateText.ask).not.toContain("The database grows");
    expect(gateText.ask).not.toContain("ALTER TABLE");
  });

  it("is the ask and nothing else: no list of statements for a cue to be read from", () => {
    // The record cue that read them is gone (PR #1090 review 2), and so are they.
    expect(Object.keys(gateText)).toEqual(["ask"]);
  });

  it("reads all of a splitter-made change: one requirement is all ask", () => {
    const text = requestGateText({ title: "Refunds", body: "Refunds are audited. Keep a log." });
    expect(text).toEqual({ ask: "Refunds\nRefunds are audited. Keep a log." });
  });
});

describe("parsing stays linear on a 200 KB paste (PR #1090 review)", () => {
  function bestOf3(run: () => unknown): number {
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      run();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }
  const SIZE = 200_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
  const issueWith = (body: string) =>
    `# [Feature]: Mark all as read older than X\n\n### Feature Summary\n\n${body}\n\n### Proposed Solution\n\n${body}\n`;
  const INPUTS: Record<string, string> = {
    "one whitespace-free token": fill("a."),
    "a run of [ (an unclosed link label)": issueWith(fill("[")),
    "unclosed links": issueWith(fill("[a](http://x")),
    "a heading of question marks": `# ${fill("?")}x\n\n### Summary\n\nx\n\n### Problem\n\ny`,
    "a section heading of question marks": `# T\n\n### Summary\n\nx\n\n### ${fill("?")}x\n\ny\n\n### Problem\n\nz`,
    "a heading followed by spaces": `#${fill(" ")}x`,
    "a bold line that never closes": `**${fill("a")}`,
    // PR #1090 review 2: 23 s on the pattern this replaced, inside a recognised issue.
    "a bold label, spaces, then a character": issueWith(`**a**${fill(" ")}x`),
    "a bold label, a colon, spaces, then a character": issueWith(`**a**:${fill(" ")}x`),
    "minified JSON in an issue": issueWith(fill('{"a":[1,2],"b":"c"},')),
  };

  it.each(Object.keys(INPUTS))(
    "%s: parse, split and build the search queries well under 100 ms",
    (name) => {
      const text = INPUTS[name]!;
      expect(text.length).toBeGreaterThanOrEqual(SIZE);
      expect(bestOf3(() => parseChangeRequest(text))).toBeLessThan(100);
      const changes = extractChangesByShape(text);
      expect(bestOf3(() => changes.map((c) => seedQueries(c)))).toBeLessThan(100);
      expect(bestOf3(() => changes.map((c) => requestGateText(c)))).toBeLessThan(100);
    },
  );
});
