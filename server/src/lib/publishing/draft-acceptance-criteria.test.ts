/**
 * Issue #1096 — generated drafts must carry the requirement's REAL acceptance
 * criteria.
 *
 * Every draft used to end with the same three lines regardless of content:
 *
 *   - [ ] **Given** the system is configured
 *   - [ ] **When** the change ships
 *   - [ ] **Then** the requirement above is satisfied with tests proving it
 *
 * A test asserting "the body has an acceptance-criteria section" or "the section
 * is non-empty" passes against that bug. So these tests assert SUBSTANCE:
 *   - the rendered criteria contain terms drawn from the requirement's own
 *     criteria (INVENTORY.QTY, CARD_LAST_FOUR, …), and differ between two
 *     different requirements;
 *   - the specific placeholder sentences never appear in any output;
 *   - an empty criteria set renders a visible "none were derived" note, not
 *     filler that reads as authored.
 *
 * Reintroducing the placeholder fails "renders criteria drawn from the
 * requirement" (the terms would be missing) AND "never emits the boilerplate".
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const { __testing, NO_ACCEPTANCE_CRITERIA_NOTE } = await import("./draft-generator.js");
const { renderAcceptanceCriteria, renderFeatureBody, renderEpicBody } = __testing;

/** The R3 example from the #1096 report. */
const INVENTORY_CRITERIA = [
  "Checkout validates available quantity for every line item inside the same transaction that writes the order.",
  "An insufficient-stock condition aborts the entire order atomically and returns a per-item message naming the item and the quantity available.",
  "INVENTORY.QTY can never go below zero, enforced by a database CHECK constraint as well as application logic.",
];

const PCI_CRITERIA = [
  "The ORDERS table no longer stores CREDITCARD or EXPRDATE; only CARDTYPE and CARD_LAST_FOUR (CHAR(4)) remain.",
  "A schema migration drops the plaintext columns and backfills CARD_LAST_FOUR.",
];

/** The exact strings the bug emitted — none of them may ever reappear. */
const PLACEHOLDER_LINES = [
  "**Given** the system is configured",
  "**When** the change ships",
  "**Then** the requirement above is satisfied with tests proving it",
];

describe("renderAcceptanceCriteria (#1096)", () => {
  it("renders criteria drawn from the requirement, not a fixed template", () => {
    const inventory = renderAcceptanceCriteria({
      body: "Inventory is decremented after the order is written.",
      acceptanceCriteria: INVENTORY_CRITERIA,
    });
    const pci = renderAcceptanceCriteria({
      body: "Card data is persisted in cleartext.",
      acceptanceCriteria: PCI_CRITERIA,
    });

    // Substance: terms from the requirement's own criteria survive into the output.
    expect(inventory).toContain("INVENTORY.QTY");
    expect(inventory).toContain("same transaction that writes the order");
    expect(pci).toContain("CARD_LAST_FOUR");

    // Two different requirements must not render the same block.
    expect(inventory).not.toBe(pci);
    expect(pci).not.toContain("INVENTORY.QTY");

    // One checkbox per criterion, nothing dropped.
    expect(inventory.split("\n")).toHaveLength(INVENTORY_CRITERIA.length);
    for (const line of inventory.split("\n")) expect(line.startsWith("- [ ] ")).toBe(true);
  });

  it("says so plainly when no criteria were derived", () => {
    const rendered = renderAcceptanceCriteria({
      body: "Card data is persisted in cleartext.",
      acceptanceCriteria: [],
    });

    expect(rendered).toBe(NO_ACCEPTANCE_CRITERIA_NOTE);
    expect(rendered).toMatch(/No acceptance criteria were derived/);
    // It must not look like a satisfied checklist.
    expect(rendered).not.toContain("- [ ]");
  });

  it("never emits the boilerplate Given/When/Then block", () => {
    const outputs = [
      renderAcceptanceCriteria({ body: "Anything at all.", acceptanceCriteria: [] }),
      renderAcceptanceCriteria({ body: "", acceptanceCriteria: [] }),
      renderAcceptanceCriteria({ body: "Anything.", acceptanceCriteria: INVENTORY_CRITERIA }),
    ];
    for (const out of outputs) {
      for (const line of PLACEHOLDER_LINES) expect(out).not.toContain(line);
    }
  });

  it("drops blank criteria rather than rendering empty checkboxes", () => {
    const rendered = renderAcceptanceCriteria({
      body: "x",
      acceptanceCriteria: ["  ", "", "Order total is recomputed server-side."],
    });
    expect(rendered).toBe("- [ ] Order total is recomputed server-side.");
  });

  it("still bullets a body the analysis already wrote as Gherkin", () => {
    const rendered = renderAcceptanceCriteria({
      body: "Given a cart\nWhen checkout runs\nThen stock is reserved",
      acceptanceCriteria: [],
    });
    expect(rendered).toContain("- [ ] Given a cart");
    expect(rendered).toContain("- [ ] Then stock is reserved");
  });
});

