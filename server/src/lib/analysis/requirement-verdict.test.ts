/**
 * Issue #773 — the verdict gate + roll-up.
 *
 * Two properties matter more than any other here, and both directions are tested:
 *   - the gate can only ever WEAKEN a claim (a broken investigation cannot mint a gap);
 *   - it must still let a REAL gap through (a fix that says "could not verify" to
 *     everything is honest and worthless).
 */
import { describe, expect, it } from "vitest";
import type { CodeCitation } from "@metis/shared";
import {
  assertsAbsence,
  computeVerdictsForRequirements,
  deriveRequirementVerdict,
  findingReliesOnSchemaObjects,
  gateFindingVerdict,
  retitleUnverifiableFinding,
  schemaEvidenceFromAffectedRows,
  schemaObjectUnsupported,
  type SchemaObjectEvidence,
  type VerdictFindingInput,
} from "./requirement-verdict.js";

const codeCitation: CodeCitation = { filePath: "src/foo.ts", startLine: 1, endLine: 9 };

describe("#773 — absence-claim classifier", () => {
  it.each([
    "No evidence found for commit-SHA baselining (REQ-002)",
    "Drift severity classification is not implemented",
    "Evidence-snapshot persistence not confirmed",
    "Could not locate any rate-limiting logic",
    "No mechanism exists for baseline capture",
  ])("recognises %j as an absence claim", (title) => {
    expect(assertsAbsence({ title, body: "…" })).toBe(true);
  });

  it("does not classify a purely positive finding as an absence claim", () => {
    expect(
      assertsAbsence({
        title: "Severity is computed in change-analysis-engine.ts",
        body: "computeSeverity already classifies drift severity at lines 131-149.",
      }),
    ).toBe(false);
  });

  // #1111 — phrasings the pre-#1111 list missed, including the epic's own
  // headline example. Measured in `eval/verification/absence-detection.ts`.
  it.each([
    "There is no authorization check on the analysis export endpoint",
    "REQ-4 has no corresponding implementation in the server package",
    "Audit logging appears to be entirely absent from the publishing path",
    "Webhook signature verification was never implemented",
    "Retention policy enforcement is nowhere to be found in the scheduler",
    "No SCIM 2.0 user-provisioning endpoint is implemented (REQ-3)",
  ])("#1111 — recognises %j at BOTH tiers", (title) => {
    expect(assertsAbsence({ title, body: "…" })).toBe(true);
    expect(assertsAbsence({ title, body: "…" }, "grader")).toBe(true);
  });
});

describe("#1111 — the two detection tiers", () => {
  const SUBCLAUSE = {
    title: "Password reset partially implemented",
    body: "resetPassword exists but lacks rate limiting",
  };

  it("does NOT let a subordinate clause trigger the destructive #773 gate", () => {
    // The gate rewrites the title and drops the finding to `info`. A positive
    // finding must not lose its headline over one clause.
    expect(assertsAbsence(SUBCLAUSE)).toBe(false);
    expect(gateFindingVerdict({ groundedCitations: [], finding: SUBCLAUSE })).toBeNull();
  });

  it("DOES send that same clause to the read-only #1111 verifier", () => {
    // One provider call, and at worst a cap at the neutral `medium`. Cheap
    // enough to be worth checking whether the rate limiting really is absent.
    expect(assertsAbsence(SUBCLAUSE, "grader")).toBe(true);
  });

  it("defaults to the narrow tier, so every pre-#1111 caller is unchanged", () => {
    expect(assertsAbsence(SUBCLAUSE)).toBe(assertsAbsence(SUBCLAUSE, "gate"));
  });

  it("makes grader a strict superset — the tiers can never disagree in reverse", () => {
    for (const f of [
      SUBCLAUSE,
      { title: "No evidence found for X", body: "b" },
      { title: "It is implemented", body: "b" },
      { title: "Nothing provisions users", body: "b" },
    ]) {
      if (assertsAbsence(f, "gate")) expect(assertsAbsence(f, "grader")).toBe(true);
    }
  });
});

