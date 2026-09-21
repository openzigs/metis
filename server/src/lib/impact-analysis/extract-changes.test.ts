/**
 * #964 — deterministic change-extraction tests.
 *
 * Covers the improved {@link heuristicChangeExtractor}: heading awareness,
 * numbered / bullet requirement segmentation, first-sentence titles, and
 * verb-based {@link ChangeType} classification (added / modified / removed).
 * The multi-requirement fixture below is a realistic requirements-delta doc.
 */
import { describe, expect, it } from "vitest";
import { extractChangesHeuristically, heuristicChangeExtractor } from "./extract-changes.js";

/**
 * A realistic multi-requirement change document exercising every branch:
 * a bare section divider heading, headings that name a requirement, a numbered
 * requirement list, a bullet list, and standalone paragraphs whose verbs imply
 * added / modified / removed.
 */
const MULTI_REQUIREMENT_DOC = `# Release 2.0 requirements

## Password reset

Users must be able to request a password reset link by email.

## Session timeout

The idle session timeout is changed from 30 minutes to 15 minutes.

Numbered requirements:

1. The export endpoint must support CSV output.
2. Deprecated: the legacy XML export is removed.

Notification channels:

- Add a Slack notification channel.
- Rename the "alerts" channel to "incidents".
- Delete the unused pager channel.

The public status page will be discontinued.`;

describe("heuristicChangeExtractor — multi-requirement doc (#964)", () => {
  it("segments the document into one titled requirement per change", async () => {
    const changes = await heuristicChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    // 2 heading-named + 2 numbered + 3 bullets + 1 trailing paragraph = 8.
    // The bare "# Release 2.0 requirements" divider yields no requirement.
    expect(changes).toHaveLength(8);
  });

  it("uses the section heading as the requirement title", async () => {
    const changes = await heuristicChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    const titles = changes.map((c) => c.title);
    expect(titles).toContain("Password reset");
    expect(titles).toContain("Session timeout");
  });

  it("does not emit a requirement for a bare section-divider heading", async () => {
    const changes = await heuristicChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    expect(changes.map((c) => c.title)).not.toContain("Release 2.0 requirements");
  });

  it("classifies change verbs (added / modified / removed)", async () => {
    const changes = await heuristicChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    const byBodyIncludes = (needle: string) =>
      changes.find((c) => c.body.toLowerCase().includes(needle.toLowerCase()));

    expect(byBodyIncludes("password reset link")?.changeType).toBe("added");
    expect(byBodyIncludes("idle session timeout is changed")?.changeType).toBe("modified");
    expect(byBodyIncludes("legacy XML export is removed")?.changeType).toBe("removed");
    expect(byBodyIncludes("Add a Slack notification channel")?.changeType).toBe("added");
    expect(byBodyIncludes('Rename the "alerts" channel')?.changeType).toBe("modified");
    expect(byBodyIncludes("Delete the unused pager channel")?.changeType).toBe("removed");
    expect(byBodyIncludes("status page will be discontinued")?.changeType).toBe("removed");
  });

  it("keeps requirementId null for every deterministic change (no FK link)", async () => {
    const changes = await heuristicChangeExtractor.extract(MULTI_REQUIREMENT_DOC);
    expect(changes.every((c) => c.requirementId === null)).toBe(true);
    expect(changes.every((c) => c.bodyDelta === c.body.length)).toBe(true);
  });

  it("splits a numbered requirement list into one change per item", async () => {
    const changes = await heuristicChangeExtractor.extract(
      "1. First requirement here.\n2. Second requirement here.\n3. Third requirement here.",
    );
    expect(changes.map((c) => c.body)).toEqual([
      "First requirement here.",
      "Second requirement here.",
      "Third requirement here.",
    ]);
  });

  it("derives the title from the first sentence when there is no heading", async () => {
    const [change] = await heuristicChangeExtractor.extract(
      "Users can reset their password. This must send a signed email token that expires.",
    );
    expect(change.title).toBe("Users can reset their password.");
    expect(change.body).toContain("signed email token");
  });

  it("clips an oversized title to the title budget (#1013 persists it verbatim)", async () => {
    // The title is now written straight into `impact_items.requirementTitle` and
    // rendered as an export heading, so the extractor's 120-char budget is the
    // only thing bounding it. Asserted here rather than at the serializer, which
    // no longer derives titles.
    const [change] = await heuristicChangeExtractor.extract(`${"a".repeat(400)}. Second sentence.`);
    expect(change.title).toBe(`${"a".repeat(117)}...`);
    expect(change.title).toHaveLength(120);
  });

  it("classifies verbs on word boundaries, not substrings", async () => {
    // "additional" must not read as an `add` verb, and no modify/remove verb is
    // present, so the change falls through to the `added` default.
    const [addedLike] = await heuristicChangeExtractor.extract(
      "Provide additional documentation for operators.",
    );
    expect(addedLike.changeType).toBe("added");
    // A genuine modify verb ("updated") must fire the modified path.
    const [modifiedLike] = await heuristicChangeExtractor.extract(
      "The nightly job is updated to run hourly.",
    );
    expect(modifiedLike.changeType).toBe("modified");
  });
});

