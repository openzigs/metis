/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #376 (Phase 3) — structural contract for the LLM-optimized
 * spec/plan/tasks artifacts.
 *
 * Two complementary layers:
 *
 *   1. PROMPT-CONTENT CONTRACT — assert the three `SYSTEM_PROMPT`s actually
 *      enforce the rules (stable AC ids, Given/When/Then, example I/O,
 *      "what/why not how" for spec; AC-id traceability + Mermaid for plan;
 *      atomic AC-mapped checklist tasks for tasks). The offline-stub ECHOES
 *      the prompt — it does not synthesize real ACs — so the prompt itself is
 *      the testable contract, not stub output.
 *
 *   2. GOLDEN / STRUCTURAL PARSE — inject a fixture provider via the existing
 *      `deps.provider` seam that returns a representative well-formed
 *      artifact, then assert the reusable `artifact-contract` helper extracts
 *      the expected structure (sections present, ACs parse with ids, tasks
 *      reference AC ids).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

// ── Prisma mock (reused by artifacts service + runner.loadProjectContext) ──
const artifactRows = new Map<string, any>();
let nextId = 0;
const projects = new Map<string, any>();

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitArtifact: {
      findMany: vi.fn(async ({ where }: any) =>
        [...artifactRows.values()].filter((r) => r.projectId === where.projectId),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.projectId_name) {
          for (const r of artifactRows.values()) {
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = {
          id: `ska_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          projectId: data.projectId,
          name: data.name,
          content: data.content ?? "",
          version: data.version ?? 1,
          updatedById: data.updatedById ?? null,
        };
        artifactRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = artifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

vi.mock("../src/lib/finops/index.js", () => ({
  assertWithinBudget: vi.fn(async () => {}),
  BudgetExceededError: class extends Error {},
  recordUsage: vi.fn(() => ({ totalTokens: 0, costCents: 0 })),
}));

vi.mock("../src/lib/safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class extends Error {},
}));

import { runSpecify, SPECIFY_SYSTEM_PROMPT } from "../src/lib/spec-kit/commands/specify.js";
import { runPlan, PLAN_SYSTEM_PROMPT } from "../src/lib/spec-kit/commands/plan.js";
import { runTasks, TASKS_SYSTEM_PROMPT } from "../src/lib/spec-kit/commands/tasks.js";
import { writeArtifact } from "../src/lib/spec-kit/artifacts.js";
import {
  AC_ID_RE,
  SPEC_REQUIRED_SECTIONS,
  PLAN_REQUIRED_SECTIONS,
  extractHeadings,
  extractAcIds,
  extractSectionBody,
  parseAcceptanceCriteria,
  parseContractTasks,
  validateSpecContract,
  validatePlanContract,
  validateTasksContract,
} from "../src/lib/spec-kit/artifact-contract.js";

/** Fixture provider returning a fixed body regardless of the prompt. */
class FixtureProvider implements AIProvider {
  readonly key: any = "offline-stub";
  constructor(private readonly text: string) {}
  async chat(_m: ChatMessage[], _o: unknown): Promise<ChatResponse> {
    return {
      content: this.text,
      provider: this.key,
      model: "fixture-model",
      usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

// ── Representative well-formed fixtures ──────────────────────────────────────

const GOLDEN_SPEC = [
  "# Spec",
  "",
  "Let billing operators view a real-time charges dashboard.",
  "",
  "## Stakeholders",
  "- Billing operator",
  "- Finance lead",
  "",
  "## In scope",
  "- Live charge totals per account",
  "",
  "## Out of scope",
  "- Historical exports",
  "",
  "## Acceptance criteria",
  "",
  "- **AC-1**: Operator sees the running total",
  "  - **Given** an account with open charges",
  "  - **When** the operator opens the dashboard",
  "  - **Then** the running total of all open charges is shown",
  "  - **Example**: input `charges=[10,5]` → output `total=15`",
  "- **AC-2**: Zero-charge accounts show a friendly empty state",
  "  - **Given** an account with no open charges",
  "  - **When** the operator opens the dashboard",
  "  - **Then** an empty-state message is shown instead of a total",
  "",
  "## Non-functional requirements",
  "- Dashboard renders within 500ms p95.",
].join("\n");

const GOLDEN_PLAN = [
  "# Plan",
  "",
  "Compose a read model fed by the charge event stream.",
  "",
  "## Components",
  "- **ChargeReadModel** — aggregates open charges per account. (satisfies: AC-1)",
  "- **EmptyStateView** — renders the friendly empty state. (satisfies: AC-2)",
  "",
  "## Architecture diagram",
  "",
  "```mermaid",
  "graph TD",
  "  A[Charge stream] --> B[ChargeReadModel]",
  "  B --> C[Dashboard]",
  "```",
  "",
  "## Sequence diagrams",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Operator->>Dashboard: open",
  "```",
  "",
  "## ADRs",
  "- **Decision**: use an append-only read model. **Rationale**: live totals. (satisfies: AC-1)",
  "",
  "## Risks & mitigations",
  "- Risk: stream lag. Mitigation: backfill on reconnect.",
].join("\n");

const GOLDEN_TASKS = [
  "## Tasks",
  "",
  "- [ ] T01 — Build the charge read model (satisfies: AC-1) depends-on: none",
  "- [ ] T02 — Render the dashboard total (satisfies: AC-1) depends-on: T01",
  "- [ ] T03 — Render the empty state (satisfies: AC-2) depends-on: T01",
].join("\n");

beforeEach(() => {
  artifactRows.clear();
  projects.clear();
  nextId = 0;
  projects.set("p1", {
    id: "p1",
    name: "Demo",
    description: "Demo project",
    safetyMode: "standard",
    aiProviderId: null,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. PROMPT-CONTENT CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe("specify SYSTEM_PROMPT contract", () => {
  it("enforces stable, individually identifiable AC ids", () => {
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/AC-1.*AC-2.*AC-3/s);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/stable/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/individually addressable/i);
  });

  it("enforces strict Given/When/Then form", () => {
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/Given\/When\/Then/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/\*\*Given\*\*/);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/\*\*When\*\*/);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/\*\*Then\*\*/);
  });

  it("requires at least one example input/output per behavior", () => {
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/example/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/input.*→.*output/i);
  });

  it('enforces the "what/why, not how" boundary (no impl detail)', () => {
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/what\s*\/\s*why,?\s*not\s*how/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/API shapes/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/file paths/i);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/framework/i);
  });

  it("retains all required sections in order", () => {
    for (const s of ["# Spec", "## Stakeholders", "## In scope", "## Out of scope"]) {
      expect(SPECIFY_SYSTEM_PROMPT).toContain(s);
    }
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/## Acceptance criteria/);
    expect(SPECIFY_SYSTEM_PROMPT).toMatch(/## Non-functional requirements/);
  });
});

