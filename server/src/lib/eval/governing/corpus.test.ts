import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MIN_NEGATIVE_ITEMS,
  MIN_NON_RESEMBLING_ITEMS,
  PROPOSED_THRESHOLDS,
  SHORT_SUBJECT_WORDS,
  contentStems,
  evaluationLeaks,
  expectedThresholds,
  listCorpusFiles,
  loadGoverningCorpus,
  parsePolicyClauses,
  resolveGoverningCorpusDir,
  ruleIdsIn,
  sharedPhrases,
  sharedVocabulary,
  trustServicesCriteriaMarkers,
  validateGoverningCorpus,
  type CorpusFiles,
  type GoverningCorpusManifest,
} from "./corpus.js";

const NAME = "governing-01-sample-policy";
const DIR = resolveGoverningCorpusDir(NAME);

async function committed(): Promise<{ manifest: GoverningCorpusManifest; files: CorpusFiles }> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(DIR, "manifest.json"), "utf8"),
  ) as GoverningCorpusManifest;
  const policies = new Map<string, string>();
  for (const rev of manifest.policy.revisions) {
    policies.set(rev.revision, await fs.readFile(path.join(DIR, rev.file), "utf8"));
  }
  return { manifest, files: { present: await listCorpusFiles(DIR), policies } };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("the committed governing corpus", () => {
  it("loads, and has the shape #1867 asks for", async () => {
    const corpus = await loadGoverningCorpus(NAME);
    expect(corpus.rules).toHaveLength(40);
    const items = corpus.manifest.items;
    expect(items.length).toBeGreaterThanOrEqual(30);
    expect(items.filter((i) => i.applies.length === 0).length).toBeGreaterThanOrEqual(
      MIN_NEGATIVE_ITEMS,
    );
    expect(
      items.filter((i) => i.applies.some((p) => p.nonResembling)).length,
    ).toBeGreaterThanOrEqual(MIN_NON_RESEMBLING_ITEMS);
    // Every clause is read from the stored policy, not from the manifest.
    expect(corpus.ruleById.get("AL-02")?.clause).toMatch(/^Every bulk extraction of customer/);
    expect(corpus.policyText).toContain(`**AL-02** ${corpus.ruleById.get("AL-02")!.clause}`);
  });

  it("lists every file of its directory in the manifest (and lists nothing that is not there)", async () => {
    const { manifest } = await committed();
    const present = (await listCorpusFiles(DIR)).filter((f) => f !== "manifest.json");
    expect([...present].sort()).toEqual([...manifest.files].sort());
  });

  it("is synthetic: the policy carries no Trust Services Criteria marker, and the annotation says it was written for the fixture", async () => {
    const { manifest, files } = await committed();
    expect(manifest.synthetic).toBe(true);
    for (const text of files.policies.values())
      expect(trustServicesCriteriaMarkers(text)).toEqual([]);
    const annotation = await fs.readFile(path.join(DIR, "ANNOTATION.md"), "utf8");
    expect(annotation).toMatch(/written for this fixture/);
    expect(annotation).toMatch(/No AICPA Trust Services Criteria text was opened, read or copied/);
  });

  it("records the proposed pass thresholds, unchanged, before any arm ran", async () => {
    const { manifest } = await committed();
    const t = manifest.thresholds;
    expect(t.recordedBeforeAnyArmRan).toBe(true);
    expect({
      overallRecall: t.overallRecall,
      nonResemblingRecall: t.nonResemblingRecall,
      precision: t.precision,
      citationAccuracy: t.citationAccuracy,
      maxNoEvidenceCompliantErrors: t.maxNoEvidenceCompliantErrors,
    }).toEqual(expectedThresholds(t.changes));
    expect(PROPOSED_THRESHOLDS).toEqual({
      overallRecall: 0.9,
      nonResemblingRecall: 0.85,
      precision: 0.6,
      citationAccuracy: 0.95,
      maxNoEvidenceCompliantErrors: 0,
    });
  });

  it("revises 3-5 clauses in v2, exactly the ones it says", async () => {
    const { manifest, files } = await committed();
    const v2 = manifest.policy.revisions.find((r) => r.revision === "v2")!;
    expect(v2.changedRules.length).toBeGreaterThanOrEqual(3);
    expect(v2.changedRules.length).toBeLessThanOrEqual(5);
    const a = parsePolicyClauses(files.policies.get("v1")!).clauses;
    const b = parsePolicyClauses(files.policies.get("v2")!).clauses;
    const changed = [...a.keys()].filter((id) => a.get(id) !== b.get(id)).sort();
    expect(changed).toEqual([...v2.changedRules].sort());
  });
});

