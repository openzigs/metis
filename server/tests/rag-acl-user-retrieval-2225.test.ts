/**
 * #2225 — every retrieval a user starts searches with that user as the ACL
 * actor, so a chunk whose ACL excludes them never reaches their prompt.
 * #2248 — a reply a whole thread or channel reads searches for a shared
 * audience (unrestricted chunks only), and a deprovisioned user resolves to no
 * actor at all.
 *
 * The real `KnowledgeService` runs (its ACL filter is the thing under test);
 * only the embedder, vector store, BM25 index and Prisma are substituted. The
 * role is read through the real `resolveAclActor` → `resolveDurableRole` over
 * the mocked `userRole` rows, so a role-scoped chunk proves the durable role is
 * what is matched. Each path is asserted on what the model would be given: the
 * auto-RAG block, the retriever's block, the tool's text, the federated hits.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeService as KnowledgeServiceType } from "../src/lib/rag/knowledge-service.js";

/** One chunk per ACL shape; the text is what must (not) reach a prompt. */
const CHUNKS = [
  { id: "open", acl: "[]", text: "OPEN-EXCERPT about the scheduler" },
  {
    id: "alice-only",
    acl: '[{"kind":"user","value":"alice"}]',
    text: "ALICE-ONLY excerpt about the scheduler",
  },
  {
    id: "coordinators",
    acl: '[{"kind":"role","value":"coordinator"}]',
    text: "COORDINATOR-ONLY excerpt about the scheduler",
  },
] as const;

const state = vi.hoisted(() => ({
  service: null as unknown,
  /** userId → durable role key; a user absent here has no role rows (reader). */
  roles: {} as Record<string, string>,
  roleReadFails: false,
  /**
   * #2248/#2261 — user rows by id; an id absent here is an active, undeleted
   * user. The mock evaluates the query's `where` against the row, so the live
   * check's predicate is what decides, not the shape of the call.
   */
  users: {} as Record<string, { status: string; deletedAt: Date | null }>,
}));

/** Deprovision `ids` the way SCIM does: disabled and soft-deleted. */
function deprovision(...ids: string[]): void {
  for (const id of ids) state.users[id] = { status: "disabled", deletedAt: new Date() };
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: vi.fn(async () => ({ name: "Scheduler" })) },
    user: {
      // The live check filters on `status` and `deletedAt`; the role read
      // (`resolveEffectiveRole`) filters on the id only. Every `where` key must
      // equal the row's value, as the database would evaluate it.
      findFirst: vi.fn(async (args: { where: Record<string, unknown> & { id: string } }) => {
        const row = {
          id: args.where.id,
          authRoleAuthority: null,
          ...(state.users[args.where.id] ?? { status: "active", deletedAt: null }),
        };
        const matches = Object.entries(args.where).every(
          ([key, value]) => (row as Record<string, unknown>)[key] === value,
        );
        return matches ? row : null;
      }),
    },
    userRole: {
      findMany: vi.fn(async (args: { where: { userId: string } }) => {
        if (state.roleReadFails) throw new Error("db down");
        const key = state.roles[args.where.userId];
        return key ? [{ source: "local", role: { key } }] : [];
      }),
    },
    knowledgeChunk: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        CHUNKS.filter((c) => args.where.id.in.includes(c.id)).map((c) => ({
          id: c.id,
          metadata: "{}",
          aclSubjects: c.acl,
          document: { source: "upload" },
        })),
      ),
    },
  },
}));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/auth/accessible-projects.js", () => ({
  getUserAccessibleProjects: vi.fn(async () => [{ id: "p1", name: "Scheduler" }]),
}));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => state.service,
}));

const { KnowledgeService } = await import("../src/lib/rag/knowledge-service.js");
const { buildAutoRagContext } = await import("../src/routes/ai.js");
const { projectRetriever } = await import("../src/lib/discussions/project-retrieval.js");
const { buildSearchKnowledgeTool } = await import("../src/lib/rag/search-knowledge-tool.js");
const { FederatedSearchService } = await import("../src/lib/rag/federated-search-service.js");
const { resolveAclActor, sharedAudienceActor, InactiveAclActorError } =
  await import("../src/lib/rag/acl.js");
const { buildSessionToolset } = await import("../src/lib/ai/tool-runtime/toolset.js");
const { ToolRegistry } = await import("../src/lib/ai/tool-registry.js");

