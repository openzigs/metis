/**
 * #236 — a project CUSTOM agent as a chat session's OWN agent.
 *
 * Before #236 `ai_sessions.agentId` was a foreign key to the library `agents`
 * table only, so a custom agent could never be a session's agent: its persona,
 * tool allowlist, approval override, skills and model applied only when it ran
 * as a sub-agent. The session now stores `agentRef = custom:<id>`, and every
 * one of those applies exactly as a library agent's does.
 *
 * The provider is the REAL provider class of each family, talking to a
 * loopback HTTP server that answers in that family's wire format, through the
 * real routes over a real SQLite database. Multi-turn: two user turns in one
 * session. Checked on EVERY model request: the tools offered are exactly the
 * agent's allowlist (plus `load_skill`, its own skills' loader), the persona
 * and the skill CATALOG (never a body) are in the system prompt, and a tool
 * outside the allowlist is refused even when the model calls it anyway.
 *
 * Negative: another project's agent, a user who cannot reach the project, a
 * custom agent with no project, a malformed ref — all refused, and nothing is
 * created. A custom agent the project stops using fails CLOSED on the next
 * turn. A fork keeps the agent (dropping it would widen what the fork may call).
 */
import express from "express";
import request from "supertest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import { bodyMarker, IDS, seedAgentsFixture } from "./helpers/agents-fixture.js";
import {
  anthropicReply,
  currentTurn,
  openAiReply,
  systemOf,
  toolNames,
  type Body,
  type Move,
} from "./helpers/provider-wire.js";
import type { AIProvider, ToolDefinition } from "../src/lib/ai/types.js";

const state = vi.hoisted(() => {
  process.env.AI_RATE_LIMIT_MAX = "10000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({ search: async () => ({ hits: [] }) }),
}));

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { __resetToolApprovalBroker } = await import("../src/lib/ai/tool-runtime/approval-broker.js");
const { AnthropicProvider } = await import("../src/lib/ai/providers/anthropic-provider.js");
const { BedrockDirectProvider, OpenAICompatibleProvider } =
  await import("../src/lib/ai/providers/bedrock-direct-provider.js");
const { resetLocalConcurrencyLimitersForTests } =
  await import("../src/lib/ai/providers/local-concurrency-limiter.js");

const countExec = vi.fn(async (a: { table: string }) => ({ text: `rows in ${a.table}: 7` }));
const dangerExec = vi.fn(async () => ({ text: "wrote" }));

interface Seen {
  tools: string[];
  system: string;
  userText: string;
  results: string[];
  model: unknown;
}

const NOT_ALLOWED = "this tool is not allowed for this session's agent";
const NOT_APPROVED = "the user did not approve this tool call in time";

/**
 * What the model "decides", from what it can see. Turn one: load its skill,
 * count rows, answer. Turn two: call a tool OUTSIDE its allowlist anyway, then
 * answer. "count once": call count_rows once, then answer.
 */
