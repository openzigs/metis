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
  entryLabel,
  filterEntries,
  groupEntries,
  toPanelEntries,
} from "@/lib/workbench-document-tree";

const CONN = "cmexample0000000000acmerp";
const OTHER = "cmexample0000000000zzzzzz";

function doc(id: string, filename: string, over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id,
    projectId: "p1",
    filename,
    source: "upload",
    mimeType: "text/plain",
    sizeBytes: 1,
    status: "ready",
    chunkCount: 1,
    uploadedAt: "2026-09-01T10:00:00Z",
    ...over,
  };
}

/** A row as its connector writes it: the filename pattern AND the stored source (#474). */
const from = (source: DocumentRow["source"], id: string, filename: string, title?: string) =>
  doc(id, filename, { source, ...(title !== undefined ? { title } : {}) });
const repo = (id: string, path: string, conn = CONN) =>
  from("repo", id, `connector:repo:${conn}:${path}`);

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
    const [e] = toPanelEntries([
      from("generated", "g1", "generated-doc-cmqpizckr017z8ewh2unm1418.md"),
    ]);
    expect(e.name).toBe("Generated document");
    expect(e.secondary).toBe(new Date("2026-09-01T10:00:00Z").toLocaleDateString());
    expect(`${e.name} ${e.secondary} ${e.title}`).not.toContain("m1418");
  });

  it("omits the date line when a generated document's date is unreadable", () => {
    const [e] = toPanelEntries([
      doc("g1", "generated-doc-abc123.md", { source: "generated", uploadedAt: "not a date" }),
    ]);
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
    from("db", "d0", `connector:db:${DB}:OVERVIEW.md`),
    from("db", "d1", `connector:db:${DB}:public.orders.md`),
    from("confluence", "c1", "confluence:ENG:123456"),
    from("jira", "j1", "jira:WMS-42"),
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

describe("entryLabel (#440 — the attached-document chips)", () => {
  it("names a repository file by basename and repository name", () => {
    const [e] = toPanelEntries([repo("r1", "src/lib/a.ts")], { [CONN]: "wms-core" });
    expect(entryLabel(e)).toBe("a.ts — wms-core");
  });

  it("shows no connector-id fragment for an unnamed repository", () => {
    const [e] = toPanelEntries([repo("r1", "src/lib/a.ts")]);
    const label = entryLabel(e);
    expect(label).toBe(`a.ts — ${UNNAMED_REPOSITORY}`);
    expect(label).not.toContain(CONN.slice(-6));
  });

  it("names another source's document with its source", () => {
    const [e] = toPanelEntries([from("jira", "j1", "jira:WMS-12")]);
    expect(entryLabel(e)).toBe("Jira: WMS-12");
  });

  it("names an upload by its own name", () => {
    const [e] = toPanelEntries([doc("u1", "notes.md")]);
    expect(entryLabel(e)).toBe("notes.md");
  });
});

// #474 — classification reads the stored `source`, never the filename.
describe("classification by stored source (#474)", () => {
  it("keeps an upload named like a connector's document under Uploaded", () => {
    const uploads = [
      doc("u1", "jira:ABC-1"),
      doc("u2", "confluence:ENG:42"),
      doc("u3", `connector:repo:${CONN}:README.md`),
      doc("u4", `connector:db:${CONN}:public.orders.md`),
    ];
    const entries = toPanelEntries(uploads, { [CONN]: "wms-core" });
    expect(entries.map((e) => e.kind)).toEqual(["upload", "upload", "upload", "upload"]);
    const groups = groupEntries(entries);
    expect(groups.uploads.map((e) => e.doc.id)).toEqual(["u1", "u2", "u3", "u4"]);
    expect(groups.repos).toEqual([]);
    expect(groups.sources).toEqual([]);
  });

  // #547 — and labels it by its own name: a connector- or generated-shaped
  // upload is neither a repository file nor a generated document.
  it("labels a connector- or generated-shaped upload by its own name", () => {
    const names = [`connector:repo:${CONN}:src/a.ts`, "generated-doc-cmqpizckr017z8ewh2unm1418.md"];
    const entries = toPanelEntries(names.map((n, i) => doc(`u${i}`, n)));
    expect(entries.map((e) => [e.kind, e.name, e.secondary])).toEqual(
      names.map((n) => ["upload", n, undefined]),
    );
  });

  it("falls back to an upload label when a connector row's filename does not parse", () => {
    const entries = toPanelEntries([
      from("repo", "r1", "README.md"),
      from("db", "d1", "orders.md"),
      from("confluence", "c1", "page.md"),
      from("jira", "j1", "WMS-1"),
    ]);
    expect(entries.map((e) => [e.kind, e.name])).toEqual([
      ["upload", "README.md"],
      ["upload", "orders.md"],
      ["upload", "page.md"],
      ["upload", "WMS-1"],
    ]);
  });

  it("names a Confluence page by its stored title", () => {
    const [e] = toPanelEntries([
      from("confluence", "c1", "confluence:ENG:123456", "Release checklist"),
    ]);
    expect(e).toMatchObject({ kind: "source", name: "Release checklist" });
    expect(entryLabel(e)).toBe("Confluence ENG: Release checklist");
    expect(filterEntries([e], "checklist")).toHaveLength(1);
  });

  it("falls back to the page id when a Confluence page has no title", () => {
    const entries = toPanelEntries([
      from("confluence", "c1", "confluence:ENG:1", "   "),
      from("confluence", "c2", "confluence:ENG:2", null as unknown as string),
    ]);
    expect(entries.map((e) => e.name)).toEqual(["Page 1", "Page 2"]);
  });
});

// #474 — a chip names the same group its file sits in, in the panel.
describe("chip labels carry the panel's group ordinal (#474)", () => {
  const all = [repo("a", "README.md"), repo("b", "README.md", OTHER), repo("c", "src/x.ts", OTHER)];

  it("labels the second unnamed repository's files with its ordinal", () => {
    const entries = toPanelEntries(all, {});
    expect(entries.map(entryLabel)).toEqual([
      `README.md — ${UNNAMED_REPOSITORY}`,
      `README.md — ${UNNAMED_REPOSITORY} 2`,
      `x.ts — ${UNNAMED_REPOSITORY} 2`,
    ]);
    expect(entries[2].title).toBe(`${UNNAMED_REPOSITORY} 2/src/x.ts`);
    // The panel groups by the same names.
    const groups = groupEntries(entries);
    const groupOf = (id: string) =>
      groups.repos.find((r) => r.connectorId === entries.find((e) => e.doc.id === id)?.connectorId)
        ?.name;
    for (const e of entries) expect(entryLabel(e)).toContain(` — ${groupOf(e.doc.id)}`);
  });

  it("keeps the ordinal when only that repository's file is attached or matches the filter", () => {
    const entries = toPanelEntries(all, {});
    const attached = entries.filter((e) => e.doc.id === "b");
    expect(attached.map(entryLabel)).toEqual([`README.md — ${UNNAMED_REPOSITORY} 2`]);
    const filtered = groupEntries(filterEntries(entries, "x.ts"));
    expect(filtered.repos.map((r) => r.name)).toEqual([`${UNNAMED_REPOSITORY} 2`]);
  });

  it("does not number a repository whose name is unique", () => {
    const entries = toPanelEntries(all, { [OTHER]: "api-gateway" });
    expect(entries.map(entryLabel)).toEqual([
      `README.md — ${UNNAMED_REPOSITORY}`,
      "README.md — api-gateway",
      "x.ts — api-gateway",
    ]);
  });

  it("numbers two unnamed databases the same way, apart from repositories", () => {
    const entries = toPanelEntries([
      repo("a", "README.md"),
      from("db", "d1", `connector:db:${CONN}:public.a.md`),
      from("db", "d2", `connector:db:${OTHER}:public.b.md`),
    ]);
    expect(entries.map(entryLabel)).toEqual([
      `README.md — ${UNNAMED_REPOSITORY}`,
      `${UNNAMED_DATABASE}: public.a`,
      `${UNNAMED_DATABASE} 2: public.b`,
    ]);
    expect(filterEntries(entries, `${UNNAMED_DATABASE} 2`.toLowerCase())).toHaveLength(1);
    expect(groupEntries(entries).sources.map((s) => s.name)).toEqual([
      UNNAMED_DATABASE,
      `${UNNAMED_DATABASE} 2`,
    ]);
  });
});