describe("validateGoverningCorpus — the drift it must catch", () => {
  it("passes the committed corpus", async () => {
    const { manifest, files } = await committed();
    expect(validateGoverningCorpus(manifest, files)).toEqual([]);
  });

  it("FAILS on a file the manifest does not list, and on a listed file that is missing", async () => {
    const { manifest, files } = await committed();
    const extra = validateGoverningCorpus(manifest, {
      ...files,
      present: [...files.present, "notes.txt"],
    });
    expect(extra).toContain(
      "notes.txt is in the corpus directory but not listed in the manifest's files",
    );
    const m = clone(manifest);
    m.files.push("gone.md");
    expect(validateGoverningCorpus(m, files)).toContain(
      "the manifest lists gone.md, which does not exist",
    );
  });

  it("FAILS on a Trust Services Criteria marker in a policy revision", async () => {
    const { manifest, files } = await committed();
    const policies = new Map(files.policies);
    policies.set("v1", `${policies.get("v1")}\n\nSee CC6.1 for the entity's objectives.\n`);
    const problems = validateGoverningCorpus(manifest, { ...files, policies });
    expect(
      problems.some((p) =>
        /Trust Services Criteria markers \(CC6\.1, entity's objectives\)/.test(p),
      ),
    ).toBe(true);
  });

  it("FAILS on a policy that tells the model it is an evaluation", async () => {
    const { manifest, files } = await committed();
    const policies = new Map(files.policies);
    policies.set(
      "v2",
      `${policies.get("v2")}\n\nThis synthetic fixture is for the METIS eval (#1867).\n`,
    );
    expect(validateGoverningCorpus(manifest, { ...files, policies })).toContain(
      "policy v2 (policy-v2.md): tells the model it is an evaluation (#1867, METIS, eval, fixture, synthetic)",
    );
    expect(evaluationLeaks("Effective 2026-01-01; see section 4.")).toEqual([]);
  });

  it("FAILS on a requirement, rule summary or policy title that tells the model it is an evaluation (#1900)", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    m.items[0]!.text += " This is a synthetic eval item.";
    m.items[1]!.title = "Fixture: export";
    m.rules[0]!.summary += " (ground truth for #1867)";
    m.policy.title = "METIS sample policy";
    const problems = validateGoverningCorpus(m, files);
    expect(problems).toContain(
      `item ${m.items[0]!.id}: tells the model it is an evaluation (eval, synthetic)`,
    );
    expect(problems).toContain(
      `item ${m.items[1]!.id}: tells the model it is an evaluation (Fixture)`,
    );
    expect(problems).toContain(
      `rule ${m.rules[0]!.id}'s summary: tells the model it is an evaluation (#1867, ground truth)`,
    );
    expect(problems).toContain("the policy title: tells the model it is an evaluation (METIS)");
  });

  it("FAILS when v2's changedRules does not match its text", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    m.policy.revisions[1]!.changedRules = ["AC-05"];
    expect(
      validateGoverningCorpus(m, files).some((p) => p.includes("but changedRules says AC-05")),
    ).toBe(true);
  });

  it("FAILS on a rule with no clause, and a clause with no rule", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    m.rules.push({ id: "ZZ-01", area: "x", summary: "y" });
    expect(validateGoverningCorpus(m, files)).toContain(
      "policy v1 (policy-v1.md): no clause for rule ZZ-01",
    );
    const n = clone(manifest);
    n.rules = n.rules.filter((r) => r.id !== "PR-05");
    n.items = n.items.map((i) => ({
      ...i,
      applies: i.applies.filter((p) => p.ruleId !== "PR-05"),
    }));
    expect(validateGoverningCorpus(n, files)).toContain(
      "policy v1 (policy-v1.md): clause PR-05 is not a rule of the manifest",
    );
  });

  it("FAILS on a requirement that names a rule id or copies a clause's wording", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    m.items[0]!.text = "Do what AC-01 says.";
    m.items[1]!.text = "Make sure every bulk extraction of customer or financial records is fine.";
    const problems = validateGoverningCorpus(m, files);
    expect(problems).toContain(`item ${m.items[0]!.id}: names rule ids (AC-01)`);
    expect(
      problems.some((p) => p.startsWith(`item ${m.items[1]!.id}: copies AL-02's wording`)),
    ).toBe(true);
  });

  it("FAILS on a non-resembling pair that shares vocabulary with its rule", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    const item = m.items.find((i) => i.id === "GR-01")!;
    item.text = `${item.text} Each download is an export of financial records.`;
    expect(
      validateGoverningCorpus(m, files).some((p) =>
        p.startsWith("item GR-01 → AL-02: labelled non-resembling but shares finan, recor"),
      ),
    ).toBe(true);
  });

  it("FAILS on a verdict without its business fact, a fact on another verdict, an unknown verdict, rule or repeat", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    const item = m.items.find((i) => i.id === "GR-13")!;
    item.applies = [
      { ruleId: "DR-02", verdict: "compliant", businessFact: "why?" },
      { ruleId: "DR-01", verdict: "needs-ba-input" },
      { ruleId: "DR-01", verdict: "gap" },
      { ruleId: "ZZ-99", verdict: "gap" },
      { ruleId: "DR-05", verdict: "maybe" as never },
    ];
    const problems = validateGoverningCorpus(m, files);
    expect(problems).toEqual(
      expect.arrayContaining([
        "item GR-13 → DR-02: a business fact on a compliant pair",
        "item GR-13 → DR-01: needs-ba-input without the business fact a BA would supply",
        "item GR-13 → DR-01: listed twice",
        "item GR-13 → ZZ-99: not a rule of the policy",
        'item GR-13 → DR-05: unknown verdict "maybe"',
      ]),
    );
  });

  it("FAILS with too few non-resembling or negative items", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    m.items = m.items.filter(
      (i) => i.applies.length > 0 && !i.applies.some((p) => p.nonResembling),
    );
    const problems = validateGoverningCorpus(m, files);
    expect(problems).toContain(
      `0 non-resembling item(s); at least ${MIN_NON_RESEMBLING_ITEMS} are needed`,
    );
    expect(problems).toContain(`0 negative item(s); at least ${MIN_NEGATIVE_ITEMS} are needed`);
  });

  it("FAILS on a threshold edited without a recorded change, and accepts one with its reason", async () => {
    const { manifest, files } = await committed();
    const silent = clone(manifest);
    silent.thresholds.overallRecall = 0.8;
    expect(validateGoverningCorpus(silent, files)).toContain(
      "thresholds: overallRecall is 0.8, but the proposal and its recorded changes give 0.9 (record the change and why)",
    );
    const recorded = clone(silent);
    recorded.thresholds.changes.push({
      issue: "#1872",
      at: "2026-12-01",
      reason: "measured ceiling on the held-out set",
      set: { overallRecall: 0.8 },
    });
    expect(validateGoverningCorpus(recorded, files)).toEqual([]);
    const noReason = clone(recorded);
    noReason.thresholds.changes[0]!.reason = " ";
    expect(validateGoverningCorpus(noReason, files)).toContain(
      "thresholds: a change without its issue, date and reason",
    );
    const late = clone(manifest);
    late.thresholds.recordedBeforeAnyArmRan = false;
    expect(validateGoverningCorpus(late, files)).toContain(
      "thresholds: not recorded before any arm ran",
    );
  });

  it("FAILS on a corpus not marked synthetic, or a scored revision that does not exist", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    (m as { synthetic: boolean }).synthetic = false;
    m.policy.scored = "v9";
    const problems = validateGoverningCorpus(m, files);
    expect(problems).toContain("the corpus must be marked synthetic");
    expect(problems).toContain("the scored revision v9 is not one of the policy's revisions");
  });
});

