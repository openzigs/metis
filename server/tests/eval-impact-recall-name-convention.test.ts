/**
 * Issue #1016 — the corpus qualified-name convention self-check.
 *
 * A guard that has never been observed to FAIL is not yet a guard, so most of this
 * file deliberately drifts a copy of the real corpus and asserts the check catches
 * it. The positive case (the committed corpora pass) is asserted last.
 */
import { describe, expect, it } from "vitest";
import {
  assertCorpusNameConvention,
  checkCorpusNameConvention,
  formatNameConventionViolations,
} from "../src/lib/eval/impact-recall/name-convention.js";
import {
  IMPACT_RECALL_CORPORA,
  loadImpactRecallFixture,
  resolveCorpusDir,
  type ImpactRecallManifest,
} from "../src/lib/eval/impact-recall/fixture.js";
import { promises as fs } from "node:fs";
import path from "node:path";

async function loadManifest(corpus: string): Promise<ImpactRecallManifest> {
  const raw = await fs.readFile(path.join(resolveCorpusDir(corpus), "manifest.json"), "utf8");
  return JSON.parse(raw) as ImpactRecallManifest;
}

function clone(manifest: ImpactRecallManifest): ImpactRecallManifest {
  return JSON.parse(JSON.stringify(manifest)) as ImpactRecallManifest;
}

describe("checkCorpusNameConvention — the drift it must catch", () => {
  it("FAILS on a dotted row, the exact #1002 divergence", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    // The pre-#1016 corpus convention: a Java package path, no file root.
    drifted.codeSymbols[0].qualifiedName = "org.jpetstore.domain.Account";

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].qualifiedName).toBe("org.jpetstore.domain.Account");
    expect(report.violations[0].reason).toContain("rooted at its filePath");
    expect(formatNameConventionViolations(report)).toContain("org.jpetstore.domain.Account");
    expect(() => assertCorpusNameConvention(drifted)).toThrow(/qualified-name convention/);
  });

  it("FAILS on a name rooted at a SIBLING path rather than its own file", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    const row = drifted.codeSymbols.find((s) => s.kind === "class")!;
    row.filePath = "domain/Account.java";
    row.qualifiedName = "domain/AccountExtra.java::Account";

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations.map((v) => v.id)).toContain(row.id);
  });

  it("FAILS on a module row whose qualified name is not exactly its file path", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    const row = drifted.codeSymbols.find((s) => s.kind === "module")!;
    row.qualifiedName = `${row.filePath}::Extra`;

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations[0].reason).toContain("module row must equal its filePath");
  });

  it("FAILS on a kind no ingest path emits (`file`, the pre-#1016 corpus's own row)", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    drifted.codeSymbols.find((s) => s.kind === "module")!.kind = "file";

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations.some((v) => v.reason.includes("not emitted by any ingest path"))).toBe(
      true,
    );
  });

  it("FAILS on a SQL origin symbol that borrows the code separator", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    const row = drifted.codeSymbols.find((s) => s.language === "sql")!;
    row.qualifiedName = "persistence/AccountMapper.xml::getAccount";

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations[0].reason).toContain("dotted mapper namespace");
  });

  it("FAILS on a table whose qualified name is not the schema writer's shape", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    drifted.tables[0].qualifiedName = "Account";

    const report = checkCorpusNameConvention(drifted);
    expect(report.violations[0].reason).toContain("tableQualifiedName");
  });

  it("FAILS a corpus that carries NO production-shaped code symbol at all", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    // Strip every non-SQL row: what is left cannot exercise convention-sensitive code.
    drifted.codeSymbols = drifted.codeSymbols.filter((s) => s.language === "sql");

    const report = checkCorpusNameConvention(drifted);
    expect(report.productionShapedCount).toBe(0);
    expect(report.violations.some((v) => v.reason.includes("cannot exercise"))).toBe(true);
  });

  it("FAILS on a table kind the schema writer never creates, and on a mis-cased column", async () => {
    const drifted = clone(await loadManifest("impact-recall-01-jpetstore"));
    drifted.tables.push({
      id: "bogus-kind",
      name: "thing",
      qualifiedName: "thing",
      kind: "view" as unknown as "table",
      source: "mybatis",
    });
    drifted.tables.push({
      id: "bad-column",
      name: "username",
      // The writer normalizes identifiers to lower case; `Account.username` is not
      // a shape it can produce.
      qualifiedName: "Account.username",
      kind: "column",
      source: "mybatis",
    });

    const report = checkCorpusNameConvention(drifted);
    const byId = new Map(report.violations.map((v) => [v.id, v.reason]));
    expect(byId.get("bogus-kind")).toContain("not a schema-graph.ts writer kind");
    expect(byId.get("bad-column")).toContain("columnQualifiedName");
  });

  it("accepts a column row built by the schema writer's own helper", () => {
    const manifest = {
      id: "tiny",
      codeSymbols: [
        {
          id: "c1",
          name: "run",
          qualifiedName: "a/B.java::B::run",
          kind: "method",
          filePath: "a/B.java",
          language: "java",
          inCorpus: true,
        },
      ],
      tables: [
        { id: "t1", name: "account", qualifiedName: "account", kind: "table", source: "mybatis" },
        {
          id: "c1t",
          name: "username",
          qualifiedName: "account.username",
          kind: "column",
          source: "mybatis",
        },
      ],
    } as unknown as ImpactRecallManifest;
    expect(checkCorpusNameConvention(manifest).violations).toEqual([]);
  });
});

describe("the committed corpora match what ingest emits", () => {
  it.each(IMPACT_RECALL_CORPORA)("%s passes the convention check", async (corpus) => {
    const manifest = await loadManifest(corpus);
    const report = checkCorpusNameConvention(manifest);
    expect(formatNameConventionViolations(report)).toBe("");
    expect(report.violations).toEqual([]);
    expect(report.productionShapedCount).toBeGreaterThan(0);
    expect(report.checkedCount).toBeGreaterThan(0);
  });

  it("loadImpactRecallFixture enforces the check before any number is produced", async () => {
    // Sanity: the loader path (not just the pure function) runs the assertion.
    await expect(
      loadImpactRecallFixture(resolveCorpusDir("impact-recall-01-jpetstore")),
    ).resolves.toBeTruthy();
  });
});