function nextMove(seen: Seen): Move {
  const n = seen.results.length;
  if (seen.userText.includes("turn one")) {
    if (n === 0) return { tool: "load_skill", args: { name: "release-notes" } };
    if (n === 1) return { tool: "count_rows", args: { table: "t" } };
    return { text: "one done" };
  }
  if (seen.userText.includes("turn two")) {
    if (n === 0) return { tool: "danger_write", args: { table: "t" } };
    return { text: "two done" };
  }
  if (seen.userText.includes("count once")) {
    if (n === 0) return { tool: "count_rows", args: { table: "t" } };
    return { text: "counted" };
  }
  return { text: "plain answer" };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#236 — a custom agent as the chat session's own agent (real provider classes on the wire)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let bob: string;
    let server: Server;
    let base = "";
    const seen: Seen[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("236-session-agent");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedAgentsFixture(db);
      // Library agents a session may NOT bind: disabled, archived.
      await db.agent.create({
        data: { id: "a-disabled", key: "a-disabled", name: "a-disabled", enabled: false },
      });
      await db.agent.create({
        data: { id: "a-archived", key: "a-archived", name: "a-archived", archivedAt: new Date() },
      });
      // A strict agent: its override tightens `low` (auto in the session) to a prompt.
      await db.customAgent.create({
        data: {
          id: "c-strict",
          projectId: IDS.project,
          name: "Strict",
          systemPrompt: "You are strict.",
          tools: JSON.stringify(["count_rows"]),
          approvalPolicy: JSON.stringify({ low: "always-prompt" }),
        },
      });
      // No tools at all: an empty custom allowlist means NONE.
      await db.customAgent.create({
        data: { id: "c-bare", projectId: IDS.project, name: "Bare", systemPrompt: "You are bare." },
      });
      // A workspace-shared agent, usable in p-1 only through an enablement row.
      await db.customAgent.create({
        data: {
          id: "c-shared",
          projectId: null,
          name: "Shared",
          systemPrompt: "You are shared.",
          tools: JSON.stringify(["count_rows"]),
        },
      });
      await db.customAgentEnablement.create({
        data: { customAgentId: "c-shared", projectId: IDS.project, enabled: true },
      });
      // A project in a workspace Alice belongs to and Bob does not.
      await db.workspace.create({ data: { id: "ws-1", name: "WS", slug: "ws-1" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1", userId: IDS.alice, role: "member" },
      });
      await db.project.create({
        data: {
          id: "p-ws",
          name: "p-ws",
          slug: "p-ws",
          createdById: IDS.alice,
          workspaceId: "ws-1",
        },
      });
      await db.customAgent.create({
        data: {
          id: "c-ws",
          projectId: "p-ws",
          name: "Ws",
          systemPrompt: "You are in a workspace.",
          tools: "[]",
        },
      });
      const token = (userId: string, workspaces: string[] = []) =>
        issueTokens({ userId, username: userId, role: "developer", permissions: [], workspaces })
          .accessToken;
      alice = token(IDS.alice, ["ws-1"]);
      bob = token(IDS.bob);
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        req.on("end", () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const body = (raw ? JSON.parse(raw) : {}) as Body;
          const turn = currentTurn(body);
          const s: Seen = {
            tools: toolNames(body),
            system: systemOf(body),
            userText: turn.userText,
            results: turn.results,
            model: body.model,
          };
          seen.push(s);
          const move = nextMove(s);
          setTimeout(() => {
            if ((req.url ?? "").includes("/messages"))
              anthropicReply(res, body.stream === true, move);
            else openAiReply(res, body.stream === true, move);
            inFlight--;
          }, 5);
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      seen.length = 0;
      inFlight = 0;
      maxInFlight = 0;
      __resetToolRegistrySingleton();
      __resetToolApprovalBroker();
      getToolRegistry().register({
        name: "count_rows",
        description: "Count rows",
        schema: z.object({ table: z.string() }),
        risk: "low",
        exec: countExec,
      } as ToolDefinition);
      getToolRegistry().register({
        name: "danger_write",
        description: "Write rows",
        schema: z.object({ table: z.string() }),
        risk: "high",
        exec: dangerExec,
      } as ToolDefinition);
      countExec.mockClear();
      dangerExec.mockClear();
    });

    afterEach(() => {
      setAIProviderForTests(null);
      delete process.env.LOCAL_GEMMA_MAX_CONCURRENCY;
      delete process.env.AI_TOOL_APPROVAL_TIMEOUT_MS;
      resetLocalConcurrencyLimitersForTests();
    });

    const PROVIDERS: Array<{ name: string; local?: boolean; make: () => AIProvider }> = [
      {
        name: "AnthropicProvider",
        make: () =>
          new AnthropicProvider({ apiKey: "k", baseUrl: base, model: "claude-sonnet-4-6" }),
      },
      {
        name: "OpenAICompatibleProvider (openai)",
        make: () =>
          new OpenAICompatibleProvider({
            baseUrl: `${base}/v1`,
            apiKey: "k",
            model: "gpt-4.1",
            providerKey: "openai",
            maxAttempts: 1,
          }),
      },
      {
        name: "BedrockDirectProvider (bedrock-gateway)",
        make: () =>
          new BedrockDirectProvider({
            baseUrl: `${base}/v1`,
            apiKey: "k",
            model: "us.anthropic.claude-sonnet-4-6",
            providerKey: "bedrock-gateway",
            maxAttempts: 1,
          }),
      },
      {
        name: "OpenAICompatibleProvider (local-gemma, ONE local slot)",
        local: true,
        make: () =>
          new OpenAICompatibleProvider({
            baseUrl: `${base}/v1`,
            apiKey: "ollama",
            model: "gemma4:e4b",
            providerKey: "local-gemma",
            maxAttempts: 1,
          }),
      },
    ];

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use("/api/ai", aiConversationRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const createSession = (token: string, body: Record<string, unknown>) =>
      request(app()).post("/api/ai/sessions").set("Authorization", `Bearer ${token}`).send(body);

    const say = (route: string, sessionId: string, message: string) =>
      request(app())
        .post(route)
        .set("Authorization", `Bearer ${alice}`)
        .send({ sessionId, message });

    for (const p of PROVIDERS) {
      for (const route of ["/api/ai/stream", "/api/ai/chat"] as const) {
        it(`${p.name} ${route}: two turns under the custom agent — tools on the wire are its allowlist exactly`, async () => {
          if (p.local) process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
          resetLocalConcurrencyLimitersForTests();
          setAIProviderForTests(p.make());
          const created = await createSession(alice, {
            projectId: IDS.project,
            agentRef: `custom:${IDS.helper}`,
            policy: { low: "auto", medium: "auto" },
          });
          expect(created.status, created.text).toBe(201);
          const session = created.body.data.session as {
            id: string;
            agentId: string | null;
            agentRef: string | null;
            loadedSkillIds: string;
          };
          expect(session.agentRef).toBe(`custom:${IDS.helper}`);
          expect(session.agentId).toBeNull();
          // The agent's skill is the session's skill, as a library agent's default skills are.
          expect(JSON.parse(session.loadedSkillIds)).toEqual(["s-release"]);

          const one = await say(route, session.id, "Please do turn one.");
          expect(one.status, one.text.slice(0, 500)).toBe(200);
          const two = await say(route, session.id, "Please do turn two.");
          expect(two.status, two.text.slice(0, 500)).toBe(200);

          // Turn one: load_skill → count_rows → answer. Turn two: danger_write (refused) → answer.
          expect(seen.map((s) => s.results.length)).toEqual([0, 1, 2, 0, 1]);
          for (const s of seen) {
            // EXACTLY the agent's allowlist, plus its own skills' loader. No
            // danger_write (outside the allowlist) and no sub-agent tools
            // (the allowlist names no `agent:` ref).
            expect([...s.tools].sort()).toEqual(["count_rows", "load_skill"]);
            expect(s.system).toContain("You are the helper.");
            expect(s.system).toContain("- release-notes: Release notes");
            expect(s.system).not.toContain(bodyMarker("release-notes"));
          }
          // The skill body arrived through load_skill, on request only.
          expect(seen[1]!.results[0]).toContain(bodyMarker("release-notes"));
          expect(countExec).toHaveBeenCalledTimes(1);
          // Called anyway, refused by the gate: never executed.
          expect(dangerExec).not.toHaveBeenCalled();
          expect(seen[4]!.results[0]).toContain(NOT_ALLOWED);
          if (p.local) expect(maxInFlight).toBe(1);
        });
      }
    }

    it("a custom agent whose allowlist is empty is offered NO tools (nothing on the wire)", async () => {
      setAIProviderForTests(PROVIDERS[1]!.make());
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: "custom:c-bare",
        policy: { low: "auto", medium: "auto", high: "auto" },
      });
      expect(created.status).toBe(201);
      const res = await say("/api/ai/chat", created.body.data.session.id, "count once");
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.tools).toEqual([]);
      expect(seen[0]!.system).toContain("You are bare.");
      expect(countExec).not.toHaveBeenCalled();
    });

    it("the agent's approval override tightens the session policy: an `auto` low-risk tool now needs approval", async () => {
      process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "50";
      setAIProviderForTests(PROVIDERS[0]!.make());
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: "custom:c-strict",
        policy: { low: "auto", medium: "auto", high: "auto" },
      });
      expect(created.status).toBe(201);
      const res = await say("/api/ai/chat", created.body.data.session.id, "count once");
      expect(res.status).toBe(200);
      expect(seen[0]!.tools).toEqual(["count_rows"]);
      // Nobody approved within the window: the call did not run.
      expect(countExec).not.toHaveBeenCalled();
      expect(seen[1]!.results[0]).toContain(NOT_APPROVED);
    });

    it("a sub-agent of a custom session agent passes the approval gate too, and the agent is never its own sub-agent", async () => {
      process.env.AI_TOOL_APPROVAL_TIMEOUT_MS = "50";
      setAIProviderForTests(PROVIDERS[1]!.make());
      // Writer: tools [danger_write, agent:*] — may delegate to the project's other agents.
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: `custom:${IDS.writer}`,
        policy: { low: "auto", medium: "auto", high: "always-prompt" },
      });
      expect(created.status).toBe(201);
      const res = await say("/api/ai/chat", created.body.data.session.id, "plain");
      expect(res.status).toBe(200);
      const tools = seen[0]!.tools;
      expect(tools).toContain("danger_write");
      expect(tools).not.toContain("count_rows"); // outside Writer's allowlist
      expect(tools).toContain("agent_helper");
      expect(tools).not.toContain("agent_writer"); // never its own sub-agent
      expect(tools.every((t) => t === "danger_write" || t.startsWith("agent_"))).toBe(true);
    });

    it("a workspace-shared custom agent ENABLED for the project can be bound", async () => {
      setAIProviderForTests(PROVIDERS[1]!.make());
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: "custom:c-shared",
      });
      expect(created.status).toBe(201);
      await say("/api/ai/chat", created.body.data.session.id, "plain");
      expect(seen[0]!.system).toContain("You are shared.");
      expect(seen[0]!.tools).toEqual(["count_rows"]);
    });

    it("an agent the project stops using fails CLOSED on the next turn: no persona, no tools", async () => {
      setAIProviderForTests(PROVIDERS[1]!.make());
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: "custom:c-shared",
        policy: { low: "auto" },
      });
      expect(created.status).toBe(201);
      await db.customAgentEnablement.update({
        where: { customAgentId_projectId: { customAgentId: "c-shared", projectId: IDS.project } },
        data: { enabled: false },
      });
      try {
        const res = await say("/api/ai/chat", created.body.data.session.id, "count once");
        expect(res.status).toBe(200);
        expect(seen[0]!.tools).toEqual([]);
        expect(seen[0]!.system).not.toContain("You are shared.");
        expect(countExec).not.toHaveBeenCalled();
      } finally {
        await db.customAgentEnablement.update({
          where: {
            customAgentId_projectId: { customAgentId: "c-shared", projectId: IDS.project },
          },
          data: { enabled: true },
        });
      }
    });

    it("a fork keeps the custom agent: the forked session is offered the same allowlist, never more", async () => {
      setAIProviderForTests(PROVIDERS[1]!.make());
      const created = await createSession(alice, {
        projectId: IDS.project,
        agentRef: `custom:${IDS.helper}`,
        policy: { low: "auto", medium: "auto" },
      });
      const sid = created.body.data.session.id as string;
      const first = await say("/api/ai/chat", sid, "plain");
      const replyOrdinal = first.body.data.transcript.replyOrdinal as number;
      const fork = await request(app())
        .post(`/api/ai/sessions/${sid}/fork`)
        .set("Authorization", `Bearer ${alice}`)
        .send({ fromOrdinal: replyOrdinal });
      expect(fork.status, fork.text).toBe(201);
      const forkId = fork.body.data.session.id as string;
      const row = await db.aISession.findUnique({ where: { id: forkId } });
      expect(row?.agentRef).toBe(`custom:${IDS.helper}`);
      seen.length = 0;
      await say("/api/ai/chat", forkId, "plain");
      expect([...seen[0]!.tools].sort()).toEqual(["count_rows", "load_skill"]);
      expect(seen[0]!.system).toContain("You are the helper.");
    });

    describe("refused bindings — nothing is created", () => {
      const cases: Array<{
        name: string;
        token: () => string;
        body: Record<string, unknown>;
        status: number;
        code: string;
      }> = [
        {
          name: "another project's custom agent",
          token: () => alice,
          body: { projectId: IDS.project, agentRef: `custom:${IDS.outsider}` },
          status: 404,
          code: "AGENT_NOT_FOUND",
        },
        {
          name: "a custom agent that does not exist",
          token: () => alice,
          body: { projectId: IDS.project, agentRef: "custom:nope" },
          status: 404,
          code: "AGENT_NOT_FOUND",
        },
        {
          name: "a user who cannot reach the agent's project",
          token: () => bob,
          body: { projectId: "p-ws", agentRef: "custom:c-ws" },
          status: 404,
          code: "NOT_FOUND",
        },
        {
          name: "a custom agent with no project scope",
          token: () => alice,
          body: { agentRef: `custom:${IDS.helper}` },
          status: 400,
          code: "AGENT_REQUIRES_PROJECT",
        },
        {
          name: "a malformed ref (traversal-shaped id)",
          token: () => alice,
          body: { projectId: IDS.project, agentRef: "custom:../c-helper" },
          status: 400,
          code: "AGENT_REF_INVALID",
        },
        {
          name: "a ref AND an agentId",
          token: () => alice,
          body: { projectId: IDS.project, agentRef: `custom:${IDS.helper}`, agentId: IDS.lead },
          status: 400,
          code: "AGENT_REF_CONFLICT",
        },
      ];
      for (const c of cases) {
        it(c.name, async () => {
          const before = await db.aISession.count();
          const res = await createSession(c.token(), c.body);
          expect(res.status, res.text).toBe(c.status);
          expect(res.body.error?.code).toBe(c.code);
          expect(await db.aISession.count()).toBe(before);
        });
      }

      it("a member of the agent's workspace CAN bind it (the refusal above is the access check)", async () => {
        const res = await createSession(alice, { projectId: "p-ws", agentRef: "custom:c-ws" });
        expect(res.status, res.text).toBe(201);
        expect(res.body.data.session.agentRef).toBe("custom:c-ws");
      });
    });

    it("a library ref binds through the library path, unchanged", async () => {
      const res = await createSession(alice, {
        projectId: IDS.project,
        agentRef: `library:${IDS.lead}`,
      });
      expect(res.status, res.text).toBe(201);
      expect(res.body.data.session.agentId).toBe(IDS.lead);
      expect(res.body.data.session.agentRef).toBeNull();
    });

    describe("GET /api/ai/session-agents — the one picker's list", () => {
      it("lists library agents and the project's own + enabled custom agents, never another project's", async () => {
        const res = await request(app())
          .get(`/api/ai/session-agents?projectId=${IDS.project}`)
          .set("Authorization", `Bearer ${alice}`);
        expect(res.status).toBe(200);
        const refs = (res.body.data.items as Array<{ ref: string }>).map((i) => i.ref);
        expect(refs).toEqual([
          `library:${IDS.lead}`,
          "custom:c-bare",
          `custom:${IDS.helper}`,
          "custom:c-shared",
          "custom:c-strict",
          `custom:${IDS.writer}`,
        ]);
        expect(refs).not.toContain(`custom:${IDS.outsider}`);
        expect(refs).not.toContain("library:a-disabled");
        expect(refs).not.toContain("library:a-archived");
      });

      it("without a project: library agents only", async () => {
        const res = await request(app())
          .get("/api/ai/session-agents")
          .set("Authorization", `Bearer ${alice}`);
        expect(
          (res.body.data.items as Array<{ kind: string }>).every((i) => i.kind === "library"),
        ).toBe(true);
      });

      it("is rate-limited like the other session reads", async () => {
        await db.user.create({
          data: { id: "u-rate", username: "u-rate", displayName: "r", email: "r@example.test" },
        });
        const t = issueTokens({
          userId: "u-rate",
          username: "u-rate",
          role: "developer",
          permissions: [],
        }).accessToken;
        process.env.AI_CONVERSATION_RATE_LIMIT_MAX = "2";
        try {
          const codes: number[] = [];
          for (let i = 0; i < 3; i++) {
            const res = await request(app())
              .get("/api/ai/session-agents")
              .set("Authorization", `Bearer ${t}`);
            codes.push(res.status);
          }
          expect(codes).toEqual([200, 200, 429]);
        } finally {
          delete process.env.AI_CONVERSATION_RATE_LIMIT_MAX;
        }
      });

      it("a project the caller cannot reach is 404", async () => {
        const res = await request(app())
          .get("/api/ai/session-agents?projectId=p-ws")
          .set("Authorization", `Bearer ${bob}`);
        expect(res.status).toBe(404);
      });
    });
  },
);