describe("the text checks", () => {
  it("contentStems cuts to five letters and drops stop words and short words", () => {
    expect(
      [...contentStems("The records were recorded by finance for the financial team")].sort(),
    ).toEqual(["finan", "recor", "team"]);
  });

  it("contentStems keeps short subject words, plural or not (#1900)", () => {
    expect([...contentStems("Log the VAT and tax on PII; the logs list taxes")].sort()).toEqual([
      "list",
      "log",
      "logs",
      "pii",
      "tax",
      "taxes",
      "vat",
    ]);
    expect(SHORT_SUBJECT_WORDS.has("log")).toBe(true);
    // Other short words still carry nothing.
    expect([...contentStems("the box was on top of it")]).toEqual([]);
    expect(sharedVocabulary("keep the logs", "every log entry")).toEqual(["log"]);
  });

  it("contentStems folds the past, -ing and -ation forms of a short subject word too (#1920)", () => {
    for (const [inflected, base] of [
      ["logging", "log"],
      ["logged", "log"],
      ["taxation", "tax"],
      ["taxed", "tax"],
      ["keyed", "key"],
      ["keys", "key"],
      ["paying", "pay"],
    ] as const) {
      expect(contentStems(inflected).has(base), inflected).toBe(true);
    }
    expect(sharedVocabulary("logging every login", "keep a log")).toEqual(["log"]);
    // A word that only starts like one is not folded onto it.
    expect([...contentStems("logic taxi")].sort()).toEqual(["logic", "taxi"]);
  });

  it("contentStems folds the derived forms of a short subject word, and the irregular paid (#1932)", () => {
    for (const [derived, base] of [
      ["payment", "pay"],
      ["payments", "pay"],
      ["payer", "pay"],
      ["payers", "pay"],
      ["payable", "pay"],
      ["paid", "pay"],
      ["logger", "log"],
      ["loggers", "log"],
      ["taxable", "tax"],
    ] as const) {
      expect(contentStems(derived).has(base), derived).toBe(true);
    }
    // A pay/payment pair resembles: it can never pass as non-resembling.
    expect(sharedVocabulary("record each payment", "who may pay a supplier")).toEqual(["pay"]);
    expect(sharedVocabulary("invoices already paid", "pay suppliers on time")).toEqual(["pay"]);
    // A word that only ends like one is not folded onto a short base.
    expect([...contentStems("paper tables")].sort()).toEqual(["paper", "table"]);
  });

  it("sharedVocabulary is empty for the GR-01 pair and not for a resembling one", () => {
    expect(
      sharedVocabulary("download last month's invoices", "bulk extraction of financial records"),
    ).toEqual([]);
    expect(
      sharedVocabulary("export financial data", "bulk extraction of financial records"),
    ).toEqual(["finan"]);
  });

  it("sharedPhrases finds a copied five-word run and nothing shorter", () => {
    expect(
      sharedPhrases("we keep audit trail entries for ever", "Audit trail entries are kept"),
    ).toEqual([]);
    expect(
      sharedPhrases(
        "so audit trail entries are kept long",
        "Audit trail entries are kept for at least one year.",
      ),
    ).toEqual(["audit trail entries are kept"]);
  });

  it("ruleIdsIn and parsePolicyClauses read ids and report a repeated clause", () => {
    expect(ruleIdsIn("see AC-01, AL-02 and AC-01; not A-1 or ABC-123")).toEqual(["AC-01", "AL-02"]);
    const { clauses, duplicates } = parsePolicyClauses(
      "# t\n\n**AC-01** One.\n\nprose\n\n**AC-01** Two.\n**AL-02**   Three.  \n",
    );
    expect([...clauses]).toEqual([
      ["AC-01", "One."],
      ["AL-02", "Three."],
    ]);
    expect(duplicates).toEqual(["AC-01"]);
  });

  it("trustServicesCriteriaMarkers names each marker once", () => {
    expect(
      trustServicesCriteriaMarkers("CC6.1, PI1.2, A1.2 and CC6.1 meet the entity’s objectives"),
    ).toEqual(["A1.2", "CC6.1", "PI1.2", "entity’s objectives"]);
  });
});