describe("#773 — gateFindingVerdict downgrades, never upgrades", () => {
  it("downgrades a gap claim to could-not-verify when retrieval could not back it", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: { title: "No evidence found for X", body: "…" },
        absenceConfirmable: false,
      }),
    ).toBe("could-not-verify");
  });

  it("KEEPS a gap claim when retrieval cleared the evidence threshold (anti-regression)", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: { title: "No rate limiting on /api/foo", body: "…" },
        absenceConfirmable: true,
      }),
    ).toBe("gap-confirmed");
  });

  it("gates an absence claim on retrieval health even when the finding cites code", () => {
    // A citation can come from the PASSIVE fused-symbol seed (#729) rather than a
    // search, so a "grounded" citation does not prove the agent's searches worked.
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [codeCitation],
        finding: { title: "X is missing from the pipeline", body: "…" },
        absenceConfirmable: false,
      }),
    ).toBe("could-not-verify");
  });

  it("downgrades an UNCITED 'implemented' claim — the false-positive guard", () => {
    // The dangerous direction once the system is reluctant to claim absence: a
    // hallucinated "you already have this" would silently close a real gap.
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [],
        finding: { title: "Already handled by the scheduler", body: "…" },
        absenceConfirmable: true,
      }),
    ).toBe("could-not-verify");
  });

  it("keeps an 'implemented' claim that cites code which survived grounding", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: { title: "Handled in foo.ts", body: "…" },
        absenceConfirmable: true,
      }),
    ).toBe("implemented");
  });

  it("SYMMETRY: downgrades an 'implemented' claim from a DEGRADED run, citation or not", () => {
    // The #773 run itself: not one search succeeded, yet the passive #729 fused-symbol
    // seed still supplies citation provenance. Gating `implemented` on the citation
    // ALONE let a model close a real gap ("you already have this") on a run that
    // retrieved nothing — with no downgrade, and therefore no banner, anywhere. A
    // confident verdict in EITHER direction requires that retrieval actually worked.
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: { title: "Already implemented in severity.ts", body: "…" },
        absenceConfirmable: false,
        retrievalHealthy: false,
      }),
    ).toBe("could-not-verify");
  });

  it("keeps 'implemented' on a HEALTHY run whose search simply never bore on this claim", () => {
    // Retrieval worked; the agent just did not run a search bearing on this specific
    // requirement (so its ABSENCE could not be confirmed) — but it did cite code that
    // survived #734, which is what an `implemented` claim needs.
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: { title: "Handled in foo.ts", body: "…" },
        absenceConfirmable: false,
        retrievalHealthy: true,
      }),
    ).toBe("implemented");
  });

  it("honours a model that admits it could not verify, whatever the retrieval health", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "could-not-verify",
        groundedCitations: [codeCitation],
        finding: { title: "Unclear", body: "…" },
        absenceConfirmable: true,
      }),
    ).toBe("could-not-verify");
  });

  it("falls back to the text classifier when the model emits no verdict", () => {
    expect(
      gateFindingVerdict({
        groundedCitations: [],
        finding: { title: "No evidence found for REQ-005", body: "…" },
        absenceConfirmable: false,
      }),
    ).toBe("could-not-verify");
  });

  it("the prose classifier can only ever DOWNGRADE — it never mints a gap", () => {
    // On the no-explicit-verdict path a regex hit used to CREATE a `gap-confirmed`
    // claim out of model prose, so on a healthy run it was an UPGRADE straight into a
    // confirmed gap with no model verdict behind it. ABSENCE_PATTERNS is deliberately
    // generous and matches the finding BODY, which routinely discusses the requirement
    // rather than the code ("…this is not addressed by the current spec"). Prose must
    // never manufacture a confident verdict.
    expect(
      gateFindingVerdict({
        groundedCitations: [],
        finding: {
          title: "Baseline capture",
          body: "This is not addressed by the current spec.",
        },
        absenceConfirmable: true, // healthy run — still not a gap
      }),
    ).toBe("could-not-verify");
  });

  it("'cites code' is NOT 'implemented' — an ordinary observation settles nothing", () => {
    // `grounded_in_code` means "cited some code" (the #736 coverage conflation this
    // issue corrects); it must not come back as a VERDICT. A perfectly ordinary code
    // finding cites code, asserts no absence, and closes nothing.
    expect(
      gateFindingVerdict({
        groundedCitations: [codeCitation],
        finding: { title: "The retry logic in foo.ts is hard to follow", body: "…" },
        absenceConfirmable: true,
        retrievalHealthy: true,
      }),
    ).toBeNull();
  });

  it("returns null for a generic observation that claims nothing about a requirement", () => {
    expect(
      gateFindingVerdict({
        groundedCitations: [],
        finding: { title: "The repo uses pnpm workspaces", body: "…" },
        absenceConfirmable: true,
      }),
    ).toBeNull();
  });

  it("treats an omitted absenceConfirmable as 'cannot confirm' (fail closed)", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: { title: "No evidence found for X", body: "…" },
      }),
    ).toBe("could-not-verify");
  });
});

