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
  parseChangeRequest,
  requestRetrievalText,
  shapeAwareChangeExtractor,
} from "./change-request.js";
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
