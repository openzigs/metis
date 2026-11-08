import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTENT_HASH_COVERS,
  assertBaselineAllowed,
  MIN_NEGATIVE_ITEMS,
  MIN_NON_RESEMBLING_ITEMS,
  PROPOSED_THRESHOLDS,
  SHORT_SUBJECT_WORDS,
  contentStems,
  evaluationLeaks,
  expectedThresholds,
  governingContentHash,
  listCorpusFiles,
  loadGoverningCorpus,
  parsePolicyClauses,
  resolveGoverningCorpusDir,
  ruleIdsIn,
  sharedPhrases,
  sharedVocabulary,
  shortAnswerPairs,
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

const HELD_OUT = "governing-02-clinic-records";
const HELD_OUT_DIR = resolveGoverningCorpusDir(HELD_OUT);

async function heldOut(): Promise<{ manifest: GoverningCorpusManifest; files: CorpusFiles }> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(HELD_OUT_DIR, "manifest.json"), "utf8"),
  ) as GoverningCorpusManifest;
  const policies = new Map<string, string>();
  for (const rev of manifest.policy.revisions) {
    policies.set(rev.revision, await fs.readFile(path.join(HELD_OUT_DIR, rev.file), "utf8"));
  }
  const annotation = await fs.readFile(path.join(HELD_OUT_DIR, "ANNOTATION.md"), "utf8");
  return {
    manifest,
    files: { present: await listCorpusFiles(HELD_OUT_DIR), policies, annotation },
  };
}

interface LabelFile {
  items: Array<{ id: string; applies: Array<{ ruleId: string; verdict: string }> }>;
}
interface AdjudicationFile {
  agreement: { applicability: { kappa: number }; fourWay: { kappa: number } };
  disagreements: Array<{ item: string; rule: string; decision: string; reason: string }>;
  consistencyPass: {
    rules: string[];
    changes: Array<{
      item: string;
      rule: string;
      from: string;
      to: string;
      blindPasses: string[];
      reason: string;
    }>;
    keptAsStanding: Array<{ item: string; rule: string; standing: string }>;
  };
}
const readJson = async <T>(rel: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(HELD_OUT_DIR, rel), "utf8")) as T;

/** item → rule → label, with "does not apply" for a rule the labeller left off. */
function labelGrid(f: LabelFile): Map<string, Map<string, string>> {
  return new Map(f.items.map((i) => [i.id, new Map(i.applies.map((p) => [p.ruleId, p.verdict]))]));
}

function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number {
  const n = pairs.length;
  const cats = [...new Set(pairs.flat())];
  const observed = pairs.filter(([a, b]) => a === b).length / n;
  const chance = cats.reduce(
    (s, c) =>
      s +
      (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n),
    0,
  );
  return (observed - chance) / (1 - chance);
}