describe("#773 — finding titles never assert an absence that was not established", () => {
  it("rewrites the assertive headline, keeping the subject", () => {
    expect(
      retitleUnverifiableFinding("No evidence found for commit-SHA baselining (REQ-002)"),
    ).toBe("Could not verify: commit-SHA baselining (REQ-002)");
  });

  it("prefixes a title that carries no absence phrasing", () => {
    expect(retitleUnverifiableFinding("Drift severity classification")).toBe(
      "Could not verify: Drift severity classification",
    );
  });

  it("stays within the 255-char title column", () => {
    expect(retitleUnverifiableFinding("x".repeat(400)).length).toBeLessThanOrEqual(255);
  });

  // #778 — the "Could not verify: " prefix is applied EXACTLY once regardless of
  // how many the input already carries: the model is prompted to emit it AND the
  // code adds it, and re-titling can run more than once.
  it("is idempotent when the model already emitted the prefix (#778)", () => {
    expect(retitleUnverifiableFinding("Could not verify: persist evidence snapshot (REQ-1)")).toBe(
      "Could not verify: persist evidence snapshot (REQ-1)",
    );
  });

  it("collapses an already-doubled prefix to a single one (#778)", () => {
    expect(
      retitleUnverifiableFinding(
        "Could not verify: Could not verify: drift severity classification",
      ),
    ).toBe("Could not verify: drift severity classification");
  });

  it("normalizes a mixed could-not-verify + absence prefix to one clean prefix (#778)", () => {
    expect(retitleUnverifiableFinding("Could not verify: No evidence found for X")).toBe(
      "Could not verify: X",
    );
  });
});

describe("#773 — requirement roll-up", () => {
  const f = (over: Partial<VerdictFindingInput>): VerdictFindingInput => ({
    agentKey: "code",
    verdict: null,
    ...over,
  });

  it("is null when the code agent never ran (a doc-only analysis claims nothing about code)", () => {
    expect(deriveRequirementVerdict({ codeAnalysisRan: false, findings: [] })).toBeNull();
  });

  it("confirms a gap when a linked code finding confirmed one", () => {
    expect(
      deriveRequirementVerdict({
        codeAnalysisRan: true,
        findings: [f({ verdict: "gap-confirmed" })],
      }),
    ).toBe("gap-confirmed");
  });

  it("reports could-not-verify when the only claim could not be verified", () => {
    expect(
      deriveRequirementVerdict({
        codeAnalysisRan: true,
        findings: [f({ verdict: "could-not-verify" })],
      }),
    ).toBe("could-not-verify");
  });

  it("reports implemented when a GATED implemented verdict came back", () => {
    expect(
      deriveRequirementVerdict({
        codeAnalysisRan: true,
        findings: [f({ verdict: "implemented" })],
      }),
    ).toBe("implemented");
  });

  it("does NOT infer 'implemented' from a verdict-less finding that happens to cite code", () => {
    // The legacy rule `verdict == null && hasGroundedCode → implemented` reintroduced
    // the exact `grounded_in_code` == "implemented" conflation this issue removes from
    // the #736 coverage copy. A finding with no gated verdict settles nothing.
    expect(
      deriveRequirementVerdict({
        codeAnalysisRan: true,
        findings: [f({ verdict: null })],
      }),
    ).toBe("could-not-verify");
  });

  it("BUDGET STARVATION: a requirement with no code finding is could-not-verify, never a gap", () => {
    // The agent never reached it. Before #773 this surfaced as `no_evidence`
    // coverage and read, downstream, as a confirmed gap.
    expect(deriveRequirementVerdict({ codeAnalysisRan: true, findings: [] })).toBe(
      "could-not-verify",
    );
    // A doc-only finding does not settle a CODE verdict either.
    expect(
      deriveRequirementVerdict({
        codeAnalysisRan: true,
        findings: [f({ agentKey: "document", verdict: "implemented" })],
      }),
    ).toBe("could-not-verify");
  });

  it("index-aligns verdicts with the synthesized requirements", () => {
    const flat = [f({ verdict: "gap-confirmed" }), f({ verdict: "implemented" })];
    expect(
      computeVerdictsForRequirements(
        [{ evidenceFindingIndexes: [0] }, { evidenceFindingIndexes: [1] }, {}],
        flat,
        true,
      ),
    ).toEqual(["gap-confirmed", "implemented", "could-not-verify"]);
  });
});

