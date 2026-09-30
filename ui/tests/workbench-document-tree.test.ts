/**
 * Issue #32 — the Workbench Documents panel model: uploads grouped apart from
 * repository files, repository files as a folder tree, filter on name/path,
 * and no internal id fragment in any label.
 */
import { describe, expect, it } from "vitest";
import type { DocumentRow } from "@/lib/projects-api";
import {
  UNNAMED_DATABASE,
  UNNAMED_REPOSITORY,
  filterEntries,
  groupEntries,
  toPanelEntries,
} from "@/lib/workbench-document-tree";

const CONN = "cmexample0000000000acmerp";
const OTHER = "cmexample0000000000zzzzzz";

function doc(id: string, filename: string, uploadedAt = "2026-09-01T10:00:00Z"): DocumentRow {
  return {
    id,
    projectId: "p1",
    filename,
    mimeType: "text/plain",
    sizeBytes: 1,
    status: "ready",
    chunkCount: 1,
    uploadedAt,
  };
}

const repo = (id: string, path: string, conn = CONN) => doc(id, `connector:repo:${conn}:${path}`);

describe("toPanelEntries", () => {
  it("names a repository file by its basename, with repo name and path on hover", () => {
    const [e] = toPanelEntries([repo("r1", "src/lib/a.ts")], { [CONN]: "wms-core" });
    expect(e).toMatchObject({
      kind: "repo",
      name: "a.ts",
      path: "src/lib/a.ts",
      repoName: "wms-core",
      connectorId: CONN,
      title: "wms-core/src/lib/a.ts",
    });
  });

  it("never falls back to a connector id fragment for an unknown repository", () => {
    const [e] = toPanelEntries([repo("r1", "README.md")], {});
    expect(e.repoName).toBe(UNNAMED_REPOSITORY);
    expect(JSON.stringify([e.name, e.title, e.repoName])).not.toContain("acmerp");
  });

  it("does not resolve a repository name inherited from Object.prototype", () => {
    const [e] = toPanelEntries([repo("r1", "a.md", "constructor")], {});
    expect(e.repoName).toBe(UNNAMED_REPOSITORY);
  });

  it("keeps an uploaded document's own name", () => {
    const [e] = toPanelEntries([doc("u1", "Spec v2.docx")]);
    expect(e).toMatchObject({ kind: "upload", name: "Spec v2.docx", title: "Spec v2.docx" });
    expect(e.secondary).toBeUndefined();
  });

  it("tells generated documents apart by date, not by a cuid fragment", () => {
    const [e] = toPanelEntries([doc("g1", "generated-doc-cmqpizckr017z8ewh2unm1418.md")]);
    expect(e.name).toBe("Generated document");
    expect(e.secondary).toBe(new Date("2026-09-01T10:00:00Z").toLocaleDateString());
    expect(`${e.name} ${e.secondary} ${e.title}`).not.toContain("m1418");
  });

  it("omits the date line when a generated document's date is unreadable", () => {
    const [e] = toPanelEntries([doc("g1", "generated-doc-abc123.md", "not a date")]);
    expect(e.secondary).toBeUndefined();
  });
});

describe("filterEntries", () => {
  const entries = toPanelEntries([
    doc("u1", "Requirements.docx"),
    repo("r1", "src/Billing/Invoice.ts"),
    repo("r2", "tests/invoice.spec.ts"),
    repo("r3", "docs/README.md"),
  ]);

  it("keeps everything for a blank query", () => {
    expect(filterEntries(entries, "   ")).toHaveLength(4);
  });

  it("matches a name case-insensitively", () => {
    expect(filterEntries(entries, "INVOICE").map((e) => e.doc.id)).toEqual(["r1", "r2"]);
  });

  it("matches a directory in the path", () => {
    expect(filterEntries(entries, "billing/").map((e) => e.doc.id)).toEqual(["r1"]);
  });

  it("matches an upload by name", () => {
    expect(filterEntries(entries, "requirements").map((e) => e.doc.id)).toEqual(["u1"]);
  });

  it("does not match on the internal connector key", () => {
    expect(filterEntries(entries, "connector:repo")).toEqual([]);
    expect(filterEntries(entries, "acmerp")).toEqual([]);
  });
});