describe("renderFeatureBody (#1096)", () => {
  const project = { id: "proj-123456789", name: "JPetStore" };
  const analysis = { id: "cms3tjy9r0001259kozwuencx" };

  it("publishes the requirement's own criteria in the issue body", () => {
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: {
        id: "cms3tyeq0001abcd",
        title: "Enforce inventory availability at checkout",
        body: "Stock is decremented after the order is written.",
        type: "bug",
        priority: "critical",
        acceptanceCriteria: JSON.stringify(INVENTORY_CRITERIA),
      },
      parentTitle: "[Epic] JPetStore",
    });

    expect(body).toContain("INVENTORY.QTY");
    for (const line of PLACEHOLDER_LINES) expect(body).not.toContain(line);
  });

  it("flags the absence instead of filling it in", () => {
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: {
        id: "cms3tyeq0002abcd",
        title: "Eliminate cleartext payment card storage",
        body: "The ORDERS table persists full card numbers.",
        type: "bug",
        priority: "critical",
        acceptanceCriteria: "[]",
      },
      parentTitle: "[Epic] JPetStore",
    });

    expect(body).toContain("No acceptance criteria were derived");
    for (const line of PLACEHOLDER_LINES) expect(body).not.toContain(line);
  });

  it("tolerates a malformed criteria column without inventing criteria", () => {
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: {
        id: "cms3tyeq0003abcd",
        title: "Migrate SIGNON credentials",
        body: "Passwords are stored in cleartext.",
        type: "bug",
        priority: "critical",
        acceptanceCriteria: "{not json",
      },
      parentTitle: "[Epic] JPetStore",
    });
    expect(body).toContain("No acceptance criteria were derived");
  });

  it("carries the full requirement id in the traceability footer", () => {
    const id = "cms3tyeq0004wxyz";
    const body = renderFeatureBody({
      project,
      analysis,
      requirement: {
        id,
        title: "t",
        body: "b",
        type: "bug",
        priority: "high",
        acceptanceCriteria: "[]",
      },
      parentTitle: "[Epic] JPetStore",
    });
    expect(body).toContain(`requirement=\`${id}\``);
  });
});

describe("renderEpicBody sub-issue ids (#1096)", () => {
  it("distinguishes requirements minted in the same millisecond", () => {
    // Real cuid2 ids from the report: identical for the first 8 characters.
    const requirements = [
      {
        id: "cms3tyeq0001aaaa",
        title: "Eliminate cleartext card storage",
        type: "bug",
        priority: "critical",
      },
      {
        id: "cms3tyeq0002bbbb",
        title: "Migrate SIGNON credentials",
        type: "bug",
        priority: "critical",
      },
      {
        id: "cms3tyeq0003cccc",
        title: "Atomic order-id allocation",
        type: "bug",
        priority: "critical",
      },
    ];

    const body = renderEpicBody({
      project: { id: "proj-1", name: "JPetStore" },
      analysis: { id: "analysis-1" },
      requirements,
    });

    const rendered = requirements.map((r) => {
      const line = body.split("\n").find((l) => l.includes(r.title));
      expect(line).toBeDefined();
      return (line as string).slice((line as string).indexOf("—"));
    });

    // The bug: all three annotations were the identical string `cms3tyeq`.
    expect(new Set(rendered).size).toBe(3);
    for (const r of requirements) expect(body).toContain(`\`${r.id}\``);
  });
});
