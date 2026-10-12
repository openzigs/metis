/**
 * #789 — the text "Start analysis with these artifacts" sends.
 * #994 — a METIS spec is sent as a structured summary of its requirements.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ANALYSIS_AGENT_CONTEXT,
  MAX_EXTRA_INSTRUCTIONS,
  SPEC_KIT_HANDOFF_MAX_LABELS,
  specKitHandoffLabelsNotInContext,
  specKitHandoffSchema,
  startAnalysisSchema,
} from "@metis/shared";
import {
  buildHandoffContext,
  buildHandoffInstructions,
  contextNotSent,
  notSentPhrase,
  specRequirements,
  SPEC_TAIL_OMITTED,
} from "@/lib/spec-kit-handoff";
import { expectLinearTime } from "./helpers/linear-time";

/** A spec in the shape METIS's `/speckit.specify` writes. */
const METIS_SPEC = [
  "# Spec",
  "Let a user mark entries read in bulk.",
  "",
  "## Stakeholders",
  "- Readers",
  "",
  "## Acceptance criteria",
  "",
  "- **AC-1**: Mark all as read",
  "  - **Given** a feed with unread entries",
  "  - **When** the user marks all as read",
  "  - **Then** every entry is read",
  "  - **Example**: input `3 unread` → output `0 unread`",
  "- **AC-2**: Older than N days",
  "  - **Given** entries of mixed age",
  "  - **When** the user picks 7 days",
  "  - **Then** only entries older than 7 days are read",
  "",
  "## Non-functional requirements",
  "- Bulk update finishes in under 2 seconds for 10,000 entries",
  "- Works without JavaScript",
  "  on the server-rendered page",
].join("\n");

describe("specRequirements (#994)", () => {
  it("reads each criterion as one requirement with its Given/When/Then, then the NFRs", () => {
    expect(specRequirements(METIS_SPEC)).toEqual([
      {
        label: "AC-1",
        text: "Mark all as read. Given a feed with unread entries. When the user marks all as read. Then every entry is read. Example: input `3 unread` → output `0 unread`.",
      },
      {
        label: "AC-2",
        text: "Older than N days. Given entries of mixed age. When the user picks 7 days. Then only entries older than 7 days are read.",
      },
      { label: "NFR-1", text: "Bulk update finishes in under 2 seconds for 10,000 entries." },
      { label: "NFR-2", text: "Works without JavaScript. on the server-rendered page." },
    ]);
  });

  it("reads criteria written as headings", () => {
    const spec = "## Acceptance criteria\n\n### AC-1 Login\nGiven a user\n\n### AC-2: Logout\n";
    expect(specRequirements(spec).map((r) => r.label)).toEqual(["AC-1", "AC-2"]);
    expect(specRequirements(spec)[0]!.text).toBe("Login. Given a user.");
  });

  it("finds nothing in a spec without those sections", () => {
    expect(specRequirements("# Spec\n- FR-1")).toEqual([]);
  });
});