describe("the held-out governing corpus (#2024)", () => {
  it("loads under the existing loader, every guard passing, with the shape the issue asks for", async () => {
    const corpus = await loadGoverningCorpus(HELD_OUT);
    const { manifest, files } = await heldOut();
    expect(validateGoverningCorpus(manifest, files)).toEqual([]);
    expect(corpus.manifest.purpose).toBe("held-out");
    expect(corpus.rules).toHaveLength(40);
    const items = corpus.manifest.items;
    expect(items).toHaveLength(36);
    expect(items.filter((i) => i.applies.length === 0)).toHaveLength(6);
    expect(
      items.filter((i) => i.applies.some((p) => p.nonResembling)).length,
    ).toBeGreaterThanOrEqual(MIN_NON_RESEMBLING_ITEMS);
    for (const text of files.policies.values()) {
      expect(trustServicesCriteriaMarkers(text)).toEqual([]);
      expect(evaluationLeaks(text)).toEqual([]);
    }
    const v2 = manifest.policy.revisions.find((r) => r.revision === "v2")!;
    expect(v2.changedRules.length).toBeGreaterThanOrEqual(3);
    expect(v2.changedRules.length).toBeLessThanOrEqual(5);
  });

  it("carries at least four short-answer business facts", async () => {
    const { manifest } = await heldOut();
    const short = manifest.items.flatMap((i) => i.applies.filter((p) => p.baAnswer !== undefined));
    expect(short.length).toBeGreaterThanOrEqual(4);
    for (const p of short) {
      expect(p.verdict).toBe("needs-ba-input");
      expect(p.baAnswer).toMatch(/^(?:Yes|No)\b.{0,20}$/);
    }
    expect(short.map((p) => p.baAnswer)).toEqual(expect.arrayContaining(["Yes, we do.", "No."]));
  });

  it("fixed governing-01's thresholds, unchanged, before any arm ran", async () => {
    const { manifest } = await heldOut();
    const tuning = (await committed()).manifest;
    expect(manifest.thresholds).toEqual(tuning.thresholds);
    expect(manifest.thresholds.recordedBeforeAnyArmRan).toBe(true);
    expect(manifest.annotation.groundTruthFixedBeforeAnyArmRan).toBe(true);
    expect(manifest.annotation.reviewedBy).toBeNull();
    // No arm has run on it: no baseline sits in the set.
    expect(manifest.files.some((f) => f.startsWith("baseline"))).toBe(false);
  });

  it("records the content hash of what it scores against", async () => {
    const { manifest, files } = await heldOut();
    expect(manifest.contentHash).toEqual({
      algorithm: "sha256",
      covers: CONTENT_HASH_COVERS,
      value: governingContentHash(manifest, files.policies),
    });
    expect(manifest.contentHash!.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("holds the adjudicated labels: both labellers where they agreed, the third pass where they did not", async () => {
    const { manifest } = await heldOut();
    const first = labelGrid(await readJson<LabelFile>("labelling/labeller-1.json"));
    const second = labelGrid(await readJson<LabelFile>("labelling/labeller-2.json"));
    const adjudication = await readJson<AdjudicationFile>("labelling/adjudication.json");
    const decided = new Map(adjudication.disagreements.map((d) => [`${d.item} ${d.rule}`, d]));
    const consistent = new Map(
      adjudication.consistencyPass.changes.map((c) => [`${c.item} ${c.rule}`, c]),
    );
    const none = "does not apply";
    const cells: Array<readonly [string, string]> = [];
    for (const item of manifest.items) {
      const truth = new Map(item.applies.map((p) => [p.ruleId, p.verdict as string]));
      for (const rule of manifest.rules) {
        const a = first.get(item.id)?.get(rule.id) ?? none;
        const b = second.get(item.id)?.get(rule.id) ?? none;
        cells.push([a, b]);
        const d = decided.get(`${item.id} ${rule.id}`);
        const c = consistent.get(`${item.id} ${rule.id}`);
        // The label the two labellers and the adjudicator settled on...
        let standing: string;
        if (a === b) {
          expect(d, `${item.id} → ${rule.id}`).toBeUndefined();
          standing = a;
        } else {
          expect(d?.reason.trim(), `${item.id} → ${rule.id} has a written decision`).toBeTruthy();
          standing = d!.decision;
        }
        // ...then the cross-cutting consistency pass, which moves it only when both blind passes agree.
        if (c) {
          expect(c.from, `${item.id} → ${rule.id} changes from the standing label`).toBe(standing);
          expect(c.blindPasses.length).toBeGreaterThanOrEqual(2);
          expect(new Set(c.blindPasses), `${item.id} → ${rule.id}: passes agree`).toEqual(
            new Set([c.to]),
          );
          expect(c.reason.trim()).toBeTruthy();
          standing = c.to;
        }
        expect(truth.get(rule.id) ?? none, `${item.id} → ${rule.id}`).toBe(standing);
      }
    }
    expect(decided.size).toBe(cells.filter(([a, b]) => a !== b).length);
    expect(consistent.size).toBe(adjudication.consistencyPass.changes.length);
    // The agreement figures recorded beside the decisions are the labels' own.
    const applies = cells.map(([a, b]) => [String(a !== none), String(b !== none)] as const);
    expect(cohensKappa(applies)).toBeCloseTo(adjudication.agreement.applicability.kappa, 3);
    expect(cohensKappa(cells)).toBeCloseTo(adjudication.agreement.fourWay.kappa, 3);
  });

  it("applies each cross-cutting rule the same way to every requirement it fits (consistency pass)", async () => {
    const { manifest } = await heldOut();
    const adjudication = await readJson<AdjudicationFile>("labelling/adjudication.json");
    const verdict = (item: string, rule: string) =>
      manifest.items.find((i) => i.id === item)!.applies.find((p) => p.ruleId === rule)?.verdict;
    // IR-04: a change to what clinicians see or the order of steps. The two items the
    // review named (the allergy-screen skip and the interaction pop-up) now carry it.
    for (const item of ["KV-05", "KV-12", "KV-15", "KV-18", "KV-25", "KV-26", "KV-31", "KV-34"]) {
      expect(verdict(item, "IR-04"), `${item} → IR-04`).toBe("needs-ba-input");
    }
    // TP-04: a lost clinical phone is silent on encryption and wipe, so a question, not "does not apply".
    expect(verdict("KV-22", "TP-04")).toBe("needs-ba-input");
    expect(verdict("KV-11", "CM-04")).toBe("needs-ba-input");
    expect(verdict("KV-19", "CM-04")).toBe("needs-ba-input");
    // A cell the blind passes split on keeps its standing label, and the record says so.
    expect(verdict("KV-33", "IR-04")).toBeUndefined();
    expect(adjudication.consistencyPass.keptAsStanding.map((k) => `${k.item} ${k.rule}`)).toEqual(
      expect.arrayContaining(["KV-33 IR-04", "KV-32 CM-04"]),
    );
    expect(adjudication.consistencyPass.rules).toEqual(
      expect.arrayContaining(["IR-04", "TP-04", "CM-04"]),
    );
    // Every added pair carries the one business fact that settles it.
    for (const c of adjudication.consistencyPass.changes) {
      const pair = manifest.items
        .find((i) => i.id === c.item)!
        .applies.find((p) => p.ruleId === c.rule)!;
      expect(pair.businessFact?.trim(), `${c.item} → ${c.rule}`).toBeTruthy();
    }
  });

  it("records the blind procedure, both labellers, the agreement, each adjudication and the tuning rule", async () => {
    const annotation = await fs.readFile(path.join(HELD_OUT_DIR, "ANNOTATION.md"), "utf8");
    const adjudication = await readJson<AdjudicationFile>("labelling/adjudication.json");
    expect(annotation).toMatch(/did not open\s+`server\/src\/lib\/governing\/\*\*`/);
    expect(annotation).toMatch(/Labeller 1 \(the author\)/);
    expect(annotation).toMatch(/Labeller 2 labelled them blind/);
    expect(annotation).toContain(`**${adjudication.agreement.applicability.kappa.toFixed(2)}**`);
    for (const d of adjudication.disagreements) {
      expect(annotation).toContain(`| ${d.item} → ${d.rule} |`);
    }
    expect(annotation).toMatch(/consistency pass/i);
    for (const c of adjudication.consistencyPass.changes) {
      expect(annotation).toContain(`| ${c.item} → ${c.rule} |`);
    }
    expect(annotation).toMatch(/No arm has run on this set/);
    expect(annotation).toMatch(/never iterate a prompt against this set/i);
    expect(annotation).toMatch(/## Readings/);
  });
});

describe("the sets' purposes and the content hash (#2024)", () => {
  it("marks governing-01 as the tuning set, which needs no hash", async () => {
    const { manifest, files } = await committed();
    expect(manifest.purpose).toBe("tuning");
    expect(manifest.contentHash).toBeUndefined();
    expect(validateGoverningCorpus(manifest, files)).toEqual([]);
  });

  it("FAILS on a held-out set whose items, rules or policy changed after the hash was recorded", async () => {
    const { manifest, files } = await heldOut();
    const edited = clone(manifest);
    edited.items[0]!.applies[0]!.verdict = "gap";
    expect(validateGoverningCorpus(edited, files).join("\n")).toMatch(
      /content hash: the policy, rules or items no longer match the recorded hash/,
    );
    const summary = clone(manifest);
    summary.rules[0]!.summary = `${summary.rules[0]!.summary} Always.`;
    expect(validateGoverningCorpus(summary, files).join("\n")).toMatch(/content hash/);
    const policies = new Map(files.policies);
    policies.set("v2", `${policies.get("v2")}\nA new closing line.\n`);
    expect(validateGoverningCorpus(manifest, { ...files, policies }).join("\n")).toMatch(
      /content hash/,
    );
  });

  it("hashes a CRLF checkout the same, and leaves the annotation and thresholds outside the hash", async () => {
    const { manifest, files } = await heldOut();
    const crlf = new Map([...files.policies].map(([k, v]) => [k, v.replace(/\n/g, "\r\n")]));
    expect(governingContentHash(manifest, crlf)).toBe(manifest.contentHash!.value);
    const reviewed = clone(manifest);
    reviewed.annotation.reviewedBy = "a person";
    expect(governingContentHash(reviewed, files.policies)).toBe(manifest.contentHash!.value);
  });

  it("FAILS on a re-hash that did not also record the new hash in ANNOTATION.md", async () => {
    const { manifest, files } = await heldOut();
    // The annotation records the hash the manifest holds.
    expect(files.annotation).toContain(manifest.contentHash!.value);
    // Pasting the hash the error message prints, without touching ANNOTATION.md, is refused.
    const edited = clone(manifest);
    edited.items[0]!.title = `${edited.items[0]!.title} (reworded)`;
    edited.contentHash!.value = governingContentHash(edited, files.policies);
    expect(validateGoverningCorpus(edited, files).join("\n")).toMatch(
      /content hash: ANNOTATION\.md does not record the hash/,
    );
    // Recording it there too lets the re-hash through.
    const recorded = {
      ...files,
      annotation: `${files.annotation}\n${edited.contentHash!.value}\n`,
    };
    expect(validateGoverningCorpus(edited, recorded)).toEqual([]);
    // A held-out set whose annotation was not supplied cannot pass either.
    const noAnnotation = { present: files.present, policies: files.policies };
    expect(validateGoverningCorpus(manifest, noAnnotation).join("\n")).toMatch(
      /ANNOTATION\.md does not record the hash/,
    );
  });

  it("refuses to write a baseline into a held-out set, and allows it for the tuning set", async () => {
    expect(() => assertBaselineAllowed("held-out", "governing-02-clinic-records")).toThrow(
      /held-out.*never gets a baseline/s,
    );
    expect(() => assertBaselineAllowed("tuning", "governing-01-sample-policy")).not.toThrow();
  });

  it("FAILS on a held-out set with no hash or an unknown algorithm, and on an unknown purpose", async () => {
    const { manifest, files } = await heldOut();
    const bare = clone(manifest);
    delete bare.contentHash;
    expect(validateGoverningCorpus(bare, files)).toEqual([
      "a held-out set must record its content hash",
    ]);
    const md5 = clone(manifest);
    (md5.contentHash as { algorithm: string }).algorithm = "md5";
    expect(validateGoverningCorpus(md5, files)).toEqual(['content hash: unknown algorithm "md5"']);
    const odd = clone(manifest);
    (odd as { purpose: string }).purpose = "scratch";
    expect(validateGoverningCorpus(odd, files)).toContain(
      'purpose "scratch" is not one of tuning, held-out',
    );
  });

  it("FAILS on a BA answer on a pair that is not needs-ba-input, or an empty one", async () => {
    const { manifest, files } = await committed();
    const m = clone(manifest);
    const gap = m.items.flatMap((i) => i.applies).find((p) => p.verdict === "gap")!;
    gap.baAnswer = "Yes, we do.";
    const ask = m.items.flatMap((i) => i.applies).find((p) => p.verdict === "needs-ba-input")!;
    ask.baAnswer = "  ";
    const problems = validateGoverningCorpus(m, files);
    expect(problems.some((p) => p.endsWith(`${gap.ruleId}: a BA answer on a gap pair`))).toBe(true);
    expect(problems.some((p) => p.endsWith(`${ask.ruleId}: an empty BA answer`))).toBe(true);
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

describe("short-answer pairs and the verdict their answer leads to (#2033)", () => {
  const answered = (c: { manifest: GoverningCorpusManifest }) =>
    Object.fromEntries(
      c.manifest.items.flatMap((i) =>
        shortAnswerPairs(i).map((p) => [
          `${i.id} → ${p.ruleId}`,
          `${p.answer} ${p.answeredVerdict}`,
        ]),
      ),
    );

  it("records answeredVerdict on every short-answer pair of the held-out set: Yes meets, No breaches", async () => {
    // governing-02's business facts all ask whether the rule is met.
    expect(answered(await loadGoverningCorpus(HELD_OUT))).toEqual({
      "KV-02 → TP-01": "Yes, we do. compliant",
      "KV-05 → MS-04": "No. gap",
      "KV-14 → CM-01": "Yes, they are. compliant",
      "KV-26 → TP-03": "Yes, we do. compliant",
      "KV-28 → TP-05": "No. gap",
      "KV-31 → IR-04": "Yes, we do. compliant",
      "KV-33 → CM-04": "No. gap",
    });
  });

  it("gives the tuning set short-answer pairs too, with the polarity case: on GR-11, No meets the rule", async () => {
    const g01 = answered(await loadGoverningCorpus(NAME));
    expect(Object.keys(g01)).toHaveLength(7);
    expect(g01["GR-11 → DR-06"]).toBe("No. compliant");
    expect(g01["GR-08 → PR-05"]).toBe("No. gap");
    expect(g01["GR-21 → CM-03"]).toBe("Yes, there is. compliant");
  });

  it("shortAnswerPairs gives the business fact as the question and the BA answer, and nothing else", () => {
    expect(
      shortAnswerPairs({
        applies: [
          { ruleId: "AA-01", verdict: "gap" },
          { ruleId: "AA-02", verdict: "needs-ba-input", businessFact: "Q?" },
          {
            ruleId: "AA-03",
            verdict: "needs-ba-input",
            businessFact: "Is it logged?",
            baAnswer: "No.",
            answeredVerdict: "gap",
          },
        ],
      }),
    ).toEqual([
      { ruleId: "AA-03", question: "Is it logged?", answer: "No.", answeredVerdict: "gap" },
    ]);
  });

  it("FAILS on a BA answer without answeredVerdict, an answeredVerdict without an answer, or an unknown one", async () => {
    const { manifest, files } = await committed();
    expect(validateGoverningCorpus(manifest, files)).toEqual([]);
    const m = clone(manifest);
    const asks = m.items.flatMap((i) => i.applies).filter((p) => p.verdict === "needs-ba-input");
    const short = asks.filter((p) => p.baAnswer !== undefined);
    delete short[0]!.answeredVerdict;
    (short[1] as { answeredVerdict: string }).answeredVerdict = "maybe";
    const unanswered = asks.find((p) => p.baAnswer === undefined)!;
    unanswered.answeredVerdict = "gap";
    const problems = validateGoverningCorpus(m, files);
    // In item order: GR-01's unanswered pair, then GR-06's and GR-08's answered ones.
    expect(problems).toEqual([
      `item GR-01 → ${unanswered.ruleId}: an answeredVerdict without the BA answer it follows from`,
      `item GR-06 → ${short[0]!.ruleId}: a BA answer without the verdict it leads to (answeredVerdict)`,
      `item GR-08 → ${short[1]!.ruleId}: unknown answeredVerdict "maybe"`,
    ]);
  });
});