describe("#826 — schemaObjectUnsupported (the live schema cannot back the object)", () => {
  const obj = (over: Partial<SchemaObjectEvidence>): SchemaObjectEvidence => ({
    tableName: "orders",
    columnName: null,
    reconciliation: null,
    ...over,
  });

  it("is true when the live schema lacks the table", () => {
    expect(schemaObjectUnsupported(obj({ reconciliation: "table-not-found" }))).toBe(true);
  });

  it("is true when the live schema lacks the column", () => {
    expect(
      schemaObjectUnsupported(obj({ columnName: "total", reconciliation: "column-not-found" })),
    ).toBe(true);
  });

  it("is true for a cross-project claim whose identity did not resolve", () => {
    expect(schemaObjectUnsupported(obj({ identityResolved: false }))).toBe(true);
  });

  it("is false when the live schema matched the object", () => {
    expect(schemaObjectUnsupported(obj({ reconciliation: "matched" }))).toBe(false);
  });

  it("is false when there was nothing to reconcile (matched/live-truth or no live index)", () => {
    expect(schemaObjectUnsupported(obj({ reconciliation: null }))).toBe(false);
    expect(schemaObjectUnsupported(obj({ reconciliation: null, identityResolved: true }))).toBe(
      false,
    );
    expect(
      schemaObjectUnsupported(obj({ reconciliation: null, identityResolved: undefined })),
    ).toBe(false);
  });
});

describe("#826 — findingReliesOnSchemaObjects (physical-name reference match)", () => {
  const table = (name: string, over: Partial<SchemaObjectEvidence> = {}): SchemaObjectEvidence => ({
    tableName: name,
    columnName: null,
    reconciliation: "table-not-found",
    ...over,
  });

  it("returns [] when there is no evidence", () => {
    expect(findingReliesOnSchemaObjects({ title: "t", body: "b" }, [])).toEqual([]);
  });

  it("matches a bare table name mentioned in the body", () => {
    const rows = [table("orders")];
    expect(
      findingReliesOnSchemaObjects({ title: "x", body: "The orders table is missing." }, rows),
    ).toEqual(rows);
  });

  it("matches a schema-qualified table by its qualified OR bare name", () => {
    const rows = [table("public.orders")];
    expect(
      findingReliesOnSchemaObjects({ title: "x", body: "no public.orders here" }, rows),
    ).toEqual(rows);
    expect(findingReliesOnSchemaObjects({ title: "x", body: "the orders table" }, rows)).toEqual(
      rows,
    );
  });

  it("does not match a substring or a different identifier", () => {
    const rows = [table("orders")];
    expect(
      findingReliesOnSchemaObjects({ title: "x", body: "we reorder the queue" }, rows),
    ).toEqual([]);
    expect(findingReliesOnSchemaObjects({ title: "x", body: "orders_audit only" }, rows)).toEqual(
      [],
    );
  });

  it("requires the column name (as well as the table) for a column-level object", () => {
    const rows: SchemaObjectEvidence[] = [
      { tableName: "orders", columnName: "total", reconciliation: "column-not-found" },
    ];
    expect(
      findingReliesOnSchemaObjects({ title: "x", body: "the orders table changed" }, rows),
    ).toEqual([]);
    expect(
      findingReliesOnSchemaObjects(
        { title: "x", body: "orders.total needs review in the orders table" },
        rows,
      ),
    ).toEqual(rows);
  });

  it("scans the title and tags, not only the body", () => {
    const rows = [table("orders")];
    expect(findingReliesOnSchemaObjects({ title: "orders gap", body: "b" }, rows)).toEqual(rows);
    expect(findingReliesOnSchemaObjects({ title: "t", body: "b", tags: ["orders"] }, rows)).toEqual(
      rows,
    );
  });
});

