/**
 * #944 item 5 — a plan's Mermaid flowchart linked to a node it never declared
 * ("Mermaid references undefined node B"). Mermaid renders such a node as its
 * bare id, so the diagram silently shows a box nobody defined.
 */
import { describe, expect, it } from "vitest";
import { describeUndeclaredMermaidNodes, findUndeclaredMermaidNodes } from "./mermaid-check.js";

const fence = (body: string) => "# Plan\n\n```mermaid\n" + body + "\n```\n";

describe("findUndeclaredMermaidNodes", () => {
  it("flags an edge target that is never given a label", () => {
    const md = fence(
      [
        "graph TD",
        '  A["Browser"] -->|"POST days=N"| R["UI route"]',
        "  R --> B",
        '  R -.->|renders| V["View"]',
      ].join("\n"),
    );
    expect(findUndeclaredMermaidNodes(md)).toEqual(["B"]);
  });

  it("accepts every shape, labels on edges, chains, & groups and subgraphs", () => {
    const md = fence(
      [
        "flowchart LR",
        "  %% a comment --> Z",
        "  subgraph Interfaces",
        '    W["Web UI<br/>handlers"]',
        '    G("Adapter")',
        "  end",
        '  DB[("PostgreSQL")]',
        "  Q{Valid?}",
        "  S[[Store]]",
        "  C((Cache))",
        "  W & G --> Q",
        "  Q -- yes --> S ==> DB",
        "  Q -->|no| C",
        "  Interfaces --> S",
        "  S:::hot --> C",
        "  classDef hot fill:#f00",
        "  style S fill:#0f0",
        '  click S href "https://x"',
      ].join("\n"),
    );
    expect(findUndeclaredMermaidNodes(md)).toEqual([]);
  });

  it("ignores diagrams that label nothing, and non-flowchart blocks", () => {
    expect(findUndeclaredMermaidNodes(fence("graph TD\n  A --> B\n  B --> C"))).toEqual([]);
    expect(
      findUndeclaredMermaidNodes(
        fence("sequenceDiagram\n  participant A as X\n  A->>B: call\n  B-->>A: ok"),
      ),
    ).toEqual([]);
    expect(findUndeclaredMermaidNodes(fence('erDiagram\n  USERS ||--o{ FEEDS : "owns"'))).toEqual(
      [],
    );
    expect(findUndeclaredMermaidNodes("no diagram here")).toEqual([]);
  });

  it("reports each undeclared id once, across diagrams, in first-seen order", () => {
    const md = fence('graph TD\n  A["a"] --> Y\n  Y --> X') + fence('graph LR\n  P["p"] --> X');
    expect(findUndeclaredMermaidNodes(md)).toEqual(["Y", "X"]);
  });
});

describe("describeUndeclaredMermaidNodes", () => {
  it("is empty when every node is declared", () => {
    expect(describeUndeclaredMermaidNodes("plan.md", [])).toBe("");
  });
  it("names the artifact and the nodes", () => {
    expect(describeUndeclaredMermaidNodes("plan.md", ["B"])).toBe(
      " `plan.md`'s Mermaid diagram links to 1 node it never declares: `B`.",
    );
    expect(describeUndeclaredMermaidNodes("plan.md", ["B", "C"])).toBe(
      " `plan.md`'s Mermaid diagram links to 2 nodes it never declares: `B`, `C`.",
    );
  });
});