describe("groupEntries", () => {
  it("puts uploads in their own group and repository files in a tree per repository", () => {
    const groups = groupEntries(
      toPanelEntries(
        [
          repo("r1", "src/lib/b.ts"),
          doc("u1", "Notes.md"),
          repo("r2", "src/lib/a.ts"),
          repo("r3", "src/index.ts"),
          repo("r4", "README.md"),
          repo("o1", "main.go", OTHER),
        ],
        { [CONN]: "wms-core", [OTHER]: "api-gateway" },
      ),
    );
    expect(groups.uploads.map((e) => e.doc.id)).toEqual(["u1"]);
    // Repositories sorted by name.
    expect(groups.repos.map((r) => r.name)).toEqual(["api-gateway", "wms-core"]);

    const wms = groups.repos[1];
    expect(wms.fileCount).toBe(4);
    expect(wms.files.map((f) => f.name)).toEqual(["README.md"]);
    expect(wms.folders.map((f) => f.name)).toEqual(["src"]);
    const src = wms.folders[0];
    expect(src.fileCount).toBe(3);
    expect(src.files.map((f) => f.name)).toEqual(["index.ts"]);
    const lib = src.folders[0];
    expect(lib.name).toBe("lib");
    expect(lib.fileCount).toBe(2);
    // Files sorted by name within a folder.
    expect(lib.files.map((f) => f.doc.id)).toEqual(["r2", "r1"]);
  });

  it("keeps two repositories' same-named folders apart", () => {
    const groups = groupEntries(
      toPanelEntries([repo("a", "src/x.ts"), repo("b", "src/y.ts", OTHER)], {
        [CONN]: "one",
        [OTHER]: "two",
      }),
    );
    const keys = groups.repos.map((r) => r.folders[0].key);
    expect(new Set(keys).size).toBe(2);
    expect(groups.repos.map((r) => r.folders[0].files.length)).toEqual([1, 1]);
  });

  it("groups 5,000 files into a tree whose top level stays small", () => {
    const docs = Array.from({ length: 5000 }, (_, i) =>
      repo(`r${i}`, `pkg${i % 10}/sub${i % 7}/file${i}.ts`),
    );
    const groups = groupEntries(toPanelEntries(docs, { [CONN]: "big" }));
    expect(groups.repos).toHaveLength(1);
    expect(groups.repos[0].fileCount).toBe(5000);
    expect(groups.repos[0].folders).toHaveLength(10);
    expect(groups.repos[0].folders.reduce((n, f) => n + f.fileCount, 0)).toBe(5000);
  });
});

// Review of PR #436 — the server writes three more filename shapes than
// `connector:repo:` (connector-ingest.ts, atlassian.ts). None was uploaded, and
// the database one carries the connector's cuid.
describe("documents from other connectors", () => {
  const DB = "cmexampledbconn0000dbzz99";
  const others = [
    doc("d0", `connector:db:${DB}:OVERVIEW.md`),
    doc("d1", `connector:db:${DB}:public.orders.md`),
    doc("c1", "confluence:ENG:123456"),
    doc("j1", "jira:WMS-42"),
    doc("u1", "Spec.docx"),
  ];

  it("keeps them out of the Uploaded group, each under its own source", () => {
    const groups = groupEntries(toPanelEntries(others));
    expect(groups.uploads.map((e) => e.doc.id)).toEqual(["u1"]);
    expect(groups.repos).toEqual([]);
    expect(groups.sources.map((s) => s.name)).toEqual(["Confluence ENG", UNNAMED_DATABASE, "Jira"]);
    const db = groups.sources[1];
    expect(db.fileCount).toBe(2);
    expect(db.files.map((f) => f.name)).toEqual(["Overview", "public.orders"]);
    expect(groups.sources[0].files.map((f) => f.name)).toEqual(["Page 123456"]);
    expect(groups.sources[2].files.map((f) => f.name)).toEqual(["WMS-42"]);
  });

  it("never shows the database connector's id in a label or matches it in the filter", () => {
    const entries = toPanelEntries(others);
    const labels = entries.flatMap((e) => [e.name, e.title, e.repoName ?? "", e.secondary ?? ""]);
    expect(labels.join(" ")).not.toMatch(/dbzz99|connector:db|confluence:|jira:/);
    expect(filterEntries(entries, "dbzz99")).toEqual([]);
    expect(filterEntries(entries, "orders").map((e) => e.doc.id)).toEqual(["d1"]);
    expect(filterEntries(entries, "jira").map((e) => e.doc.id)).toEqual(["j1"]);
  });

  it("names a database by its connector name when one is known", () => {
    const groups = groupEntries(toPanelEntries(others.slice(0, 2), { [DB]: "warehouse-db" }));
    expect(groups.sources.map((s) => s.name)).toEqual(["warehouse-db"]);
  });
});

describe("unknown connectors", () => {
  it("numbers two unnamed repositories so they can be told apart, without an id", () => {
    const groups = groupEntries(toPanelEntries([repo("a", "x.ts"), repo("b", "y.ts", OTHER)], {}));
    expect(groups.repos.map((r) => r.name)).toEqual([
      UNNAMED_REPOSITORY,
      `${UNNAMED_REPOSITORY} 2`,
    ]);
    // Stable: ordinal follows the connector id, not the listing order.
    const again = groupEntries(toPanelEntries([repo("b", "y.ts", OTHER), repo("a", "x.ts")], {}));
    expect(again.repos.map((r) => [r.connectorId, r.name])).toEqual([
      [CONN, UNNAMED_REPOSITORY],
      [OTHER, `${UNNAMED_REPOSITORY} 2`],
    ]);
  });
});