describe("buildHandoffInstructions", () => {
  it("sends every criterion as its own paragraph under a heading naming the artifacts", () => {
    const r = buildHandoffInstructions(["specs/001-a/spec.md", "constitution.md"], METIS_SPEC);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toEqual([]);
    expect(r.sent).toEqual(["AC-1", "AC-2", "NFR-1", "NFR-2"]);
    const blocks = r.text.split("\n\n");
    expect(blocks[0]).toMatch(/^# Spec Kit handoff: evaluate these requirements from spec\.md/);
    expect(blocks.slice(1).map((b) => b.split(":")[0])).toEqual(["AC-1", "AC-2", "NFR-1", "NFR-2"]);
    // One line per requirement: never split into one requirement per sub-bullet.
    expect(blocks.every((b) => !b.includes("\n"))).toBe(true);
    // Not the spec's other sections.
    expect(r.text).not.toContain("Readers");
  });

  it("leaves out whole requirements that do not fit, and names them", () => {
    const big = (n: number) => `- **AC-${n}**: C${n}\n  - **Then** ${"x".repeat(1500)}`;
    const spec = `## Acceptance criteria\n${[1, 2, 3, 4].map(big).join("\n")}\n- **AC-5**: short\n`;
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.text.length).toBeLessThanOrEqual(MAX_EXTRA_INSTRUCTIONS);
    expect(r.sent).toEqual(["AC-1", "AC-2", "AC-5"]);
    expect(r.omitted).toEqual(["AC-3", "AC-4"]);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("AC-5: short.")).toBe(true);
  });

  it("sends a requirement that ends one under the cap, and leaves out one that ends at it (#994 review)", () => {
    // The server flags `length >= MAX_EXTRA_INSTRUCTIONS` as truncated input, so a
    // structured handoff of exactly the cap must never be emitted.
    const withBody = (n: number) =>
      buildHandoffInstructions(
        ["spec.md"],
        `## Acceptance criteria\n- **AC-1**: ${"y".repeat(n)}.`,
      );
    const fixed = withBody(1).text.length - 1; // header + "\n\nAC-1: " + "."
    const under = withBody(MAX_EXTRA_INSTRUCTIONS - 1 - fixed);
    expect(under.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS - 1);
    expect(under).toMatchObject({ sent: ["AC-1"], omitted: [], truncated: false });
    const at = withBody(MAX_EXTRA_INSTRUCTIONS - fixed);
    expect(at).toMatchObject({ sent: [], omitted: ["AC-1"], truncated: true });
    expect(at.text.length).toBeLessThan(MAX_EXTRA_INSTRUCTIONS);
  });

  it("names the context artifacts in the header only as not sent (#994)", () => {
    const context = [
      "specs/001-a/spec.md",
      "specs/001-a/plan.md",
      "specs/001-a/tasks.md",
      "constitution.md",
    ];
    const notSent =
      "Not sent: specs/001-a/plan.md, specs/001-a/tasks.md, constitution.md (not read by this analysis).";
    const structured = buildHandoffInstructions(context, METIS_SPEC).text.split("\n\n")[0]!;
    expect(structured).toBe(
      `# Spec Kit handoff: evaluate these requirements from spec.md against the current implementation. Only spec.md's requirements are sent. ${notSent}`,
    );
    const unstructuredText = buildHandoffInstructions(context, "# Spec\n- FR-1").text;
    expect(unstructuredText.split("\n\n")[0]).toContain("only spec.md is sent.");
    expect(unstructuredText.split("\n\n")[0]).toContain(notSent);
    expect(buildHandoffInstructions(context, null).text).toBe(
      `Spec Kit handoff: no spec.md was available, so no requirements were sent. ${notSent}`,
    );
    // spec.md alone: nothing to name as not sent.
    expect(buildHandoffInstructions(["specs/001-a/spec.md"], METIS_SPEC).text).not.toContain(
      "Not sent",
    );
  });

  it("caps omitted at the schema limit with a `+N more` entry the server accepts (#994)", () => {
    // Each criterion is large enough that only a few fit; the rest are omitted.
    const n = SPEC_KIT_HANDOFF_MAX_LABELS + 40;
    const spec = `## Acceptance criteria\n${Array.from(
      { length: n },
      (_, i) => `- **AC-${i + 1}**: ${"z".repeat(1000)}`,
    ).join("\n")}\n`;
    const r = buildHandoffInstructions(["spec.md", "plan.md"], spec);
    expect(r.omittedCount).toBe(n - r.sent.length);
    expect(r.omittedCount).toBeGreaterThan(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(r.omitted).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    const firstOmitted = r.sent.length + 1;
    expect(r.omitted[0]).toBe(`AC-${firstOmitted}`);
    expect(r.omitted.at(-1)).toBe(`+${r.omittedCount - (SPEC_KIT_HANDOFF_MAX_LABELS - 1)} more`);
    const payload = { artifacts: ["spec.md", "plan.md"], sent: r.sent, omitted: r.omitted };
    expect(specKitHandoffSchema.safeParse(payload).success).toBe(true);
    expect(
      startAnalysisSchema.safeParse({ extraInstructions: r.text, specKitHandoff: payload }).success,
    ).toBe(true);
  });

  it("leaves omitted uncapped at exactly the schema limit", () => {
    const perAc = (count: number) =>
      `## Acceptance criteria\n${Array.from(
        { length: count },
        (_, i) => `- **AC-${i + 1}**: ${"z".repeat(1000)}`,
      ).join("\n")}\n`;
    const fits = buildHandoffInstructions(["spec.md"], perAc(3)).sent.length;
    const r = buildHandoffInstructions(["spec.md"], perAc(fits + SPEC_KIT_HANDOFF_MAX_LABELS));
    expect(r.omittedCount).toBe(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(r.omitted).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(r.omitted.at(-1)).toBe(`AC-${fits + SPEC_KIT_HANDOFF_MAX_LABELS}`);
  });

  it("sends the header alone when there is no spec text", () => {
    const r = buildHandoffInstructions(["spec.md"], "  ");
    expect(r.text).toMatch(/^Spec Kit handoff: no spec\.md was available/);
    expect(r.text).not.toContain("\n");
    expect(r).toMatchObject({ truncated: false, sent: [], omitted: [] });
  });

  it("sends a spec without acceptance criteria whole when it fits", () => {
    const r = buildHandoffInstructions(["spec.md"], "# Spec\n- FR-1");
    expect(r.truncated).toBe(false);
    expect(r.omitted).toEqual([]);
    expect(r.text.endsWith("# Spec\n- FR-1")).toBe(true);
  });

  it("cuts an unstructured spec between paragraphs, never mid-sentence, and says so", () => {
    const para = (c: string) => `${c.repeat(1000)} ends here.`;
    const spec = [para("a"), para("b"), para("c"), para("d"), para("e")].join("\n\n");
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toEqual([SPEC_TAIL_OMITTED]);
    expect(r.text.length).toBeLessThanOrEqual(MAX_EXTRA_INSTRUCTIONS);
    expect(r.text.endsWith("ends here.")).toBe(true);
    expect(r.text).not.toContain("e".repeat(10));
  });

  it("cuts an unstructured one-line spec at a sentence end", () => {
    const spec = `${"word ".repeat(500)}stop. ${"more ".repeat(500)}`;
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("stop.")).toBe(true);
  });

  it("is not truncated one under the cap, and never emits text of exactly the cap", () => {
    const headerLength = buildHandoffInstructions(["spec.md"], "x").text.length - 3;
    const under = buildHandoffInstructions(
      ["spec.md"],
      "y".repeat(MAX_EXTRA_INSTRUCTIONS - headerLength - 3),
    );
    expect(under.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS - 1);
    expect(under.truncated).toBe(false);
    // The server flags length >= cap as truncated, so exactly the cap must be cut.
    const at = buildHandoffInstructions(
      ["spec.md"],
      "y".repeat(MAX_EXTRA_INSTRUCTIONS - headerLength - 2),
    );
    expect(at.truncated).toBe(true);
    expect(at.text.length).toBeLessThan(MAX_EXTRA_INSTRUCTIONS);
  });

  it("cuts a spec with no break of its own after the header, never through a surrogate pair", () => {
    const header = buildHandoffInstructions(["spec.md"], "x").text.length - 3;
    const spec = "a".repeat(MAX_EXTRA_INSTRUCTIONS - header - 2 - 1) + "\u{1F600}" + "tail";
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toEqual([SPEC_TAIL_OMITTED]);
    expect(r.text).toBe(
      "Spec Kit handoff. Evaluate the requirements in this spec.md against the current implementation; only spec.md is sent.",
    );
  });
});