/** A real KnowledgeService over a fake index that returns every chunk. */
function realService(): KnowledgeServiceType {
  const records = CHUNKS.map((c) => ({
    score: 0.9,
    row: {
      metadata: {
        chunkId: c.id,
        documentId: `doc-${c.id}`,
        text: c.text,
        filename: `${c.id}.md`,
        position: 0,
        embeddingModel: "fake",
      },
    },
  }));
  return new KnowledgeService({
    embedder: {
      model: "fake",
      dimension: 2,
      embed: vi.fn(async () => ({ vectors: [[1, 0]], model: "fake", dimension: 2 })),
    },
    vectorStore: {
      search: vi.fn(async () => records),
      modelCoverage: vi.fn(async () => ({ totalChunks: 3, modelCounts: { fake: 3 } })),
    },
    reranker: { enabled: false, rerank: vi.fn() },
    bm25: { search: vi.fn(async () => CHUNKS.map((c) => ({ chunkId: c.id, score: 1 }))) },
  } as never);
}

const question = [{ role: "user" as const, content: "how is the scheduler configured?" }];

beforeEach(() => {
  state.service = realService();
  state.roles = { alice: "reader", carol: "coordinator", root: "admin" };
  state.roleReadFails = false;
  state.users = {};
});

describe("resolveAclActor (#2225)", () => {
  it("reads the role from durable state", async () => {
    await expect(resolveAclActor("carol")).resolves.toEqual({
      userId: "carol",
      role: "coordinator",
    });
    // No role rows ⇒ the lowest role, never a bypass.
    await expect(resolveAclActor("bob")).resolves.toEqual({ userId: "bob", role: "reader" });
  });
});

describe("chat auto-RAG — buildAutoRagContext (#2225)", () => {
  it("never puts a chunk whose ACL excludes the requester in the prompt", async () => {
    const block = await buildAutoRagContext("p1", question, "bob");
    expect(block).toContain("OPEN-EXCERPT");
    expect(block).not.toContain("ALICE-ONLY");
    expect(block).not.toContain("COORDINATOR-ONLY");
  });

  it("gives a user-ACL chunk to that user and a role-ACL chunk to that role", async () => {
    const alice = await buildAutoRagContext("p1", question, "alice");
    expect(alice).toContain("ALICE-ONLY");
    expect(alice).not.toContain("COORDINATOR-ONLY");

    const carol = await buildAutoRagContext("p1", question, "carol");
    expect(carol).toContain("COORDINATOR-ONLY");
    expect(carol).not.toContain("ALICE-ONLY");
  });

  it("keeps the admin bypass", async () => {
    const block = await buildAutoRagContext("p1", question, "root");
    expect(block).toContain("ALICE-ONLY");
    expect(block).toContain("COORDINATOR-ONLY");
  });

  it("retrieves nothing when the requester's role cannot be read (fail closed)", async () => {
    state.roleReadFails = true;
    const capture = { contexts: [] as string[], sources: 0 };
    await expect(buildAutoRagContext("p1", question, "carol", undefined, capture)).resolves.toBe(
      "",
    );
    expect(capture).toEqual({ contexts: [], sources: 0 });
  });
});

describe("discussion / Teams responder — projectRetriever (#2248)", () => {
  it("grounds a shared reply on unrestricted chunks only, whoever triggered it", async () => {
    // alice may see ALICE-ONLY and carol COORDINATOR-ONLY in their own chat,
    // but the thread and the channel read this reply too.
    for (const trigger of ["bob", "alice", "carol"]) {
      const r = await projectRetriever("p1", trigger)("how is the scheduler configured?");
      expect(r.block).toContain("OPEN-EXCERPT");
      expect(r.block).not.toContain("ALICE-ONLY");
      expect(r.block).not.toContain("COORDINATOR-ONLY");
      expect(r.sources).toBe(1);
    }
  });

  it("gives an admin trigger no bypass on a shared reply", async () => {
    const r = await projectRetriever("p1", "root")("how is the scheduler configured?");
    expect(r.block).not.toContain("ALICE-ONLY");
    expect(r.block).not.toContain("COORDINATOR-ONLY");
    expect(r.sources).toBe(1);
  });
});

describe("search-knowledge tool (#2225)", () => {
  const tool = () => buildSearchKnowledgeTool();

  it("never returns a chunk whose ACL excludes the session's user", async () => {
    const result = await tool().exec(
      { query: "scheduler" },
      { sessionId: "s1", userId: "bob", projectId: "p1" },
    );
    expect(result.text).toContain("OPEN-EXCERPT");
    expect(result.text).not.toContain("ALICE-ONLY");
    expect(result.text).not.toContain("COORDINATOR-ONLY");
    expect(result.resultCount).toBe(1);
  });

  it("returns the chunk to the user its ACL names", async () => {
    const result = await tool().exec(
      { query: "scheduler" },
      { sessionId: "s1", userId: "alice", projectId: "p1" },
    );
    expect(result.text).toContain("ALICE-ONLY");
  });

  it("refuses to search when the user's role cannot be read", async () => {
    state.roleReadFails = true;
    await expect(
      tool().exec({ query: "scheduler" }, { sessionId: "s1", userId: "carol", projectId: "p1" }),
    ).rejects.toThrow("db down");
  });
});