describe("plan SYSTEM_PROMPT contract", () => {
  it("enforces AC-id traceability for components and ADRs", () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/traceab/i);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/STABLE id/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/AC-1/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/satisfies:/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/NOT by section name/i);
  });

  it("retains the required Mermaid architecture diagram block", () => {
    expect(PLAN_SYSTEM_PROMPT).toMatch(/## Architecture diagram/);
    expect(PLAN_SYSTEM_PROMPT).toMatch(/mermaid/i);
  });

  it("retains the existing sections", () => {
    for (const s of ["# Plan", "## Components", "## Sequence diagrams", "## ADRs"]) {
      expect(PLAN_SYSTEM_PROMPT).toContain(s);
    }
    expect(PLAN_SYSTEM_PROMPT).toMatch(/## Risks & mitigations/);
  });
});

describe("tasks SYSTEM_PROMPT contract", () => {
  it("enforces atomic, PR-sized tasks", () => {
    expect(TASKS_SYSTEM_PROMPT).toMatch(/atomic/i);
    expect(TASKS_SYSTEM_PROMPT).toMatch(/one pull request|PR-able/i);
  });

  it("enforces a Markdown checklist mapped to AC ids", () => {
    expect(TASKS_SYSTEM_PROMPT).toMatch(/checklist/i);
    expect(TASKS_SYSTEM_PROMPT).toMatch(/- \[ \]/);
    expect(TASKS_SYSTEM_PROMPT).toMatch(/satisfies:/);
    expect(TASKS_SYSTEM_PROMPT).toMatch(/AC-1/);
  });

  it("requires coverage of every AC id and topological ordering", () => {
    expect(TASKS_SYSTEM_PROMPT).toMatch(/cover every AC id/i);
    expect(TASKS_SYSTEM_PROMPT).toMatch(/depends-on/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ARTIFACT-CONTRACT HELPER (golden fixtures)
// ─────────────────────────────────────────────────────────────────────────────

describe("artifact-contract helpers", () => {
  it("extractHeadings normalizes ATX headings", () => {
    expect(extractHeadings("# Spec\n## In scope\ntext\n### Sub")).toEqual([
      "spec",
      "in scope",
      "sub",
    ]);
  });

  it("extractAcIds returns distinct ids in first-seen order", () => {
    expect(extractAcIds("see AC-2 and AC-1 and AC-2 again")).toEqual(["AC-2", "AC-1"]);
    expect(extractAcIds("no ids here")).toEqual([]);
  });

  it("AC_ID_RE matches the canonical id form", () => {
    expect(AC_ID_RE.test("AC-7")).toBe(true);
    expect(AC_ID_RE.test("ACX-7")).toBe(false);
  });

  it("extractSectionBody slices a section up to the next same-depth heading", () => {
    const body = extractSectionBody(GOLDEN_SPEC, "acceptance criteria");
    expect(body).toContain("AC-1");
    expect(body).toContain("AC-2");
    expect(body).not.toContain("Non-functional");
  });

  it("extractSectionBody returns empty string for a missing section", () => {
    expect(extractSectionBody(GOLDEN_SPEC, "nonexistent")).toBe("");
  });

  it("parseAcceptanceCriteria parses ids + Given/When/Then clauses", () => {
    const acs = parseAcceptanceCriteria(extractSectionBody(GOLDEN_SPEC, "acceptance criteria"));
    expect(acs.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    expect(acs[0]!.given).toMatch(/open charges/);
    expect(acs[0]!.when).toMatch(/opens the dashboard/);
    expect(acs[0]!.then).toMatch(/running total/);
    expect(acs[1]!.then).toMatch(/empty-state/);
  });

  it("parseAcceptanceCriteria leaves a clause null when it is absent or empty", () => {
    const acs = parseAcceptanceCriteria(
      ["- **AC-9**: partial criterion", "  - **Given** some context", "  - **When**"].join("\n"),
    );
    expect(acs).toHaveLength(1);
    expect(acs[0]!.given).toMatch(/some context/);
    expect(acs[0]!.when).toBeNull(); // keyword present but no text
    expect(acs[0]!.then).toBeNull(); // keyword absent entirely
  });

  it("parseAcceptanceCriteria attaches a leading non-bullet id line to the first criterion", () => {
    const acs = parseAcceptanceCriteria("AC-1 is the first rule\n  - **Then** it holds");
    expect(acs).toHaveLength(1);
    expect(acs[0]!.id).toBe("AC-1");
    expect(acs[0]!.then).toMatch(/it holds/);
  });

  it("parseContractTasks falls back to the raw body when the title strips to empty", () => {
    const tasks = parseContractTasks("- [x] (satisfies: AC-1)");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[0]!.acIds).toEqual(["AC-1"]);
    expect(tasks[0]!.title.length).toBeGreaterThan(0);
  });

  it("parseContractTasks parses checklist items + their AC ids", () => {
    const tasks = parseContractTasks(GOLDEN_TASKS);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.checked).toBe(false);
    expect(tasks[0]!.title).toMatch(/charge read model/i);
    expect(tasks[0]!.acIds).toEqual(["AC-1"]);
    expect(tasks[2]!.acIds).toEqual(["AC-2"]);
  });

  it("validateSpecContract accepts the golden spec", () => {
    const c = validateSpecContract(GOLDEN_SPEC);
    expect(c.hasRequiredSections).toBe(true);
    expect(c.missingSections).toEqual([]);
    expect(c.acceptanceCriteria).toHaveLength(2);
    expect(SPEC_REQUIRED_SECTIONS.every((s) => c.sections.includes(s))).toBe(true);
  });

  it("validateSpecContract flags a spec missing required sections", () => {
    const c = validateSpecContract("# Spec\n\njust a summary");
    expect(c.hasRequiredSections).toBe(false);
    expect(c.missingSections).toContain("acceptance criteria");
    expect(c.acceptanceCriteria).toEqual([]);
  });

  it("validatePlanContract accepts the golden plan with traceability + diagram", () => {
    const c = validatePlanContract(GOLDEN_PLAN);
    expect(c.hasRequiredSections).toBe(true);
    expect(c.hasArchitectureDiagram).toBe(true);
    expect(c.referencedAcIds).toEqual(expect.arrayContaining(["AC-1", "AC-2"]));
    expect(PLAN_REQUIRED_SECTIONS.every((s) => c.sections.includes(s))).toBe(true);
  });

  it("validatePlanContract flags a plan with no Mermaid diagram", () => {
    const noDiagram = GOLDEN_PLAN.replace(/```mermaid[\s\S]*?```/g, "(diagram TODO)");
    const c = validatePlanContract(noDiagram);
    expect(c.hasArchitectureDiagram).toBe(false);
  });

  it("validateTasksContract accepts the golden tasks (all AC-mapped)", () => {
    const c = validateTasksContract(GOLDEN_TASKS);
    expect(c.allTasksMapped).toBe(true);
    expect(c.unmappedTaskTitles).toEqual([]);
    expect(c.tasks).toHaveLength(3);
  });

  it("validateTasksContract flags a task with no AC mapping", () => {
    const bad = GOLDEN_TASKS + "\n- [ ] T04 — Orphan task with no mapping depends-on: none";
    const c = validateTasksContract(bad);
    expect(c.allTasksMapped).toBe(false);
    expect(c.unmappedTaskTitles.some((t) => /orphan/i.test(t))).toBe(true);
  });

  it("validateTasksContract treats an empty checklist as unmapped", () => {
    const c = validateTasksContract("## Tasks\n\nno tasks yet");
    expect(c.allTasksMapped).toBe(false);
    expect(c.tasks).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GOLDEN / STRUCTURAL PARSE through the runner (deps.provider seam)
// ─────────────────────────────────────────────────────────────────────────────

describe("end-to-end structural contract via the deps.provider seam", () => {
  it("a fixture spec.md round-trips into a valid, parseable contract", async () => {
    const r = await runSpecify({
      projectId: "p1",
      prompt: "build a billing dashboard",
      deps: { provider: new FixtureProvider(GOLDEN_SPEC) },
    });
    const c = validateSpecContract(r.artifact.content);
    expect(c.hasRequiredSections).toBe(true);
    expect(c.acceptanceCriteria.map((a) => a.id)).toEqual(["AC-1", "AC-2"]);
    expect(c.acceptanceCriteria.every((a) => a.given && a.when && a.then)).toBe(true);
  });

  it("a fixture plan.md round-trips with AC traceability + Mermaid diagram", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: GOLDEN_SPEC });
    const r = await runPlan({
      projectId: "p1",
      deps: { provider: new FixtureProvider(GOLDEN_PLAN) },
    });
    const c = validatePlanContract(r.artifact.content);
    expect(c.hasRequiredSections).toBe(true);
    expect(c.hasArchitectureDiagram).toBe(true);
    expect(c.referencedAcIds).toEqual(expect.arrayContaining(["AC-1", "AC-2"]));
  });

  it("a fixture tasks.md round-trips with every task mapped to an AC id", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: GOLDEN_SPEC });
    await writeArtifact({ projectId: "p1", name: "plan.md", content: GOLDEN_PLAN });
    const r = await runTasks({
      projectId: "p1",
      deps: { provider: new FixtureProvider(GOLDEN_TASKS) },
    });
    const c = validateTasksContract(r.artifact.content);
    expect(c.allTasksMapped).toBe(true);
    expect(c.tasks).toHaveLength(3);
    // Every AC id in the spec is covered by at least one task.
    const specAcIds = validateSpecContract(GOLDEN_SPEC).acceptanceCriteria.map((a) => a.id);
    const coveredAcIds = new Set(c.tasks.flatMap((t) => t.acIds));
    expect(specAcIds.every((id) => coveredAcIds.has(id))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. PHASE-4 CONTRACT LOCK (#377)
//
// Phase 4 verifies S6: it must remain true that the downstream-consumable
// contract is intact end-to-end across the three artifacts — stable AC ids,
// at least one example I/O on a behavior, and full tasks→AC traceability.
// These assertions are deliberately phrased as a single coherent "lock" so a
// future change that silently drops example I/O or breaks task↔AC mapping
// fails here. They reuse the `artifact-contract` helper rather than ad-hoc
// parsing, and use only LITERAL regexes (Semgrep detect-non-literal-regexp).
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase-4 artifact contract lock (#377)", () => {
  it("locks stable, sequential AC ids in spec.md", () => {
    const c = validateSpecContract(GOLDEN_SPEC);
    const ids = c.acceptanceCriteria.map((a) => a.id);
    // Stable, sequential, no gaps — downstream agents address ACs by these ids.
    expect(ids).toEqual(["AC-1", "AC-2"]);
    // Each criterion is a complete Given/When/Then triple.
    expect(c.acceptanceCriteria.every((a) => a.given && a.when && a.then)).toBe(true);
  });

  it("locks at least one example I/O on a behavior (input → output)", () => {
    const acBody = extractSectionBody(GOLDEN_SPEC, "acceptance criteria");
    const ac1 = parseAcceptanceCriteria(acBody).find((a) => a.id === "AC-1");
    expect(ac1).toBeDefined();
    // The example line survives into the parsed criterion's raw block and is
    // expressed as a concrete input → output pair (literal regex, no dynamic
    // RegExp construction).
    expect(ac1!.raw).toMatch(/Example/);
    expect(ac1!.raw).toMatch(/input.*→.*output/);
    expect(ac1!.raw).toContain("total=15");
  });

  it("locks full tasks→AC traceability (every spec AC covered by ≥1 task)", () => {
    const specAcIds = validateSpecContract(GOLDEN_SPEC).acceptanceCriteria.map((a) => a.id);
    const tasks = validateTasksContract(GOLDEN_TASKS);
    expect(tasks.allTasksMapped).toBe(true);
    const coveredAcIds = new Set(tasks.tasks.flatMap((t) => t.acIds));
    // No spec AC is orphaned, and no task references an unknown AC.
    expect(specAcIds.every((id) => coveredAcIds.has(id))).toBe(true);
    const specAcSet = new Set(specAcIds);
    expect([...coveredAcIds].every((id) => specAcSet.has(id))).toBe(true);
  });

  it("locks plan.md AC traceability + mandatory Mermaid architecture diagram", () => {
    const plan = validatePlanContract(GOLDEN_PLAN);
    expect(plan.hasArchitectureDiagram).toBe(true);
    // The plan references the spec's ACs by their stable ids, not paraphrases.
    expect(plan.referencedAcIds).toEqual(expect.arrayContaining(["AC-1", "AC-2"]));
  });
});