describe("buildHandoffContext (#1027)", () => {
  const PLAN = [
    "# Plan",
    "Summary.",
    "",
    "## Components",
    "- **FeedStore** — Extends `storage/feed.go`:",
    "  rejects a duplicate URL (AC-1)",
    "- `NoticeView`: New template for the refusal (AC-2)",
    "- A plain bullet with no name (AC-2)",
    "  - a nested bullet of it",
    "",
    "## Architecture diagram",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "## ADRs",
    "- Decision: a unique index (AC-1)",
  ].join("\n");
  const TASKS = [
    "# Tasks",
    "## Story US1",
    "- [ ] T01 — Change `Create` in storage/feed.go (storage/feed.go:12-30) (satisfies: AC-1)",
    "  Acceptance: the second insert fails.",
    "- [x] T02 [P] Show the notice",
    "- a note that is not a task",
    "| # | Title | Story Points | Dependencies | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| T03 | Write the migration | 2 | T01 | |",
    "| Total | 3 tasks | | | |",
  ].join("\n");

  it("sends one line per plan component and per task, under a heading per file", () => {
    const context = buildHandoffContext(PLAN, TASKS);
    expect(context.text).toBe(
      [
        "Plan components (plan.md):",
        "- FeedStore — Extends `storage/feed.go`: rejects a duplicate URL (AC-1)",
        "- `NoticeView`: New template for the refusal (AC-2)",
        "- A plain bullet with no name (AC-2) a nested bullet of it",
        "Tasks (tasks.md):",
        "- T01: Change `Create` in storage/feed.go (storage/feed.go:12-30) (satisfies: AC-1)",
        "- T02: [P] Show the notice",
        "- T03: Write the migration",
      ].join("\n"),
    );
    expect(context).toMatchObject({
      // A component with no name of its own is labelled by the start of its
      // line, so every label is text the context holds.
      components: [
        "FeedStore",
        "NoticeView",
        "A plain bullet with no name (AC-2) a nested bullet of it",
      ],
      tasks: ["T01", "T02", "T03"],
      omitted: [],
      omittedCount: 0,
      files: ["plan.md", "tasks.md"],
      unrecognised: [],
    });
    // Only the Components section and the task lines: no diagram, ADR or task detail.
    expect(context.text).not.toContain("mermaid");
    expect(context.text).not.toContain("Decision");
    expect(context.text).not.toContain("Acceptance:");
    expect(context.text).not.toContain("not a task");
  });

  it("sends nothing when neither file has components or tasks to read", () => {
    const nothing = {
      text: null,
      components: [],
      tasks: [],
      omitted: [],
      omittedCount: 0,
      files: [],
    };
    // A file that is missing or blank was not read at all.
    for (const [plan, tasks] of [
      [null, null],
      ["", ""],
      ["  \n", "\n"],
    ] as const) {
      expect(buildHandoffContext(plan, tasks)).toEqual({ ...nothing, unrecognised: [] });
    }
    // One with content and nothing recognised in it is named, per file.
    expect(buildHandoffContext("# Plan\n## ADRs\n- Decision", "# Tasks\nNothing yet.")).toEqual({
      ...nothing,
      unrecognised: ["plan.md", "tasks.md"],
    });
    expect(
      buildHandoffContext("# Plan\n## ADRs\n- Decision", "- [ ] T01 — One").unrecognised,
    ).toEqual(["plan.md"]);
    expect(buildHandoffContext("## Components\n- **A** x", "Nothing yet.").unrecognised).toEqual([
      "tasks.md",
    ]);
  });

  it("names only the file something was sent from", () => {
    expect(buildHandoffContext(PLAN, null).files).toEqual(["plan.md"]);
    const tasksOnly = buildHandoffContext(null, TASKS);
    expect(tasksOnly.files).toEqual(["tasks.md"]);
    expect(tasksOnly.text?.startsWith("Tasks (tasks.md):\n- T01")).toBe(true);
  });

  it("leaves a task that does not fit out whole, names it, and never passes the limit", () => {
    const tasks = Array.from(
      { length: 60 },
      (_, i) => `- [ ] T${String(i + 1).padStart(2, "0")} — ${"t".repeat(90)}`,
    ).join("\n");
    const context = buildHandoffContext(null, tasks);
    expect(context.text!.length).toBeLessThanOrEqual(MAX_ANALYSIS_AGENT_CONTEXT);
    expect(context.tasks.length + context.omittedCount).toBe(60);
    expect(context.tasks.length).toBeGreaterThan(30);
    expect(context.omitted[0]).toBe(`T${context.tasks.length + 1}`);
    // Every line sent is a whole task line.
    for (const line of context.text!.split("\n").slice(1)) {
      expect(line).toMatch(/^- T\d\d: t{90}$/);
    }
    // One more character of room would not have fitted the first task left out.
    expect(context.text!.length + 1 + "- T01: ".length + 90).toBeGreaterThan(
      MAX_ANALYSIS_AGENT_CONTEXT,
    );
  });

  it("fills the limit exactly when the lines add up to it", () => {
    const heading = "Tasks (tasks.md):".length;
    const title = MAX_ANALYSIS_AGENT_CONTEXT - heading - 1 - "- T01: ".length;
    const fits = buildHandoffContext(null, `- [ ] T01 — ${"x".repeat(title)}`);
    expect(fits.text).toHaveLength(MAX_ANALYSIS_AGENT_CONTEXT);
    expect(fits.tasks).toEqual(["T01"]);
    const over = buildHandoffContext(null, `- [ ] T01 — ${"x".repeat(title + 1)}`);
    expect(over).toMatchObject({ text: null, tasks: [], omitted: ["T01"], files: [] });
  });

  it("keeps half the limit for the tasks when the plan's components would crowd them out", () => {
    const plan = `## Components\n${Array.from(
      { length: 40 },
      (_, i) => `- **C${i + 1}** — ${"c".repeat(180)}`,
    ).join("\n")}`;
    const tasks = Array.from({ length: 40 }, (_, i) => `- [ ] T${i + 1} — ${"t".repeat(180)}`).join(
      "\n",
    );
    const context = buildHandoffContext(plan, tasks);
    expect(context.text!.length).toBeLessThanOrEqual(MAX_ANALYSIS_AGENT_CONTEXT);
    expect(context.components.length).toBeGreaterThan(5);
    expect(context.tasks.length).toBeGreaterThan(5);
    expect(context.omitted).toContain("C40");
    expect(context.omitted).toContain("T40");
    // A short task list leaves its unused share to the components.
    const few = buildHandoffContext(plan, "- [ ] T1 — one");
    expect(few.components.length).toBeGreaterThan(context.components.length);
    expect(few.tasks).toEqual(["T1"]);
  });

  it("produces a record and a context the server's schema accepts, however long the files", () => {
    const tasks = Array.from({ length: 900 }, (_, i) => `- [ ] T${i + 1} — ${"t".repeat(40)}`).join(
      "\n",
    );
    const plan = `## Components\n- **${"N".repeat(200)}** — a very long name`;
    const context = buildHandoffContext(plan, tasks);
    expect(context.omitted).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(context.omitted.at(-1)).toMatch(/^\+\d+ more$/);
    expect(context.components[0]).toHaveLength(64);
    const parsed = startAnalysisSchema.safeParse({
      agentContext: context.text,
      specKitHandoff: {
        artifacts: ["spec.md", "plan.md", "tasks.md"],
        sent: [],
        omitted: [],
        context: {
          components: context.components,
          tasks: context.tasks,
          omitted: context.omitted,
        },
      },
    });
    expect(parsed.success).toBe(true);
    // A handoff record from before #1027 carries no context and still parses.
    expect(
      specKitHandoffSchema.safeParse({ artifacts: ["spec.md"], sent: [], omitted: [] }).success,
    ).toBe(true);
  });
});