/**
 * Issue #1136 — acceptance-criteria bullets must not be promoted to standalone
 * requirements.
 *
 * The contract these lock down: a bullet list is a requirement SET only when it
 * is *introduced* as one — standing alone, or after a heading / `Label:` lead-in
 * that names a group of requirements. A list that continues the requirement just
 * stated (directly, or after a label that elaborates rather than groups) is that
 * requirement's detail and is folded into it.
 *
 * The #964 fixture above is the other half of the evidence: `Numbered
 * requirements:` and `Notification channels:` introduce lists of genuinely
 * distinct requirements and still split, which is why the discriminator cannot be
 * "a lead-in label means subordinate".
 */
describe("heuristicChangeExtractor — acceptance-criteria subordination (#1136)", () => {
  /** The walkthrough paste: N requirements, each with an AC lead-in and 3 bullets. */
  const withLeadIn = (n: number): string =>
    Array.from({ length: n }, (_, i) =>
      [
        `R${i + 1}: The system must support feature number ${i + 1}.`,
        "",
        "Acceptance criteria:",
        "",
        `- The feature is reachable from the navigation bar.`,
        `- Roles: owner, editor, viewer.`,
        `- An audit event is written on every use.`,
      ].join("\n"),
    ).join("\n\n");

  it("parses the 10x3 walkthrough paste as 10 requirements, not 40", () => {
    const changes = extractChangesHeuristically(withLeadIn(10));
    expect(changes).toHaveLength(10);
    expect(changes.map((c) => c.body.split("\n")[0])).toEqual(
      Array.from(
        { length: 10 },
        (_, i) => `R${i + 1}: The system must support feature number ${i + 1}.`,
      ),
    );
  });

  it("never promotes a criterion to its own requirement (the NR-10 symptom)", () => {
    const changes = extractChangesHeuristically(withLeadIn(10));
    expect(changes.some((c) => c.body.trim() === "Roles: owner, editor, viewer.")).toBe(false);
  });

  it("keeps the criteria text ON the requirement rather than discarding it", () => {
    const [change] = extractChangesHeuristically(withLeadIn(1));
    expect(change.body).toContain("Acceptance criteria:");
    expect(change.body).toContain("Roles: owner, editor, viewer.");
    expect(change.bodyDelta).toBe(change.body.length);
    // The title still comes from the requirement's own sentence, not a criterion.
    expect(change.title).toBe("R1: The system must support feature number 1.");
  });

  it("does not let a criterion's verb re-classify its parent requirement", () => {
    const [change] = extractChangesHeuristically(
      "Add a workspace archive button.\n\nAcceptance criteria:\n\n- The archived workspace is removed from the sidebar.\n- A toast confirms the action.",
    );
    expect(change.changeType).toBe("added");
  });

  it("folds bullets that follow a requirement with NO label at all (the #1101 paste)", () => {
    const changes = extractChangesHeuristically(
      [
        "R1: The system must support feature number 1.",
        "",
        "- Acceptance criteria for requirement 1 part a.",
        "- Acceptance criteria for requirement 1 part b.",
        "",
        "R2: The system must support feature number 2.",
        "",
        "- Acceptance criteria for requirement 2 part a.",
        "- Acceptance criteria for requirement 2 part b.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(2);
    expect(changes[0].body).toContain("part a.");
    expect(changes[1].body).toContain("requirement 2 part b.");
  });

  it("folds an `### Acceptance criteria` ATX sub-heading the same way", () => {
    const changes = extractChangesHeuristically(
      [
        "## R1 Workspace creation",
        "",
        "The system shall let a user create a workspace.",
        "",
        "### Acceptance criteria",
        "",
        "- The name is required.",
        "- Roles: owner, editor, viewer.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].title).toBe("R1 Workspace creation");
    expect(changes[0].body).toContain("The name is required.");
  });

  it("folds when the label closes the requirement's own block", () => {
    const changes = extractChangesHeuristically(
      [
        "R1: The system must support feature number 1.",
        "Acceptance criteria:",
        "",
        "- The feature is reachable from the navigation bar.",
        "- An audit event is written on every use.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
    // The label was already consumed into the body — it is not repeated.
    expect(changes[0].body.match(/Acceptance criteria:/g)).toHaveLength(1);
  });

  it("folds a label whose detail sits inline in the same block", () => {
    const changes = extractChangesHeuristically(
      [
        "R1: The system must support feature number 1.",
        "",
        "Acceptance criteria:",
        "- The feature is reachable from the navigation bar.",
        "- An audit event is written on every use.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].body).toContain("An audit event is written on every use.");
  });

  it("recognises the label through markdown emphasis and a trailing qualifier", () => {
    for (const label of ["**Acceptance criteria:**", "Acceptance Criteria (R1):", "AC:", "DoD:"]) {
      const changes = extractChangesHeuristically(
        `R1: The system must support feature number 1.\n\n${label}\n\n- One criterion.\n- Another criterion.`,
      );
      expect(changes, label).toHaveLength(1);
    }
  });

  // --- the paths that must NOT regress -------------------------------------

  it("still parses a genuinely bare bullet list as one requirement per bullet", () => {
    const changes = extractChangesHeuristically(
      "- The API must expose /api/status.\n- Analyses must emit an audit event.\n- Exports must support CSV.",
    );
    expect(changes.map((c) => c.body)).toEqual([
      "The API must expose /api/status.",
      "Analyses must emit an audit event.",
      "Exports must support CSV.",
    ]);
  });

  it("still splits a list introduced by a GROUPING label, not a subordinating one", () => {
    const changes = extractChangesHeuristically(
      "The idle session timeout is changed to 15 minutes.\n\nNotification channels:\n\n- Add a Slack channel.\n- Delete the pager channel.",
    );
    expect(changes).toHaveLength(3);
  });

  it("still splits a list under a section heading that follows another requirement", () => {
    const changes = extractChangesHeuristically(
      "## Session timeout\n\nThe idle timeout drops to 15 minutes.\n\n## Notification channels\n\n- Add a Slack channel.\n- Delete the pager channel.",
    );
    expect(changes).toHaveLength(3);
  });

  it("keeps consecutive paragraphs as separate requirements", () => {
    const changes = extractChangesHeuristically("Add a health endpoint.\n\nAdd an audit event.");
    expect(changes).toHaveLength(2);
  });

  it("promotes a subordinating label's list when there is no requirement to attach it to", () => {
    // Nothing precedes it, so folding would discard the user's only input.
    const changes = extractChangesHeuristically(
      "Acceptance criteria:\n\n- The API must expose /api/status.\n- Analyses must emit an audit event.",
    );
    expect(changes).toHaveLength(2);
  });

  it("promotes a bare `### Acceptance criteria` section that opens the paste", () => {
    const changes = extractChangesHeuristically(
      "### Acceptance criteria\n\n- The API must expose /api/status.\n- Analyses must emit an audit event.",
    );
    expect(changes).toHaveLength(2);
  });

  it("promotes an inline-bodied `### Acceptance criteria` that opens the paste", () => {
    const changes = extractChangesHeuristically(
      "### Acceptance criteria\n- The API must expose /api/status.\n- Analyses must emit an audit event.",
    );
    expect(changes).toHaveLength(2);
  });

  it("does not claim a SECOND adjacent bullet block as the same requirement's detail", () => {
    const changes = extractChangesHeuristically(
      [
        "R1: The system must support feature number 1.",
        "",
        "- Criterion a.",
        "- Criterion b.",
        "",
        "- A second list is ambiguous, so it stays a requirement set.",
        "- And so does this one.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(3);
  });

  it("does not fold a single-bullet block (not a list) after a requirement", () => {
    const changes = extractChangesHeuristically(
      "R1: The system must support feature number 1.\n\n- A second standalone requirement.",
    );
    expect(changes).toHaveLength(2);
  });

  it("folds criteria under a heading that carries its requirement inline", () => {
    // `## Heading` + body in ONE block: the heading names THIS requirement, so a
    // following bullet list is still that requirement's detail.
    const changes = extractChangesHeuristically(
      [
        "## Workspace creation",
        "The system shall let a user create a workspace.",
        "",
        "- The name is required.",
        "- Roles: owner, editor, viewer.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].title).toBe("Workspace creation");
    expect(changes[0].body).toContain("Roles: owner, editor, viewer.");
  });

  it("still splits a bullet list that a heading introduces inline", () => {
    const changes = extractChangesHeuristically(
      ["## Notification channels", "- Add a Slack channel.", "- Delete the pager channel."].join(
        "\n",
      ),
    );
    expect(changes).toHaveLength(2);
  });

  it("resets subordination at a non-subordinating lead-in that follows a criteria block", () => {
    const changes = extractChangesHeuristically(
      [
        "R1: The system must support feature number 1.",
        "",
        "Acceptance criteria:",
        "",
        "- Criterion a.",
        "",
        "Numbered requirements:",
        "",
        "1. The export endpoint must support CSV.",
        "2. The legacy XML export is removed.",
      ].join("\n"),
    );
    expect(changes).toHaveLength(3);
  });
});
