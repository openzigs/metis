/**
 * #1369 — raw tool-call frames rendered as prose.
 *
 * The strings here are the exact leak observed in one live answer. Falsifiable:
 * `sanitizeAssistantText` did not exist on `main` and the chat page rendered
 * `m.content` directly, so every assertion below fails without it.
 */
import { describe, it, expect } from "vitest";
import { sanitizeAssistantText } from "./sanitize-assistant-text";

const LEAKED_ANSWER = [
  "Here is what I found.",
  '<br>{"name": "bash", "input": {"command": "grep -rn -i \\"order-batch\\" server/src 2>/dev/null | head -50", "description": "Search for OrderBatch references"}}',
  "Tool ran without output or approval to run.",
  "system<system_notification>Bash command completed with empty output (exit code 0)</system_notification>",
  "The batch runs nightly.",
].join("\n");

describe("sanitizeAssistantText (#1369)", () => {
  it("renders no raw tool-call JSON and no system envelope for the observed answer", () => {
    const out = sanitizeAssistantText(LEAKED_ANSWER);
    expect(out).not.toContain('{"name": "bash"');
    expect(out).not.toContain("system_notification");
    expect(out).not.toContain("<br>");
    expect(out).not.toContain("Tool ran without output");
    expect(out).toContain("Here is what I found.");
    expect(out).toContain("The batch runs nightly.");
  });

  it("removes the system<system_notification>…</system_notification> envelope and its prefix", () => {
    const out = sanitizeAssistantText(
      "Done. system<system_notification>Bash completed</system_notification> Next step.",
    );
    expect(out).not.toContain("system_notification");
    expect(out).not.toContain("Bash completed");
    expect(out).toContain("Done.");
    expect(out).toContain("Next step.");
  });

  it("removes an orphaned system_notification tag with no closing half", () => {
    const out = sanitizeAssistantText("Partial <system_notification>truncated mid-frame");
    expect(out).not.toContain("<system_notification>");
    expect(out).toContain("Partial");
  });

  it("turns a literal <br> into a real line break rather than printing it", () => {
    expect(sanitizeAssistantText("line one<br>line two")).toBe("line one\nline two");
    expect(sanitizeAssistantText("a<br/>b")).toBe("a\nb");
    expect(sanitizeAssistantText("a<br />b")).toBe("a\nb");
  });

  it("drops a standalone tool-call frame line", () => {
    const out = sanitizeAssistantText(
      ["Checking.", '{"name": "read_file", "arguments": {"path": "a.ts"}}', "Found it."].join("\n"),
    );
    expect(out).toBe("Checking.\nFound it.");
  });

  it("leaves a tool-call frame inside a fenced code block completely alone", () => {
    const md = [
      "A tool call looks like this:",
      "```json",
      '{"name": "bash", "input": {"command": "ls"}}',
      "```",
      "That is the shape.",
    ].join("\n");
    expect(sanitizeAssistantText(md)).toBe(md);
  });

  it("does not touch a literal <br> inside a fenced code block", () => {
    const md = ["```html", "<br>", "```"].join("\n");
    expect(sanitizeAssistantText(md)).toBe(md);
  });

  it("keeps ordinary JSON that is not a tool frame", () => {
    const json = '{"name": "OrderBatch", "owner": "billing"}';
    expect(sanitizeAssistantText(json)).toBe(json);
  });

  it("keeps a JSON object with an input key but no leading name key", () => {
    const json = '{"input": {"command": "ls"}, "name": "bash"}';
    expect(sanitizeAssistantText(json)).toBe(json);
  });

  it("leaves ordinary prose and markdown byte-identical", () => {
    const md = ["# Heading", "", "Some **bold** prose with a [link](https://x.invalid).", ""].join(
      "\n",
    );
    expect(sanitizeAssistantText(md)).toBe(md);
  });

  it("keeps <br> inside a GFM table row, which has no other way to break a line", () => {
    const md = [
      "| Job | Schedule |",
      "|-----|----------|",
      "| recon | nightly<br>02:00 UTC |",
    ].join("\n");
    expect(sanitizeAssistantText(md)).toBe(md);
  });

  it("returns empty input untouched", () => {
    expect(sanitizeAssistantText("")).toBe("");
  });
});