describe("the requirements text names what went as context (#1027)", () => {
  const artifacts = [
    "specs/001-a/spec.md",
    "specs/001-a/plan.md",
    "specs/001-a/tasks.md",
    "constitution.md",
  ];

  it("says plan.md and tasks.md were sent as context, in one heading line", () => {
    const text = buildHandoffInstructions(artifacts, "## Acceptance criteria\n- **AC-1**: One\n", [
      "plan.md",
      "tasks.md",
    ]).text;
    expect(text.split("\n\n")[0]).toBe(
      "# Spec Kit handoff: evaluate these requirements from spec.md against the current implementation. Only spec.md's requirements are sent. Sent separately as context, not as requirements: specs/001-a/plan.md, specs/001-a/tasks.md. Not sent: constitution.md (not read by this analysis).",
    );
  });

  it("still names a file as not sent when nothing was read from it", () => {
    expect(contextNotSent(artifacts, ["tasks.md"])).toEqual([
      "specs/001-a/plan.md",
      "constitution.md",
    ]);
    expect(contextNotSent(artifacts)).toEqual(artifacts.slice(1));
    expect(contextNotSent(["spec.md", "plan.md"], ["plan.md"])).toEqual([]);
  });
});

// ── Review of #1027 ────────────────────────────────────────────────────────