describe("federated search (#2225)", () => {
  it("applies the caller's chunk ACLs inside each project", async () => {
    const service = new FederatedSearchService({
      knowledgeService: state.service as KnowledgeServiceType,
    });
    const bob = await service.searchAcrossProjects({ userId: "bob", query: "scheduler" });
    expect(bob.hits.map((h) => h.chunkId)).toEqual(["open"]);

    const carol = await service.searchAcrossProjects({ userId: "carol", query: "scheduler" });
    expect(carol.hits.map((h) => h.chunkId).sort()).toEqual(["coordinators", "open"]);
  });
});

describe("shared-audience actor (#2248)", () => {
  it("auto-RAG for a shared audience drops a chunk restricted to the trigger", async () => {
    const block = await buildAutoRagContext("p1", question, sharedAudienceActor("alice"));
    expect(block).toContain("OPEN-EXCERPT");
    expect(block).not.toContain("ALICE-ONLY");
  });

  it("the discussion search-knowledge call searches for the shared audience", async () => {
    // Through the real registry → toolset path a discussion reply uses, with
    // the context the responder hands the executor.
    const registry = new ToolRegistry();
    registry.register(buildSearchKnowledgeTool());
    const ctx = { sessionId: "s1", userId: "alice", projectId: "p1" };
    const set = await buildSessionToolset({ ctx, registry });
    const result = await set.tools[0]!.execute(
      { query: "scheduler" },
      { ...ctx, aclAudience: "shared" },
    );
    expect(result.text).toContain("OPEN-EXCERPT");
    expect(result.text).not.toContain("ALICE-ONLY");
    expect(result.resultCount).toBe(1);
  });

  it("the same search outside a shared reply still gives alice her chunk", async () => {
    const result = await buildSearchKnowledgeTool().exec(
      { query: "scheduler" },
      { sessionId: "s1", userId: "alice", projectId: "p1" },
    );
    expect(result.text).toContain("ALICE-ONLY");
  });
});

describe("deprovisioned users (#2248)", () => {
  it("resolveAclActor rejects an inactive user, even one holding admin", async () => {
    deprovision("root");
    await expect(resolveAclActor("root")).rejects.toBeInstanceOf(InactiveAclActorError);
    // A live admin still resolves to admin.
    state.users = {};
    await expect(resolveAclActor("root")).resolves.toEqual({ userId: "root", role: "admin" });
  });

  // #2261 — each half of the liveness predicate is pinned on its own: a user
  // who fails only one of them must still be rejected.
  it("rejects a soft-deleted admin whose status still reads active", async () => {
    state.users = { root: { status: "active", deletedAt: new Date() } };
    await expect(resolveAclActor("root")).rejects.toBeInstanceOf(InactiveAclActorError);
  });

  it("rejects a disabled admin who is not soft-deleted", async () => {
    state.users = { root: { status: "disabled", deletedAt: null } };
    await expect(resolveAclActor("root")).rejects.toBeInstanceOf(InactiveAclActorError);
  });

  it("asks for exactly an active, undeleted user by id", async () => {
    const { prisma } = await import("../src/lib/prisma.js");
    await resolveAclActor("carol");
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: "carol", status: "active", deletedAt: null },
      select: { id: true },
    });
  });

  it("a deprovisioned admin's chat retrieves nothing: no bypass, no access", async () => {
    deprovision("root");
    await expect(buildAutoRagContext("p1", question, "root")).resolves.toBe("");
  });

  it("a deprovisioned user's search-knowledge call fails, never searching", async () => {
    deprovision("alice");
    await expect(
      buildSearchKnowledgeTool().exec(
        { query: "scheduler" },
        { sessionId: "s1", userId: "alice", projectId: "p1" },
      ),
    ).rejects.toBeInstanceOf(InactiveAclActorError);
  });

  it("federated search rejects for a deprovisioned user", async () => {
    deprovision("carol");
    const service = new FederatedSearchService({
      knowledgeService: state.service as KnowledgeServiceType,
    });
    await expect(
      service.searchAcrossProjects({ userId: "carol", query: "scheduler" }),
    ).rejects.toBeInstanceOf(InactiveAclActorError);
  });
});
