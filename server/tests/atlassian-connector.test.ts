/**
 * Atlassian connector — ingest pipeline + parsers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const documents = new Map<
  string,
  {
    id: string;
    projectId: string;
    filename: string;
    storagePath: string;
    checksum: string;
    sizeBytes: number;
    status: string;
  }
>();
let nextDocId = 0;
let mcpServerLookups: Array<Record<string, unknown>> = [];
let nextServerResult: { id: string } | null = null;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; filename: string } }) => {
        for (const d of documents.values()) {
          if (d.projectId === where.projectId && d.filename === where.filename) return d;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        nextDocId += 1;
        const doc = {
          id: `doc_${nextDocId}`,
          projectId: data.projectId as string,
          filename: data.filename as string,
          storagePath: data.storagePath as string,
          checksum: data.checksum as string,
          sizeBytes: data.sizeBytes as number,
          status: "pending",
        };
        documents.set(doc.id, doc);
        return doc;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const d = documents.get(where.id);
          if (!d) throw new Error("not found");
          const next = { ...d, ...data } as typeof d;
          documents.set(where.id, next);
          return next;
        },
      ),
    },
    mCPServer: {
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        mcpServerLookups.push(args.where);
        return nextServerResult;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: vi.fn(async ({ projectId, buffer }: { projectId: string; buffer: Buffer }) => ({
      storagePath: `s/${projectId}/${buffer.length}`,
      checksum: `sha-${buffer.length}`,
      sizeBytes: buffer.length,
    })),
  }),
}));

let lastIngestId: string | null = null;
const ingestResult = { status: "ready" as const, chunkCount: 7 };
vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    ingestDocument: vi.fn(async (id: string) => {
      lastIngestId = id;
      return ingestResult;
    }),
  }),
}));

vi.mock("../src/lib/mcp/mcp-service.js", () => ({
  getMCPRegistry: () => ({
    invokeTool: vi.fn(async () => ({ content: {}, isError: false })),
  }),
}));

import {
  ATLASSIAN_MCP_LABEL,
  ingestConfluenceSpace,
  ingestJiraQuery,
  parseConfluencePage,
  parseConfluenceSearch,
  parseJiraIssue,
  parseJiraSearch,
  renderConfluenceMarkdown,
  renderJiraMarkdown,
  resolveAtlassianMCPServer,
  unwrapMCPContent,
} from "../src/lib/connectors/atlassian.js";
import { ConnectorError } from "../src/lib/connectors/types.js";

beforeEach(() => {
  documents.clear();
  nextDocId = 0;
  mcpServerLookups = [];
  nextServerResult = { id: "mcp_atlassian_1" };
  lastIngestId = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("unwrapMCPContent", () => {
  it("unwraps a content[].text JSON envelope", () => {
    expect(unwrapMCPContent({ content: [{ type: "text", text: '{"a":1}' }] })).toEqual({ a: 1 });
  });
  it("returns text when JSON parsing fails", () => {
    expect(unwrapMCPContent({ content: [{ type: "text", text: "not json" }] })).toBe("not json");
  });
  it("returns the input unchanged when not a content envelope", () => {
    expect(unwrapMCPContent({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapMCPContent("hi")).toBe("hi");
  });
});

describe("parsers", () => {
  it("parseConfluenceSearch reads results array", () => {
    const out = parseConfluenceSearch({
      results: [
        { id: "p1", title: "Page 1", url: "https://x/p1" },
        { pageId: "p2", name: "Page 2", _links: { webui: "https://x/p2" } },
        { title: "no id" }, // dropped
      ],
    });
    expect(out).toEqual([
      { id: "p1", title: "Page 1", url: "https://x/p1" },
      { id: "p2", title: "Page 2", url: "https://x/p2" },
    ]);
  });

  it("parseConfluencePage prefers explicit fields", () => {
    const ref = { id: "p1", title: "fallback", url: "u" };
    expect(parseConfluencePage({ title: "T", body: "B" }, ref)).toEqual({
      id: "p1",
      title: "T",
      url: "u",
      body: "B",
    });
  });

  it("parseConfluencePage handles raw string body", () => {
    const ref = { id: "p1", title: "fallback", url: "u" };
    expect(parseConfluencePage("plain", ref).body).toBe("plain");
  });

  it("parseJiraSearch normalizes issues", () => {
    const out = parseJiraSearch({
      issues: [
        { key: "ABC-1", fields: { summary: "first" } },
        { key: "ABC-2", summary: "second", url: "https://j/2" },
        { fields: { summary: "no key" } }, // dropped
      ],
    });
    expect(out).toEqual([
      { key: "ABC-1", summary: "first", url: "" },
      { key: "ABC-2", summary: "second", url: "https://j/2" },
    ]);
  });

  it("parseJiraIssue collects comments + nested fields", () => {
    const ref = { key: "ABC-1", url: "u", summary: "s" };
    const issue = parseJiraIssue(
      {
        fields: {
          summary: "real",
          description: "desc",
          status: { name: "Open" },
          assignee: { displayName: "Alice" },
          comment: {
            comments: [
              { body: "hi", author: { displayName: "Bob" } },
              "raw string",
              { body: "no author" },
            ],
          },
        },
      },
      ref,
    );
    expect(issue.summary).toBe("real");
    expect(issue.description).toBe("desc");
    expect(issue.status).toBe("Open");
    expect(issue.assignee).toBe("Alice");
    expect(issue.comments).toEqual(["Bob: hi", "raw string", "no author"]);
  });

  it("parseJiraIssue handles missing description", () => {
    const ref = { key: "X-1", url: "", summary: "S" };
    const issue = parseJiraIssue({}, ref);
    expect(issue.description).toBe("");
    expect(issue.comments).toEqual([]);
  });
});

describe("renderers", () => {
  it("renderConfluenceMarkdown emits title + url + body", () => {
    const md = renderConfluenceMarkdown({
      id: "p1",
      title: "Hello",
      url: "https://x/p1",
      body: "world",
    });
    expect(md).toContain("# Hello");
    expect(md).toContain("Source: https://x/p1");
    expect(md).toContain("world");
  });

  it("renderConfluenceMarkdown handles empty body", () => {
    const md = renderConfluenceMarkdown({ id: "p", title: "T", url: "", body: "" });
    expect(md).toContain("(empty page)");
  });

  it("renderJiraMarkdown lists comments + status", () => {
    const md = renderJiraMarkdown({
      key: "ABC-1",
      url: "u",
      summary: "S",
      description: "d",
      comments: ["a", "b"],
      status: "Open",
      assignee: "Alice",
    });
    expect(md).toContain("# ABC-1: S");
    expect(md).toContain("Status: Open");
    expect(md).toContain("Assignee: Alice");
    expect(md).toContain("- a");
    expect(md).toContain("- b");
  });
});

describe("resolveAtlassianMCPServer", () => {
  it("prefers project-scoped over global", async () => {
    nextServerResult = { id: "proj_1" };
    const r = await resolveAtlassianMCPServer("p1");
    expect(r?.id).toBe("proj_1");
    expect(mcpServerLookups[0].scope).toBe("project");
    expect(mcpServerLookups[0].label).toBe(ATLASSIAN_MCP_LABEL);
  });
});

describe("ingestConfluenceSpace", () => {
  it("walks pages, ingests each, returns summary", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        content: { results: [{ id: "p1", title: "T1", url: "https://x/p1" }] },
        isError: false,
      })
      .mockResolvedValueOnce({
        content: { title: "T1", body: "body!", url: "https://x/p1" },
        isError: false,
      });
    const summary = await ingestConfluenceSpace({
      projectId: "proj1",
      spaceKey: "DOCS",
      query: "*",
      actorId: "u1",
      invokeTool: invoke,
      resolveServer: async () => ({ id: "srv1" }),
    });
    expect(summary.documentsCreated).toBe(1);
    expect(summary.chunkCount).toBe(7);
    expect(summary.failures).toBe(0);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[0][1]).toBe("confluence_search");
    expect(invoke.mock.calls[1][1]).toBe("confluence_page");
    expect(lastIngestId).toBe("doc_1");
  });

  it("counts page-fetch failures and continues", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        content: {
          results: [
            { id: "p1", title: "T1", url: "" },
            { id: "p2", title: "T2", url: "" },
          ],
        },
        isError: false,
      })
      .mockResolvedValueOnce({ content: null, isError: true })
      .mockResolvedValueOnce({ content: { body: "ok" }, isError: false });
    const summary = await ingestConfluenceSpace({
      projectId: "p",
      spaceKey: "S",
      actorId: "u",
      invokeTool: invoke,
      resolveServer: async () => ({ id: "srv" }),
    });
    expect(summary.failures).toBe(1);
    expect(summary.documentsCreated).toBe(1);
  });

  it("rejects when project mcp server is missing", async () => {
    await expect(
      ingestConfluenceSpace({
        projectId: "p",
        spaceKey: "S",
        actorId: "u",
        invokeTool: vi.fn(),
        resolveServer: async () => null,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rejects bad inputs", async () => {
    await expect(
      ingestConfluenceSpace({
        projectId: "",
        spaceKey: "S",
        actorId: "u",
        resolveServer: async () => ({ id: "x" }),
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
    await expect(
      ingestConfluenceSpace({
        projectId: "p",
        spaceKey: "",
        actorId: "u",
        resolveServer: async () => ({ id: "x" }),
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rejects when search tool errors", async () => {
    await expect(
      ingestConfluenceSpace({
        projectId: "p",
        spaceKey: "S",
        actorId: "u",
        invokeTool: async () => ({ content: null, isError: true }),
        resolveServer: async () => ({ id: "srv" }),
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("dedups identical bodies on re-ingest (skipped)", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({
        content: { results: [{ id: "p1", title: "T", url: "" }] },
        isError: false,
      })
      .mockResolvedValueOnce({
        content: { results: [{ id: "p1", title: "T", url: "" }] },
        isError: false,
      })
      .mockResolvedValueOnce({ content: { body: "same" }, isError: false })
      .mockResolvedValueOnce({
        content: { results: [{ id: "p1", title: "T", url: "" }] },
        isError: false,
      })
      .mockResolvedValueOnce({ content: { body: "same" }, isError: false });
    const args = {
      projectId: "proj1",
      spaceKey: "S",
      actorId: "u",
      invokeTool: invoke,
      resolveServer: async () => ({ id: "srv" }),
    };
    await ingestConfluenceSpace(args);
    const second = await ingestConfluenceSpace(args);
    expect(second.skipped).toBe(1);
    expect(second.documentsCreated).toBe(0);
  });
});

describe("ingestJiraQuery", () => {
  it("walks issues, ingests each", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        content: { issues: [{ key: "X-1", fields: { summary: "s1" } }] },
        isError: false,
      })
      .mockResolvedValueOnce({
        content: { fields: { description: "d1", summary: "s1" } },
        isError: false,
      });
    const summary = await ingestJiraQuery({
      projectId: "p",
      jql: "project=X",
      actorId: "u",
      invokeTool: invoke,
      resolveServer: async () => ({ id: "srv" }),
    });
    expect(summary.documentsCreated).toBe(1);
    expect(summary.chunkCount).toBe(7);
  });

  it("rejects empty jql", async () => {
    await expect(
      ingestJiraQuery({
        projectId: "p",
        jql: "   ",
        actorId: "u",
        resolveServer: async () => ({ id: "x" }),
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rejects when server is missing", async () => {
    await expect(
      ingestJiraQuery({
        projectId: "p",
        jql: "x",
        actorId: "u",
        resolveServer: async () => null,
      }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("counts issue-fetch failures", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({
        content: {
          issues: [
            { key: "X-1", fields: { summary: "s" } },
            { key: "X-2", fields: { summary: "t" } },
          ],
        },
        isError: false,
      })
      .mockResolvedValueOnce({ content: null, isError: true })
      .mockResolvedValueOnce({ content: { description: "ok" }, isError: false });
    const summary = await ingestJiraQuery({
      projectId: "p",
      jql: "x",
      actorId: "u",
      invokeTool: invoke,
      resolveServer: async () => ({ id: "srv" }),
    });
    expect(summary.failures).toBe(1);
    expect(summary.documentsCreated).toBe(1);
  });
});