const lines = (...l: string[]) => l.join("\n");
const componentsOf = (plan: string) => buildHandoffContext(plan, null);
const tasksOf = (tasks: string) => buildHandoffContext(null, tasks);

describe("plan.md written off the template still yields its components (#1027 review)", () => {
  // The plan is model-written Markdown. Each of these gave `components: []`,
  // and the page then said plan.md was "not read by this analysis".
  it.each([
    ["a numbered heading", "## 2. Components"],
    ["a numbered heading with a bracket", "## 3) Components"],
    ["`Component breakdown`", "## Component breakdown"],
    ["a title ending in components", "## Architecture and components"],
    ["a deeper heading level", "### Components"],
    ["an emphasised title", "## **Components**"],
  ])("reads the section under %s", (_name, heading) => {
    const context = componentsOf(lines("# Plan", heading, "- **FeedStore** — storage", "## Risks"));
    expect(context.text).toBe("Plan components (plan.md):\n- FeedStore — storage");
    expect(context.components).toEqual(["FeedStore"]);
    expect(context.unrecognised).toEqual([]);
  });

  it.each([
    ["the document's own title", "# Plan for the feed components"],
    ["a title that only contains the word", "## Non-component concerns"],
    ["an unrelated section", "## Risks"],
  ])("does not take %s for the components section", (_name, heading) => {
    const context = componentsOf(lines(heading, "- **FeedStore** — storage", "## Notes", "- n"));
    expect(context.components).toEqual([]);
    expect(context.unrecognised).toEqual(["plan.md"]);
  });

  it("reads a sub-heading per component, with the first line beneath it", () => {
    const context = componentsOf(
      lines(
        "## Components",
        "### FeedStore",
        "",
        "Extends storage/feed.go (AC-1)",
        "More about it that is detail.",
        "#### Notes",
        "- a deeper heading is detail of FeedStore, not a component",
        "### `Notice`",
        "- new UI (AC-2)",
        "- second bullet",
        "### Bare",
        "## Risks",
        "### NotAComponent",
      ),
    );
    expect(context.text).toBe(
      lines(
        "Plan components (plan.md):",
        "- FeedStore — Extends storage/feed.go (AC-1)",
        "- Notice — new UI (AC-2)",
        "- Bare",
      ),
    );
    expect(context.components).toEqual(["FeedStore", "Notice", "Bare"]);
  });

  it("reads a components table, skipping its header row", () => {
    const context = componentsOf(
      lines(
        "## Components",
        "| Component | Responsibility | Files |",
        "|---|---|---|",
        "| **FeedStore** | Extends feed.go | storage/feed.go |",
        "| Notice | |",
      ),
    );
    expect(context.text).toBe(
      lines("Plan components (plan.md):", "- FeedStore — Extends feed.go", "- Notice"),
    );
    expect(context.components).toEqual(["FeedStore", "Notice"]);
  });

  it("reads bullets indented as a block, keeping deeper ones as detail", () => {
    const context = componentsOf(
      lines("## Components", "  - **A** one", "    - detail of A", "  - **B** two"),
    );
    expect(context.components).toEqual(["A", "B"]);
    expect(context.text).toBe(
      lines("Plan components (plan.md):", "- A one detail of A", "- B two"),
    );
  });

  it("ends the section at the next heading of its own level, not at a deeper one", () => {
    const context = componentsOf(
      lines("### Components", "- **A** one", "#### Sub", "body", "### Next", "- **B** two"),
    );
    expect(context.components).toEqual(["A", "Sub"]);
  });
});

