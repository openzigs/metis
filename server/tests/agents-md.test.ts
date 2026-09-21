/**
 * AGENTS.md generator tests.
 */
import { describe, expect, it } from "vitest";
import { buildAgentsMd } from "../src/lib/agents-md/build-agents-md.js";

const PROJECT = {
  id: "proj_1",
  name: "Sample Project",
  description: "A long-form description of the sample project.",
  techStack: ["TypeScript", "Express", "Prisma"],
  conventions: ["Use cuid ids", "Soft-delete via deletedAt"],
};

describe("buildAgentsMd", () => {
  it("renders project metadata, conventions, and reference docs", () => {
    const out = buildAgentsMd({
      project: PROJECT,
      documents: [
        { id: "doc_1", name: "README.md", summary: "intro" },
        { id: "doc_2", name: "ARCHITECTURE.md" },
      ],
    });
    expect(out.content).toContain("# Sample Project");
    expect(out.content).toContain("- id: proj_1");
    expect(out.content).toContain("- tech stack: TypeScript, Express, Prisma");
    expect(out.content).toContain("## Conventions");
    expect(out.content).toContain("- Use cuid ids");
    expect(out.content).toContain("- [README.md](#doc-doc_1) — intro");
    expect(out.content).toContain("- [ARCHITECTURE.md](#doc-doc_2)");
    expect(out.content).toContain("<!-- generated-by: metis project=proj_1 -->");
    expect(out.truncated).toBe(false);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-stable for unchanged input (hash matches)", () => {
    const a = buildAgentsMd({ project: PROJECT });
    const b = buildAgentsMd({ project: PROJECT });
    expect(a.hash).toBe(b.hash);
    expect(a.content).toBe(b.content);
  });

  it("truncates deterministically when output exceeds maxBytes", () => {
    const docs = Array.from({ length: 200 }, (_, i) => ({
      id: `doc_${i}`,
      name: `document-${i}.md`,
      summary: "an extremely long summary that pads the file size considerably ".repeat(3),
    }));
    const out = buildAgentsMd({ project: PROJECT, documents: docs, maxBytes: 1024 });
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeLessThanOrEqual(1024);
    expect(out.content).toContain("<!-- truncated: deterministic -->");
  });

  it("annotates manual:true projects", () => {
    const out = buildAgentsMd({
      project: { ...PROJECT, manual: true },
    });
    expect(out.content).toContain("<!-- manual: true (regeneration disabled) -->");
  });
});