describe("#826 — schemaEvidenceFromAffectedRows (project the run's AFFECTED SCHEMA rows)", () => {
  it("maps the fields and derives identityResolved from the optional identity id", () => {
    const rows = [
      // No resolver ran (undefined id) ⇒ identityResolved undefined (never caps).
      { tableName: "orders", columnName: null, reconciliation: "table-not-found" as const },
      // Resolver returned an id ⇒ identityResolved true.
      {
        tableName: "customers",
        columnName: "id",
        reconciliation: "matched" as const,
        schemaObjectIdentityId: "ident:1",
      },
      // Resolver ran but returned null ⇒ identityResolved false (a failed cross-project claim).
      {
        tableName: "invoices",
        columnName: null,
        reconciliation: null,
        schemaObjectIdentityId: null,
      },
    ];
    expect(schemaEvidenceFromAffectedRows(rows)).toEqual([
      {
        tableName: "orders",
        columnName: null,
        reconciliation: "table-not-found",
        identityResolved: undefined,
      },
      {
        tableName: "customers",
        columnName: "id",
        reconciliation: "matched",
        identityResolved: true,
      },
      { tableName: "invoices", columnName: null, reconciliation: null, identityResolved: false },
    ]);
  });
});

describe("#826 — gateFindingVerdict schema gate (DOWNGRADE-only)", () => {
  const notFound: SchemaObjectEvidence = {
    tableName: "orders",
    columnName: null,
    reconciliation: "table-not-found",
  };
  const matched: SchemaObjectEvidence = {
    tableName: "orders",
    columnName: null,
    reconciliation: "matched",
  };
  const ddlFinding = { title: "Add the orders table", body: "The orders table must be created." };

  it("AC1: caps a would-be gap-confirmed that relies on a table absent from the live schema", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: ddlFinding,
        absenceConfirmable: true, // the #773 retrieval gate WOULD allow the gap
        schemaEvidence: [notFound],
      }),
    ).toBe("could-not-verify");
  });

  it("AC1 (symmetric): caps a would-be implemented that relies on an absent table", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: ddlFinding,
        retrievalHealthy: true, // the #773 retrieval gate WOULD allow implemented
        schemaEvidence: [notFound],
      }),
    ).toBe("could-not-verify");
  });

  it("AC2: does NOT downgrade a gap-confirmed backed by fully-reconciled (matched) schema", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: ddlFinding,
        absenceConfirmable: true,
        schemaEvidence: [matched],
      }),
    ).toBe("gap-confirmed");
  });

  it("AC2 (symmetric): does NOT downgrade an implemented backed by matched schema", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: ddlFinding,
        retrievalHealthy: true,
        schemaEvidence: [matched],
      }),
    ).toBe("implemented");
  });

  it("does NOT downgrade when the absent table is not REFERENCED by the finding", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "gap-confirmed",
        groundedCitations: [],
        finding: { title: "Rate limiting missing", body: "No rate limiting on /api." },
        absenceConfirmable: true,
        schemaEvidence: [notFound], // about `orders`, which this finding never mentions
      }),
    ).toBe("gap-confirmed");
  });

  it("caps when a referenced cross-project object's identity did not resolve", () => {
    expect(
      gateFindingVerdict({
        modelVerdict: "implemented",
        groundedCitations: [codeCitation],
        finding: ddlFinding,
        retrievalHealthy: true,
        schemaEvidence: [
          {
            tableName: "orders",
            columnName: null,
            reconciliation: "matched",
            identityResolved: false,
          },
        ],
      }),
    ).toBe("could-not-verify");
  });

  it("is byte-identical to the #773 gate when no schema evidence is supplied", () => {
    const base = {
      modelVerdict: "gap-confirmed" as const,
      groundedCitations: [],
      finding: ddlFinding,
      absenceConfirmable: true,
    };
    expect(gateFindingVerdict(base)).toBe("gap-confirmed");
    expect(gateFindingVerdict({ ...base, schemaEvidence: [] })).toBe("gap-confirmed");
  });

  it("never lets the schema gate touch a could-not-verify base or a no-claim finding", () => {
    // A could-not-verify base short-circuits before the schema gate.
    expect(
      gateFindingVerdict({
        modelVerdict: "could-not-verify",
        groundedCitations: [],
        finding: ddlFinding,
        schemaEvidence: [notFound],
      }),
    ).toBe("could-not-verify");
    // No model verdict + no absence prose ⇒ no claim ⇒ null (the schema gate can
    // never MINT a verdict from a generic observation that names a table).
    expect(
      gateFindingVerdict({
        modelVerdict: null,
        groundedCitations: [],
        finding: { title: "The orders table is nice", body: "An observation about orders." },
        schemaEvidence: [notFound],
      }),
    ).toBeNull();
  });
});