describe("tasks.md written off the template still yields its tasks (#1027 review)", () => {
  it.each([
    [
      "a bold id in a checkbox bullet",
      "- [ ] **T01** — Build login form",
      "- T01: Build login form",
    ],
    ["a bold id with a colon", "- **T02**: Wire the API", "- T02: Wire the API"],
    ["an underscored bold id", "- __T03__ Add tests", "- T03: Add tests"],
    ["a code id", "- `T04` — Ship", "- T04: Ship"],
    ["a bold id and title", "- **T05: Wire**", "- T05: Wire"],
    ["a numbered item", "1. T06 — Build", "- T06: Build"],
    ["a numbered item with a bracket", "2) T07 — Wire", "- T07: Wire"],
    ["a heading", "### T08 — Build", "- T08: Build"],
    ["a bold id in a heading", "## **T09** Build", "- T09: Build"],
    [
      "an upstream Spec Kit row",
      "- [ ] T010 [P] [US1] Create model",
      "- T010: [P] [US1] Create model",
    ],
    ["a bullet with no space", "*T11", "- T11"],
    ["a bold id in a table cell", "| **T12** | Title |", "- T12: Title"],
  ])("reads %s", (_name, line, expected) => {
    const context = tasksOf(line);
    expect(context.text).toBe(`Tasks (tasks.md):\n${expected}`);
    expect(context.unrecognised).toEqual([]);
  });

  it.each([
    ["prose that mentions a task", "- Task T03: do it"],
    ["a paragraph", "T01 is the first task."],
    ["a lower-case id in a bullet", "- t2 instances are cheaper"],
    ["a lower-case id in a table", "| t1 | lower |"],
    ["an id with more digits than a task has", "- T12345 — five digits"],
    ["an id run into a word", "- T01abc — not an id"],
    ["a heading that only mentions a task", "### Notes on T01"],
  ])("does not take %s for a task", (_name, line) => {
    const context = tasksOf(line);
    expect(context.tasks).toEqual([]);
    expect(context.unrecognised).toEqual(["tasks.md"]);
  });

  // `| AC-1 | T01, T02 |` used to become a second, malformed `- T01: , T02`.
  it("takes a table row only when its first cell is the id alone", () => {
    const context = tasksOf(
      lines(
        "| ID | Title | Pts |",
        "|---|---|---|",
        "| T01 | Build login form | 3 |",
        "| T02 | Wire the API | 2 |",
        "",
        "| AC | Tasks |",
        "|---|---|",
        "| AC-1 | T01, T02 |",
        "| T03, T04 | AC-2 |",
        "| AC-3 | T05 |",
      ),
    );
    expect(context.text).toBe(
      lines("Tasks (tasks.md):", "- T01: Build login form", "- T02: Wire the API"),
    );
    expect(context.tasks).toEqual(["T01", "T02"]);
  });

  it("lists a task once: the first line with its id wins", () => {
    const context = tasksOf(
      lines(
        "- [ ] T01 — Build",
        "- [x] T01 — Build (done)",
        "| T01 | Build again |",
        "- T02 — Wire",
      ),
    );
    expect(context.text).toBe(lines("Tasks (tasks.md):", "- T01: Build", "- T02: Wire"));
    expect(context.tasks).toEqual(["T01", "T02"]);
  });

  it("keeps code spans and emphasis inside a title", () => {
    expect(tasksOf("- [ ] T01 — Change `Create` in **storage**/feed.go").text).toBe(
      "Tasks (tasks.md):\n- T01: Change `Create` in **storage**/feed.go",
    );
  });
});

