/**
 * #1823 — the table guard's repository and how its citations reach the
 * hand-authored fixture.
 */
import { describe, expect, it } from "vitest";
import type { StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import { loadImpactRecallFixture, resolveCorpusDir } from "../impact-recall/fixture.js";
import {
  FIXTURE_ONLY_FILES,
  TABLE_GUARD_CORPUS,
  TABLE_GUARD_REPO,
  emptyTranslation,
  isWidenedCitation,
  requiredRepoFiles,
  toFixturePath,
  toFixtureQualifiedName,
  toRepoPath,
  translateCitations,
  type CitationTrace,
} from "./table-guard-source.js";

const fixture = await loadImpactRecallFixture(resolveCorpusDir(TABLE_GUARD_CORPUS));
const JAVA = "src/main/java/org/mybatis/jpetstore";
const XML = "src/main/resources/org/mybatis/jpetstore/mapper";

describe("the table guard's repository (#1823)", () => {
  it("is pinned to a full commit of the last release with the Stripes action beans", () => {
    expect(TABLE_GUARD_REPO.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(TABLE_GUARD_REPO.ref).toBe("jpetstore-6.3.0");
    expect(TABLE_GUARD_REPO.url).toBe("https://github.com/mybatis/jpetstore-6");
  });

  it("maps repository paths onto the fixture's, the mapper package as persistence", () => {
    expect(toFixturePath(`${JAVA}/domain/Account.java`)).toBe("domain/Account.java");
    expect(toFixturePath(`${JAVA}/mapper/OrderMapper.java`)).toBe("persistence/OrderMapper.java");
    expect(toFixturePath(`${XML}/OrderMapper.xml`)).toBe("persistence/OrderMapper.xml");
    expect(toFixturePath(`${JAVA}/web/actions/CartActionBean.java`)).toBe(
      "web/actions/CartActionBean.java",
    );
    expect(toFixturePath("src/site/xdoc/index.xml")).toBe("src/site/xdoc/index.xml");
    expect(toFixturePath("src/main/webapp/WEB-INF/jsp/cart/Cart.jsp")).toBeNull();
    expect(toFixturePath("pom.xml")).toBeNull();
  });

  it("maps every fixture file back to the repository path it came from, and the beans to none", () => {
    for (const s of fixture.manifest.codeSymbols) {
      const repoPath = toRepoPath(s.filePath);
      if (s.filePath.startsWith("web/beans/")) {
        expect(repoPath).toBeNull();
        continue;
      }
      expect(repoPath).not.toBeNull();
      expect(toFixturePath(repoPath!)).toBe(s.filePath);
    }
  });

  it("requires every fixture file the repository has, and none it lacks", () => {
    const required = requiredRepoFiles(fixture);
    expect(required).toContain(`jpetstore:${XML}/OrderMapper.xml`);
    expect(required).toContain(`jpetstore:${JAVA}/web/actions/OrderActionBean.java`);
    expect(required).toContain("jpetstore:src/site/xdoc/index.xml");
    expect(required.some((f) => f.includes("Inventory") || f.includes("Signon"))).toBe(false);
    expect(required.some((f) => f.includes("web/beans"))).toBe(false);
    expect(required).toEqual([...new Set(required)].sort());
    for (const f of FIXTURE_ONLY_FILES) {
      expect(fixture.manifest.codeSymbols.some((s) => s.filePath === f)).toBe(true);
    }
  });

  it("writes a code symbol's and a MyBatis statement's name as the fixture does", () => {
    expect(
      toFixtureQualifiedName(`${JAVA}/mapper/AccountMapper.java::AccountMapper::updateAccount`),
    ).toBe("persistence/AccountMapper.java::AccountMapper::updateAccount");
    expect(toFixtureQualifiedName("org.mybatis.jpetstore.mapper.OrderMapper.insertOrder")).toBe(
      "org.jpetstore.persistence.OrderMapper.insertOrder.statement",
    );
    expect(toFixtureQualifiedName("account")).toBeNull();
    expect(toFixtureQualifiedName("pom.xml::project")).toBeNull();
  });
});

describe("translateCitations (#1823)", () => {
  const link = (
    filePath: string,
    codeSymbolId: string | null,
    confidence = 0.9,
  ): StoredLinkRow => ({
    codeSymbolId,
    filePath,
    startLine: 40,
    endLine: 52,
    confidence,
    source: "analysis-grounding",
  });
  const names = new Map([
    ["r-update", `${JAVA}/mapper/AccountMapper.java::AccountMapper::updateAccount`],
    ["r-lineitem", `${JAVA}/mapper/LineItemMapper.java::LineItemMapper::insertLineItem`],
    ["r-stmt", "org.mybatis.jpetstore.mapper.OrderMapper.insertOrder"],
    ["r-lineitem-stmt", "org.mybatis.jpetstore.mapper.LineItemMapper.insertLineItem"],
    ["r-profile", `${JAVA}/mapper/AccountMapper.java::AccountMapper::updateProfile`],
    ["r-abstract", `${JAVA}/web/actions/AbstractActionBean.java::AbstractActionBean`],
  ]);
  const idOf = (qualifiedName: string) =>
    fixture.manifest.codeSymbols.find((s) => s.qualifiedName === qualifiedName)!.id;

  it("reads each citation as its symbol, a same-named one in its layer, its file, or drops it", () => {
    const counts = emptyTranslation();
    const out = translateCitations(
      [
        link(`${JAVA}/mapper/AccountMapper.java`, "r-update", 0.95),
        link(`${JAVA}/mapper/LineItemMapper.java`, "r-lineitem"),
        link(`${XML}/OrderMapper.xml`, "r-stmt"),
        link(`${XML}/LineItemMapper.xml`, "r-lineitem-stmt"),
        link(`${JAVA}/mapper/AccountMapper.java`, "r-profile", 0.5),
        link(`${JAVA}/domain/Order.java`, null),
        link(`${JAVA}/web/actions/AbstractActionBean.java`, "r-abstract"),
        link("src/main/webapp/WEB-INF/jsp/cart/Cart.jsp", null),
      ],
      names,
      fixture,
      counts,
    );
    expect(counts).toEqual({ symbol: 2, member: 2, file: 2, dropped: 2 });
    expect(out.map((l) => [l.filePath, l.codeSymbolId, l.confidence])).toEqual([
      [
        "persistence/AccountMapper.java",
        idOf("persistence/AccountMapper.java::AccountMapper::updateAccount"),
        0.95,
      ],
      [
        "persistence/OrderMapper.java",
        idOf("persistence/OrderMapper.java::OrderMapper::insertLineItem"),
        0.9,
      ],
      [
        "persistence/OrderMapper.xml",
        idOf("org.jpetstore.persistence.OrderMapper.insertOrder.statement"),
        0.9,
      ],
      [
        "persistence/OrderMapper.xml",
        idOf("org.jpetstore.persistence.OrderMapper.insertLineItem.statement"),
        0.9,
      ],
      ["persistence/AccountMapper.java", null, 0.5],
      ["domain/Order.java", null, 0.9],
    ]);
    // The fixture's lines are not the repository's: none is carried over.
    expect(out.every((l) => l.startLine === null && l.endLine === null)).toBe(true);
    expect(out.every((l) => l.source === "analysis-grounding")).toBe(true);
  });

  it("reads a cited symbol the graph cannot name as its file", () => {
    const counts = emptyTranslation();
    const out = translateCitations(
      [link(`${JAVA}/mapper/AccountMapper.java`, "unknown-id")],
      names,
      fixture,
      counts,
    );
    expect(counts).toEqual({ symbol: 0, member: 0, file: 1, dropped: 0 });
    expect(out[0]).toMatchObject({
      filePath: "persistence/AccountMapper.java",
      codeSymbolId: null,
    });
  });

  it("reads a name two files of the layer share as the cited file, not a guess", () => {
    const sym = (filePath: string, qualifiedName: string) => ({
      id: qualifiedName,
      name: qualifiedName.split("::").pop()!,
      qualifiedName,
      kind: "method",
      filePath,
      language: "java",
      inCorpus: true,
    });
    const twoOwners = {
      manifest: {
        ...fixture.manifest,
        codeSymbols: [
          sym(
            "persistence/AccountMapper.java",
            "persistence/AccountMapper.java::AccountMapper::touch",
          ),
          sym("persistence/OrderMapper.java", "persistence/OrderMapper.java::OrderMapper::touch"),
        ],
      },
    };
    const counts = emptyTranslation();
    const out = translateCitations(
      [link(`${JAVA}/mapper/AccountMapper.java`, "r-touch")],
      new Map([["r-touch", `${JAVA}/mapper/LineItemMapper.java::LineItemMapper::touch`]]),
      twoOwners,
      counts,
    );
    expect(counts).toEqual({ symbol: 0, member: 0, file: 1, dropped: 0 });
    expect(out[0]).toMatchObject({
      filePath: "persistence/AccountMapper.java",
      codeSymbolId: null,
    });
  });

  it("never moves a citation of a file the fixture holds to another file by name (#1847)", () => {
    const sym = (filePath: string, qualifiedName: string) => ({
      id: qualifiedName,
      name: qualifiedName.split("::").pop()!,
      qualifiedName,
      kind: "method",
      filePath,
      language: "java",
      inCorpus: true,
    });
    // The cited file is in the fixture, without the cited method; one other
    // file of the layer has a method of that name, on other tables.
    const oneOwner = {
      manifest: {
        ...fixture.manifest,
        codeSymbols: [
          sym(
            "persistence/AccountMapper.java",
            "persistence/AccountMapper.java::AccountMapper::getAccount",
          ),
          sym("persistence/OrderMapper.java", "persistence/OrderMapper.java::OrderMapper::touch"),
        ],
      },
    };
    const counts = emptyTranslation();
    const out = translateCitations(
      [link(`${JAVA}/mapper/AccountMapper.java`, "r-touch")],
      new Map([["r-touch", `${JAVA}/mapper/AccountMapper.java::AccountMapper::touch`]]),
      oneOwner,
      counts,
    );
    expect(counts).toEqual({ symbol: 0, member: 0, file: 1, dropped: 0 });
    expect(out[0]).toMatchObject({
      filePath: "persistence/AccountMapper.java",
      codeSymbolId: null,
    });
  });

  it("#1909 — traces each citation: what it named, how it was read and what it seeds", () => {
    const traces: CitationTrace[] = [];
    translateCitations(
      [
        link(`${JAVA}/mapper/AccountMapper.java`, "r-update", 0.95),
        link(`${JAVA}/mapper/LineItemMapper.java`, "r-lineitem"),
        link(`${JAVA}/mapper/AccountMapper.java`, "r-profile", 0.5),
        link(`${JAVA}/domain/Order.java`, null),
        link(`${JAVA}/mapper/AccountMapper.java`, "unknown-id"),
        link("src/main/webapp/WEB-INF/jsp/cart/Cart.jsp", null),
      ],
      names,
      fixture,
      emptyTranslation(),
      traces,
    );
    expect(traces).toEqual([
      {
        filePath: `${JAVA}/mapper/AccountMapper.java`,
        cited: "symbol",
        symbol: `${JAVA}/mapper/AccountMapper.java::AccountMapper::updateAccount`,
        outcome: "symbol",
        seeds: "persistence/AccountMapper.java::AccountMapper::updateAccount",
        confidence: 0.95,
      },
      {
        filePath: `${JAVA}/mapper/LineItemMapper.java`,
        cited: "symbol",
        symbol: `${JAVA}/mapper/LineItemMapper.java::LineItemMapper::insertLineItem`,
        outcome: "member",
        seeds: "persistence/OrderMapper.java::OrderMapper::insertLineItem",
        confidence: 0.9,
      },
      // The repository's updateProfile, which the fixture does not model: widened to its file.
      {
        filePath: `${JAVA}/mapper/AccountMapper.java`,
        cited: "symbol",
        symbol: `${JAVA}/mapper/AccountMapper.java::AccountMapper::updateProfile`,
        outcome: "file",
        seeds: "persistence/AccountMapper.java",
        confidence: 0.5,
      },
      {
        filePath: `${JAVA}/domain/Order.java`,
        cited: "file",
        symbol: null,
        outcome: "file",
        seeds: "domain/Order.java",
        confidence: 0.9,
      },
      {
        filePath: `${JAVA}/mapper/AccountMapper.java`,
        cited: "symbol",
        symbol: null,
        outcome: "file",
        seeds: "persistence/AccountMapper.java",
        confidence: 0.9,
      },
      {
        filePath: "src/main/webapp/WEB-INF/jsp/cart/Cart.jsp",
        cited: "file",
        symbol: null,
        outcome: "dropped",
        seeds: null,
        confidence: 0.9,
      },
    ]);
    expect(traces.map(isWidenedCitation)).toEqual([false, false, true, false, true, false]);
  });

  it("adds to the counts it is given", () => {
    const counts = { symbol: 1, member: 0, file: 0, dropped: 3 };
    translateCitations(
      [link(`${JAVA}/mapper/AccountMapper.java`, "r-update")],
      names,
      fixture,
      counts,
    );
    expect(counts).toEqual({ symbol: 2, member: 0, file: 0, dropped: 3 });
  });
});
