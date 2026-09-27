/**
 * Epic #129 — the testing lesson from #128, applied: provider options are never
 * asserted against a stub that ignores them. Each provider FAMILY here is the
 * REAL provider class talking to a loopback HTTP server that answers with real
 * tool calls in that family's wire format:
 *
 *   • AnthropicProvider                         — Anthropic Messages
 *   • OpenAICompatibleProvider (openai)         — OpenAI chat completions
 *   • BedrockDirectProvider (bedrock-gateway)   — the gateway's OpenAI shape
 *   • OpenAICompatibleProvider (local-gemma)    — local, behind the per-base-URL
 *                                                 FIFO limiter at ONE slot
 *
 * One multi-turn chat, through the real routes over a real SQLite database:
 * the main agent loads a skill (load_skill), delegates to a sub-agent (which
 * calls a tool and answers), then answers. Checked on EVERY model request —
 * the parent's and the sub-agent's, the tool-result follow-ups included:
 * the right tools are on the wire, the skill CATALOG (never a body) is in the
 * system prompt, and the sub-agent is offered only its own allowlist.
 *
 * Local: the sub-agent's model calls go to the same one-slot local model the
 * parent uses. It must complete (no deadlock — the parent holds no slot while a
 * tool, and so a sub-agent, runs) and the server must never see two local
 * requests in flight at once.
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
import type { AIProvider, ToolDefinition } from "../src/lib/ai/types.js";
import {
  anthropicReply,
  openAiReply,
  systemOf,
  toolNames,
  toolResults,
  type Body,
  type Move,
} from "./helpers/provider-wire.js";

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
const { __resetModelCatalogForTests } = await import("../src/lib/ai/model-catalog.js");

const countExec = vi.fn(async (a: { table: string }) => ({ text: `rows in ${a.table}: 7` }));
const dangerExec = vi.fn(async () => ({ text: "wrote" }));

interface Seen {
  sub: boolean;
  tools: string[];
  system: string;
  results: number;
  model: unknown;
}

const DELEGATED = "Another agent delegated a task to you";

/** What the model "decides", from what it can see — the same for every wire format. */
function nextMove(seen: Seen): Move {
  if (!seen.sub) {
    if (seen.results === 0) return { tool: "load_skill", args: { name: "style-guide" } };
    if (seen.results === 1) {
      const agent = seen.tools.find((t) => t.startsWith("agent_"));
      return { tool: agent ?? "missing_agent_tool", args: { task: "Count the rows in table t." } };
    }
    return { text: "done" };
  }
  if (seen.results === 0) return { tool: "count_rows", args: { table: "t" } };
  return { text: "sub done" };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "Epic #129 — real provider classes on the wire: skills and sub-agents on EVERY request",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let alice: string;
    let server: Server;
    let base = "";
    const seen: Seen[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    /** When set, a SUB-AGENT request is never answered (held until its socket closes). */
    let hangSub = false;
    const hanging: Array<{ closed: boolean }> = [];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("129-wire");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await seedAgentsFixture(db);
      alice = issueTokens({
        userId: IDS.alice,
        username: "alice",
        role: "developer",
        permissions: [],
      }).accessToken;
      server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
        req.on("end", () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          const body = (raw ? JSON.parse(raw) : {}) as Body;
          const system = systemOf(body);
          const s: Seen = {
            sub: system.includes(DELEGATED),
            tools: toolNames(body),
            system,
            results: toolResults(body),
            model: body.model,
          };
          seen.push(s);
          if (hangSub && s.sub) {
            const h = { closed: false };
            hanging.push(h);
            res.on("close", () => {
              h.closed = true;
              inFlight--;
            });
            return;
          }
          const move = nextMove(s);
          // Hold the response a moment so overlapping requests WOULD overlap.
          setTimeout(() => {
            if ((req.url ?? "").includes("/messages"))
              anthropicReply(res, body.stream === true, move);
            else openAiReply(res, body.stream === true, move);
            inFlight--;
          }, 15);
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
      hangSub = false;
      hanging.length = 0;
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
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    for (const p of PROVIDERS) {
      for (const route of ["/api/ai/stream", "/api/ai/chat"] as const) {
        it(`${p.name} ${route}: tools and the skill catalog reach every request; the sub-agent gets only its own allowlist`, async () => {
          if (p.local) process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
          resetLocalConcurrencyLimitersForTests();
          setAIProviderForTests(p.make());
          const created = await request(app())
            .post("/api/ai/sessions")
            .set("Authorization", `Bearer ${alice}`)
            .send({ projectId: IDS.project, agentId: IDS.lead, policy: { medium: "auto" } });
          expect(created.status).toBe(201);
          const sid = created.body.data.session.id as string;
          const res = await request(app())
            .post(route)
            .set("Authorization", `Bearer ${alice}`)
            .send({ sessionId: sid, message: "Count the rows, please." });
          expect(res.status, res.text.slice(0, 500)).toBe(200);

          const parent = seen.filter((s) => !s.sub);
          const sub = seen.filter((s) => s.sub);
          // Parent: load_skill → delegate → answer; sub: count_rows → answer.
          expect(parent.map((s) => s.results)).toEqual([0, 1, 2]);
          expect(sub.map((s) => s.results)).toEqual([0, 1]);

          for (const s of parent) {
            expect(s.tools).toEqual(
              expect.arrayContaining(["load_skill", "count_rows", "danger_write"]),
            );
            expect(s.tools.some((t) => t.startsWith("agent_"))).toBe(true);
            expect(s.system).toContain("- style-guide: Style guide");
            expect(s.system).not.toContain(bodyMarker("style-guide"));
          }
          for (const s of sub) {
            expect(s.tools).toContain("count_rows");
            expect(s.tools).toContain("load_skill"); // its own skill, progressively
            expect(s.tools).not.toContain("danger_write"); // outside ITS allowlist
            expect(s.system).toContain("You are the helper.");
            expect(s.system).toContain("- release-notes: Release notes");
            expect(s.system).not.toContain(bodyMarker("release-notes"));
          }
          expect(countExec).toHaveBeenCalledTimes(1);
          expect(dangerExec).not.toHaveBeenCalled();
          const runs = await db.aISubAgentRun.findMany({ where: { sessionId: sid } });
          expect(runs).toHaveLength(1);
          expect(runs[0]).toMatchObject({
            status: "completed",
            result: "sub done",
            agentName: "Helper",
          });
          if (p.local) expect(maxInFlight).toBe(1);
        });
      }
    }

    // PR #239 panel — the turn's live context reaches its sub-agents.
    // #204 — they DO get the turn's local-slot QUEUE hooks (report-only: a queued
    // sub-agent call pauses the turn's hard ceiling), never the parent's one-shot
    // slot signal. The queue path itself is proven on the wire in
    // chat-session-provider-usage-queue.sqlite.test.ts.
    it("local-gemma /api/ai/stream: a sub-agent's calls get the turn's abort signal and queue hooks but never the parent's sessionId or slot signal", async () => {
      process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
      resetLocalConcurrencyLimitersForTests();
      const provider = PROVIDERS.find((p) => p.local)!.make();
      const chat = vi.spyOn(provider, "chat");
      setAIProviderForTests(provider);
      const created = await request(app())
        .post("/api/ai/sessions")
        .set("Authorization", `Bearer ${alice}`)
        .send({ projectId: IDS.project, agentId: IDS.lead, policy: { medium: "auto" } });
      const sid = created.body.data.session.id as string;
      const res = await request(app())
        .post("/api/ai/stream")
        .set("Authorization", `Bearer ${alice}`)
        .send({ sessionId: sid, message: "Count the rows, please." });
      expect(res.status).toBe(200);
      const subCalls = chat.mock.calls.filter(([messages]) =>
        messages.some((m) => m.role === "system" && String(m.content).includes(DELEGATED)),
      );
      expect(subCalls.length).toBe(2);
      for (const [, opts] of subCalls) {
        expect(opts?.signal).toBeInstanceOf(AbortSignal);
        expect(opts).not.toHaveProperty("sessionId");
        expect(opts).not.toHaveProperty("reasoningEffort");
        expect(opts?.onSlotQueued).toBeTypeOf("function");
        expect(opts?.onSlotAcquired).toBeTypeOf("function");
      }
      // Every sub-agent call got the SAME report-only hook pair — not a fresh
      // one-shot slot signal per call.
      expect(subCalls[0]![1]!.onSlotAcquired).toBe(subCalls[1]![1]!.onSlotAcquired);
      // Nothing queued (one call at a time), so nothing was reported.
      expect(res.text).not.toContain("event: queue");
    });

    it("local-gemma: the user stopping a turn stops its running sub-agent and frees the one local slot", async () => {
      process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
      resetLocalConcurrencyLimitersForTests();
      setAIProviderForTests(PROVIDERS.find((p) => p.local)!.make());
      const newSession = async () => {
        const created = await request(app())
          .post("/api/ai/sessions")
          .set("Authorization", `Bearer ${alice}`)
          .send({ projectId: IDS.project, agentId: IDS.lead, policy: { medium: "auto" } });
        return created.body.data.session.id as string;
      };
      const waitFor = async (what: string, ok: () => boolean | Promise<boolean>) => {
        for (let i = 0; i < 400; i++) {
          if (await ok()) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`timed out waiting for: ${what}`);
      };
      const sid = await newSession();
      const live = app().listen(0, "127.0.0.1");
      await new Promise<void>((r) => live.once("listening", () => r()));
      try {
        hangSub = true;
        const stop = new AbortController();
        const turn = fetch(
          `http://127.0.0.1:${(live.address() as AddressInfo).port}/api/ai/stream`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: sid, message: "Count the rows, please." }),
            signal: stop.signal,
          },
        )
          .then((r) => r.text())
          .catch(() => "aborted");
        // The sub-agent is mid-call on the local model, holding the only slot.
        await waitFor("the sub-agent's model call", () => hanging.length === 1);
        stop.abort(); // the user presses Stop
        await turn;
        await waitFor("the sub-agent's model call to be cancelled", () => hanging[0]!.closed);
        await waitFor("the sub-agent run to be recorded as aborted", async () => {
          const runs = await db.aISubAgentRun.findMany({ where: { sessionId: sid } });
          return runs.length === 1 && runs[0]!.status === "aborted";
        });
        // The slot is free: a new turn on the same one-slot local model completes.
        hangSub = false;
        const next = await newSession();
        const res = await Promise.race([
          request(app())
            .post("/api/ai/chat")
            .set("Authorization", `Bearer ${alice}`)
            .send({ sessionId: next, message: "Count the rows, please." }),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("the local slot was never released")), 5000),
          ),
        ]);
        expect(res.status).toBe(200);
      } finally {
        await new Promise<void>((r) => live.close(() => r()));
      }
    });

    // PR #239 panel — a restart leaves the model catalog's discovery cache cold;
    // a sub-agent's saved local model must still be the one on the wire.
    it("local-gemma, cold catalog: the sub-agent runs on ITS saved model, the parent on the session's", async () => {
      __resetModelCatalogForTests();
      process.env.LOCAL_GEMMA_MAX_CONCURRENCY = "1";
      resetLocalConcurrencyLimitersForTests();
      await db.customAgent.update({ where: { id: IDS.helper }, data: { model: "qwen3:8b" } });
      try {
        setAIProviderForTests(PROVIDERS.find((p) => p.local)!.make());
        const created = await request(app())
          .post("/api/ai/sessions")
          .set("Authorization", `Bearer ${alice}`)
          .send({ projectId: IDS.project, agentId: IDS.lead, policy: { medium: "auto" } });
        const sid = created.body.data.session.id as string;
        const res = await request(app())
          .post("/api/ai/chat")
          .set("Authorization", `Bearer ${alice}`)
          .send({ sessionId: sid, message: "Count the rows, please." });
        expect(res.status, res.text.slice(0, 500)).toBe(200);
        const sub = seen.filter((s) => s.sub);
        expect(sub.length).toBe(2);
        for (const s of sub) expect(s.model).toBe("qwen3:8b");
        const sessionModel = created.body.data.session.model as string;
        expect(sessionModel).not.toBe("qwen3:8b");
        for (const s of seen.filter((x) => !x.sub)) expect(s.model).toBe(sessionModel);
        const [run] = await db.aISubAgentRun.findMany({ where: { sessionId: sid } });
        expect(run).toMatchObject({ status: "completed", model: "qwen3:8b", result: "sub done" });
        expect(maxInFlight).toBe(1);
      } finally {
        await db.customAgent.update({ where: { id: IDS.helper }, data: { model: null } });
      }
    });
  },
);