describe("loading", () => {
  it("refuses an unknown corpus name", () => {
    expect(() => resolveGoverningCorpusDir("nope")).toThrow(/unknown governing corpus: "nope"/);
  });

  const tempDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(tempDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  async function tempCorpus(mutate: (m: GoverningCorpusManifest) => void): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "governing-"));
    tempDirs.push(dir);
    const { manifest } = await committed();
    for (const f of manifest.files) await fs.copyFile(path.join(DIR, f), path.join(dir, f));
    const m = clone(manifest);
    mutate(m);
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(m), "utf8");
    return dir;
  }

  it("refuses a manifest whose id is another corpus's", async () => {
    const dir = await tempCorpus((m) => {
      (m as { id: string }).id = "other";
    });
    await expect(loadGoverningCorpus(NAME, dir)).rejects.toThrow(/manifest id is "other"/);
  });

  it("refuses a revision file outside the corpus directory", async () => {
    const dir = await tempCorpus((m) => {
      m.policy.revisions[1]!.file = "../outside.md";
    });
    await expect(loadGoverningCorpus(NAME, dir)).rejects.toThrow(/leaves the corpus/);
  });

  it("lists every problem when the corpus does not hold together", async () => {
    const dir = await tempCorpus((m) => {
      m.items[0]!.text = "AC-01";
    });
    await fs.writeFile(path.join(dir, "stray.txt"), "x", "utf8");
    await expect(loadGoverningCorpus(NAME, dir)).rejects.toThrow(
      /is not sound:\n {2}- stray\.txt is in the corpus directory[\s\S]*names rule ids \(AC-01\)/,
    );
  });
});