describe("the sent label lists fit the run's record (#1027 review)", () => {
  // 600 tasks with no title fit the 4,096-character limit, the record named
  // all of them, the schema allows 500, and the whole start was a 400.
  it("caps the tasks sent at the schema's label limit and counts the rest as omitted", () => {
    const n = 700;
    const context = tasksOf(Array.from({ length: n }, (_, i) => `- T${i + 1}`).join("\n"));
    expect(context.tasks).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(context.tasks.at(-1)).toBe(`T${SPEC_KIT_HANDOFF_MAX_LABELS}`);
    expect(context.omittedCount).toBe(n - SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(context.omitted[0]).toBe(`T${SPEC_KIT_HANDOFF_MAX_LABELS + 1}`);
    // The text holds exactly the tasks the record names.
    expect(context.text!.split("\n")).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS + 1);
    expect(context.text!.length).toBeLessThanOrEqual(MAX_ANALYSIS_AGENT_CONTEXT);
    const record = {
      artifacts: ["spec.md", "tasks.md"],
      sent: [],
      omitted: [],
      context: {
        components: context.components,
        tasks: context.tasks,
        omitted: context.omitted,
      },
    };
    expect(
      startAnalysisSchema.safeParse({
        agentContext: context.text,
        specKitHandoff: record,
      }).success,
    ).toBe(true);
  });

  it("caps the components sent the same way", () => {
    const n = SPEC_KIT_HANDOFF_MAX_LABELS + 30;
    const context = buildHandoffContext(
      `## Components\n${Array.from({ length: n }, (_, i) => `- c${i}`).join("\n")}`,
      null,
    );
    expect(context.components).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(context.omittedCount).toBe(30);
    expect(specKitHandoffSchema.shape.context.safeParse(context).success).toBe(false);
    expect(
      specKitHandoffSchema.safeParse({
        artifacts: ["plan.md"],
        sent: [],
        omitted: [],
        context: {
          components: context.components,
          tasks: [],
          omitted: context.omitted,
        },
      }).success,
    ).toBe(true);
  });

  it("sends every item when a list is exactly at the limit", () => {
    const context = tasksOf(
      Array.from({ length: SPEC_KIT_HANDOFF_MAX_LABELS }, (_, i) => `- T${i + 1}`).join("\n"),
    );
    expect(context.tasks).toHaveLength(SPEC_KIT_HANDOFF_MAX_LABELS);
    expect(context.omitted).toEqual([]);
  });
});

