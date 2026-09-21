/**
 * Copilot Workspace markdown renderer.
 */
import { describe, expect, it } from "vitest";
import {
  renderCopilotWorkspaceMarkdown,
  workspaceContentHash,
  COPILOT_WORKSPACE_PATH,
} from "../src/lib/publishing/copilot-workspace-md.js";

describe("renderCopilotWorkspaceMarkdown", () => {
  it("renders the workspace header", () => {
    const md = renderCopilotWorkspaceMarkdown({ epics: [] });
    expect(md.split("\n")[0]).toBe("# Workspace");
    expect(md).toContain("No epics in this batch.");
  });

  it("renders epics with sub-issue tables", () => {
    const md = renderCopilotWorkspaceMarkdown({
      epics: [
        {
          number: 42,
          title: "Big Feature",
          summary: "Summary text.",
          subIssues: [
            { number: 43, title: "Sub one", storyPoints: 3, dependencies: [] },
            { number: 44, title: "Sub two", storyPoints: null, dependencies: [43] },
          ],
        },
      ],
      repo: "acme/example",
      generatedAt: "2026-04-26T00:00:00.000Z",
    });
    expect(md).toContain("Repo: `acme/example`");
    expect(md).toContain("## #42 — Big Feature");
    expect(md).toContain("Summary text.");
    expect(md).toContain("| #43 | Sub one | 3 | — |");
    expect(md).toContain("| #44 | Sub two | — | #43 |");
    expect(md).toContain("<!-- generated: 2026-04-26T00:00:00.000Z -->");
  });

  it("escapes pipes and newlines in titles", () => {
    const md = renderCopilotWorkspaceMarkdown({
      epics: [
        {
          number: 1,
          title: "Epic | with pipe",
          subIssues: [{ number: 2, title: "Title | with\npipe and newline", storyPoints: 5 }],
        },
      ],
    });
    expect(md).toContain("Title \\| with pipe and newline");
  });

  it("notes when an epic has no sub-issues", () => {
    const md = renderCopilotWorkspaceMarkdown({
      epics: [{ number: 7, title: "Lonely", subIssues: [] }],
    });
    expect(md).toContain("_No sub-issues._");
  });

  it("workspaceContentHash returns a 64-char hex digest", async () => {
    const md = renderCopilotWorkspaceMarkdown({ epics: [] });
    const hash = await workspaceContentHash(md);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const again = await workspaceContentHash(md);
    expect(again).toBe(hash);
  });

  it("exposes the canonical path constant", () => {
    expect(COPILOT_WORKSPACE_PATH).toBe(".copilot-workspace.md");
  });
});