describe("every label a handoff sends is text of its context (#1027 review)", () => {
  // The server refuses a record whose labels are not in the context text, so
  // the builder must never produce one.
  const unbacked = (plan: string | null, tasks: string | null) => {
    const context = buildHandoffContext(plan, tasks);
    return specKitHandoffLabelsNotInContext(
      {
        artifacts: ["spec.md"],
        sent: [],
        omitted: [],
        context: {
          components: context.components,
          tasks: context.tasks,
          omitted: context.omitted,
        },
      },
      context.text ?? undefined,
    );
  };

  it.each([
    ["named, coded and unnamed bullets", "## Components\n- **A** x\n- `B` y\n- plain bullet"],
    ["a name holding emphasis markers", "## Components\n- **__init__** module\n- **a __b__ c** d"],
    ["a name over the label length", `## Components\n- **${"N".repeat(200)}** long`],
    ["an unnamed line over the label length", `## Components\n- ${"word ".repeat(40)}`],
    ["a name padded with spaces", "## Components\n- ** Padded ** x"],
    ["an astral character at the label cut", `## Components\n- ${"a".repeat(63)}\u{1F600} tail`],
    ["sub-headings", "## Components\n### `Store` **v2**\nbody\n### Other"],
    ["a table", "## Components\n| C | R |\n|---|---|\n| **Store** | does `x` |"],
  ])("for %s", (_name, plan) => {
    const context = buildHandoffContext(plan, "- [ ] **T01** — a\n1. T02 — b\n| T03 | c |");
    expect(context.components.length).toBeGreaterThan(0);
    expect(context.tasks).toEqual(["T01", "T02", "T03"]);
    for (const label of context.components) {
      expect(label.length).toBeGreaterThan(0);
      expect(label.length).toBeLessThanOrEqual(64);
      // Never half of a surrogate pair: that is not text the record can store.
      expect(label).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(unbacked(plan, "- [ ] **T01** — a\n1. T02 — b\n| T03 | c |")).toEqual([]);
  });

  it("reports a label the text does not hold, and any label when there is no text", () => {
    const record = {
      artifacts: ["spec.md"],
      sent: [],
      omitted: ["T09"],
      context: {
        components: ["FeedStore"],
        tasks: ["T01", "T02"],
        omitted: ["T03"],
      },
    };
    const text = "Plan components (plan.md):\n- FeedStore — x\nTasks (tasks.md):\n- T01: a";
    expect(specKitHandoffLabelsNotInContext(record, text)).toEqual(["T02"]);
    expect(specKitHandoffLabelsNotInContext(record, undefined)).toEqual([
      "FeedStore",
      "T01",
      "T02",
    ]);
    // Nothing to check without a context record, or with empty lists.
    expect(specKitHandoffLabelsNotInContext(undefined, text)).toEqual([]);
    expect(
      specKitHandoffLabelsNotInContext({ artifacts: [], sent: ["AC-1"], omitted: [] }, undefined),
    ).toEqual([]);
  });
});

describe("the requirements text gives the true reason a file sent nothing (#1027 review)", () => {
  const artifacts = ["specs/001-a/spec.md", "specs/001-a/plan.md", "specs/001-a/tasks.md", "c.md"];

  it("says read-but-unrecognised per file, and not-read for the rest", () => {
    expect(notSentPhrase(artifacts, [], ["plan.md", "tasks.md"])).toBe(
      "specs/001-a/plan.md (read, but no components were recognised); specs/001-a/tasks.md (read, but no tasks were recognised); c.md (not read by this analysis)",
    );
    expect(notSentPhrase(artifacts, ["tasks.md"], ["plan.md"])).toBe(
      "specs/001-a/plan.md (read, but no components were recognised); c.md (not read by this analysis)",
    );
    // A file something was sent from is not "not sent", whatever else is said.
    expect(notSentPhrase(artifacts, ["plan.md", "tasks.md"], ["plan.md"])).toBe(
      "c.md (not read by this analysis)",
    );
    expect(notSentPhrase(["spec.md"], [], [])).toBe("");
  });

  it("is unchanged when nothing was unrecognised", () => {
    expect(notSentPhrase(artifacts)).toBe(
      "specs/001-a/plan.md, specs/001-a/tasks.md, c.md (not read by this analysis)",
    );
  });

  it("carries the reason into the text the run is started with", () => {
    const text = buildHandoffInstructions(
      artifacts,
      "## Acceptance criteria\n- **AC-1**: One\n",
      ["tasks.md"],
      ["plan.md"],
    ).text;
    expect(text.split("\n\n")[0]).toBe(
      "# Spec Kit handoff: evaluate these requirements from spec.md against the current implementation. Only spec.md's requirements are sent. Sent separately as context, not as requirements: specs/001-a/tasks.md. Not sent: specs/001-a/plan.md (read, but no components were recognised); c.md (not read by this analysis).",
    );
  });
});

describe("the handoff parsers are linear in the artifact's length (#1027 review)", () => {
  // `SECTION_RE` was `^#{1,6}\s+(.*\S)\s*$`: a heading line of 40,000 spaces
  // took 700 ms and a 200,000-character one about 17 s, in the browser tab.
  // Each case is the worst input for one pattern; `expectLinearTime` passes a
  // fast call and otherwise compares the time at N with the time at N / 4.
  const AC = "## Acceptance criteria\n- **AC-1**: One\n";
  const cases: Array<[string, (n: number) => () => unknown]> = [
    [
      "a heading line of spaces in plan.md",
      (n) => () => componentsOf(`#${" ".repeat(n)}\n## Components\n- **A** x`),
    ],
    [
      "a heading line of spaces in spec.md",
      (n) => () => buildHandoffInstructions(["spec.md"], `#${" ".repeat(n)}\n${AC}`),
    ],
    [
      "a heading of spaces ending in a word",
      (n) => () => componentsOf(`# a${" ".repeat(n)}b\n## Components\n- **A** x`),
    ],
    [
      "a criterion bullet of spaces",
      (n) => () => buildHandoffInstructions(["spec.md"], `${AC}- ${" ".repeat(n)}x\n`),
    ],
    [
      "a criterion line of asterisks",
      (n) => () => buildHandoffInstructions(["spec.md"], `${AC}${"*".repeat(n)}x\n`),
    ],
    [
      "a line of spaces under Components",
      (n) => () => componentsOf(`## Components\n${" ".repeat(n)}x\n- **A** x`),
    ],
    ["a table row of empty cells", (n) => () => tasksOf(`|${" |".repeat(n / 2)}x`)],
    ["a task bullet of spaces", (n) => () => tasksOf(`-${" ".repeat(n)}x`)],
    ["a numbered line of digits", (n) => () => tasksOf(`${"1".repeat(n)}. T01`)],
    [
      "an unclosed bold component name",
      (n) => () => componentsOf(`## Components\n- **${"a".repeat(n)}`),
    ],
    [
      "a components title of dots and digits",
      (n) => () => componentsOf(`## ${"1.".repeat(n / 2)} x\n## Components\n- **A** x`),
    ],
  ];
  it.each(cases)("%s", (label, at) => {
    expectLinearTime(label, at);
  });
});
