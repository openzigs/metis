/**
 * #2226 — what a discussion AI reply is shown, against a REAL SQLite database
 * built by the migration chain. The route and responder suites mock Prisma, so
 * they cannot tell whether an `orderBy`/`take` pair returns the newest rows or
 * whether an anchor read stays inside the thread's project. This pins that:
 *
 * - on a 25-message thread the reply sees the LAST 20 prior messages, oldest
 *   to newest — not the first 20, which is what `createdAt asc, take 20` read;
 * - a thread anchored to a requirement puts that requirement's CURRENT title,
 *   body and acceptance criteria in the prompt, as a user turn (never system);
 * - an anchor pointing outside the thread's project, a soft-deleted
 *   requirement, or one whose analysis is soft-deleted, adds nothing;
 * - a thread anchored to an analysis shows its status and requirement titles.
 *
 * #2249 adds: the history window ends at the trigger (a later message is not
 * history, a createdAt tie is broken by id); a thread anchored to a Spec Kit
 * feature shows its spec summary as a user turn; and a thread with several
 * anchors shows every live one.
 *
 * The provider is a capturing double: nothing calls a model. SQLite-only (a
 * Postgres-generated client rejects the better-sqlite3 adapter); the `api` CI
 * job builds the SQLite client, so this runs on every PR.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { AIProvider, ChatChunk, ChatMessage } from "../src/lib/ai/types.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
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
// The budget gate and the usage ledgers are not what this pins.
vi.mock("../src/lib/finops/budget-enforcer.js", async (original) => ({
  ...(await original<typeof import("../src/lib/finops/budget-enforcer.js")>()),
  assertWithinBudget: async () => undefined,
}));
vi.mock("../src/lib/finops/token-tracker.js", () => ({ recordUsage: vi.fn() }));

const { streamAIReply } = await import("../src/lib/discussions/ai-responder.js");
const { loadRecentHistory, loadThreadAnchors } =
  await import("../src/lib/discussions/thread-context.js");

const ALICE = "u-alice";
const THREAD_LENGTH = 25;
const msgId = (n: number) => `m${String(n).padStart(2, "0")}`;

/** A provider that records the messages it is sent and answers "ok". */
function capturingProvider(): AIProvider & { sent: ChatMessage[][] } {
  const sent: ChatMessage[][] = [];
  return {
    key: "offline-stub",
    model: "offline-stub",
    offline: true,
    sent,
    async chat() {
      throw new Error("not used");
    },
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      sent.push(messages);
      yield { type: "delta", content: "ok" };
      yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      yield { type: "done" };
    },
    async embed() {
      return { vectors: [], dimension: 0, model: "x" };
    },
    async models() {
      return [];
    },
    async ping() {
      return true;
    },
  } as unknown as AIProvider & { sent: ChatMessage[][] };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "discussion AI reply context (real SQLite) (#2226)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    async function reply(threadId: string, triggerId = "trigger") {
      const provider = capturingProvider();
      await streamAIReply({
        thread: { id: threadId, projectId: "p-1", aiResponseMode: "on_mention" },
        triggerMessage: { id: triggerId, body: "@AI what do you think?" },
        actor: { id: ALICE },
        provider,
        history: await loadRecentHistory(threadId, triggerId),
      });
      return provider.sent[0]!;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("discussion-ai-context-2226");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: ALICE, username: ALICE, displayName: "Alice", email: "a@example.test" },
      });
      for (const p of ["p-1", "p-2"]) {
        await db.project.create({ data: { id: p, name: p, slug: p, createdById: ALICE } });
        await db.analysis.create({ data: { id: `a-${p}`, projectId: p, status: "completed" } });
      }
      await db.analysis.create({
        data: { id: "a-gone", projectId: "p-1", deletedAt: new Date() },
      });
      const requirement = (
        id: string,
        projectId: string,
        analysisId: string,
        extra: Record<string, unknown> = {},
      ) =>
        db.requirement.create({
          data: {
            id,
            projectId,
            analysisId,
            title: `title of ${id}`,
            body: `body of ${id}`,
            ...extra,
          },
        });
      await requirement("r-1", "p-1", "a-p-1", {
        title: "Refresh feeds every 15 minutes",
        body: "The scheduler refreshes each feed on a 15-minute cadence.",
        acceptanceCriteria: JSON.stringify([
          "A feed is refreshed within 15 minutes",
          "Errors are logged",
        ]),
        createdAt: new Date(Date.UTC(2026, 0, 1)),
      });
      await requirement("r-2", "p-1", "a-p-1", { createdAt: new Date(Date.UTC(2026, 0, 2)) });
      await requirement("r-deleted", "p-1", "a-p-1", { deletedAt: new Date() });
      await requirement("r-gone-analysis", "p-1", "a-gone");
      await requirement("r-other", "p-2", "a-p-2", { title: "SECRET other-project requirement" });

      const thread = (id: string, data: Record<string, unknown> = {}) =>
        db.discussionThread.create({ data: { id, projectId: "p-1", createdById: ALICE, ...data } });
      await thread("t-long");
      await thread("t-req", { requirementId: "r-1" });
      await thread("t-cross", { requirementId: "r-other" });
      await thread("t-deleted", { requirementId: "r-deleted" });
      await thread("t-gone-analysis", { requirementId: "r-gone-analysis" });
      await thread("t-analysis", { analysisId: "a-p-1" });
      await thread("t-other-analysis", { analysisId: "a-p-2" });

      // #2249 — Spec Kit features: one with a spec, one without, one elsewhere.
      await db.specKitFeature.create({
        data: {
          id: "f-1",
          projectId: "p-1",
          slug: "004-csv-export",
          title: "CSV export",
          status: "specified",
        },
      });
      await db.specKitFeatureArtifact.create({
        data: {
          featureId: "f-1",
          key: "spec.md",
          content: [
            "# Spec",
            "Analysts export requirements as CSV.",
            "## Stakeholders",
            "- Business analysts",
          ].join("\n"),
        },
      });
      await db.specKitFeature.create({
        data: { id: "f-bare", projectId: "p-1", slug: "005-bare", title: "Bare" },
      });
      await db.specKitFeature.create({
        data: { id: "f-other", projectId: "p-2", slug: "001-secret", title: "SECRET feature" },
      });
      await thread("t-feature", { specKitFeatureId: "f-1" });
      await thread("t-feature-bare", { specKitFeatureId: "f-bare" });
      await thread("t-other-feature", { specKitFeatureId: "f-other" });
      await thread("t-both", {
        requirementId: "r-2",
        analysisId: "a-p-1",
        specKitFeatureId: "f-1",
      });
      await thread("t-deleted-and-analysis", { requirementId: "r-deleted", analysisId: "a-p-1" });

      // A createdAt tie with the trigger, broken by id either side of it.
      await thread("t-tie");
      const tieAt = new Date(Date.UTC(2026, 0, 2));
      for (const [id, body] of [
        ["m-tie-a", "tie a"],
        ["trigger-tie", "@AI tie?"],
        ["z-tie", "tie z"],
      ] as const) {
        await db.discussionMessage.create({
          data: {
            id,
            threadId: "t-tie",
            authorKind: "human",
            authorUserId: ALICE,
            body,
            createdAt: tieAt,
          },
        });
      }

      // Inserted in REVERSE so insertion order disagrees with createdAt order.
      const base = Date.UTC(2026, 0, 1);
      for (let n = THREAD_LENGTH; n >= 1; n--) {
        await db.discussionMessage.create({
          data: {
            id: msgId(n),
            threadId: "t-long",
            authorKind: "human",
            authorUserId: ALICE,
            body: `message ${n}`,
            createdAt: new Date(base + n * 1000),
          },
        });
      }
      // The trigger, newest of all, and a deleted message among the recent ones.
      await db.discussionMessage.create({
        data: {
          id: "trigger",
          threadId: "t-long",
          authorKind: "human",
          authorUserId: ALICE,
          body: "@AI what do you think?",
          createdAt: new Date(base + 100_000),
        },
      });
      await db.discussionMessage.update({
        where: { id: msgId(24) },
        data: { deletedAt: new Date() },
      });
      // #2249 — posted after the trigger (a concurrent @AI, a retry): not history.
      await db.discussionMessage.create({
        data: {
          id: "after",
          threadId: "t-long",
          authorKind: "human",
          authorUserId: ALICE,
          body: "after trigger",
          createdAt: new Date(base + 200_000),
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a 25-message thread: the reply sees the most recent 20 prior messages, oldest first", async () => {
      const history = await loadRecentHistory("t-long", "trigger");
      // 25 messages, one deleted (24): the newest 20 live ones are 5…23 and 25.
      const expected = [...Array.from({ length: 19 }, (_, i) => i + 5), 25].map(
        (n) => `message ${n}`,
      );
      expect(history.map((h) => h.body)).toEqual(expected);

      const sent = await reply("t-long");
      const bodies = sent.map((m) => m.content);
      expect(bodies).toContain("message 25");
      expect(bodies).not.toContain("message 1");
      expect(bodies).not.toContain("message 24");
      // The question is still the last turn, after the newest history.
      expect(bodies.at(-1)).toBe("@AI what do you think?");
      expect(bodies.at(-2)).toBe("message 25");
    });

    it("an anchored requirement's current title, body and criteria reach the prompt as a user turn", async () => {
      const first = await reply("t-req");
      const anchorTurn = first.find((m) => String(m.content).includes("Refresh feeds every 15"));
      expect(anchorTurn?.role).toBe("user");
      expect(anchorTurn?.content).toContain(
        "The scheduler refreshes each feed on a 15-minute cadence.",
      );
      expect(anchorTurn?.content).toContain("- A feed is refreshed within 15 minutes");
      expect(anchorTurn?.content).toContain("- Errors are logged");
      const systemText = first
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n");
      expect(systemText).not.toContain("Refresh feeds every 15");

      // The requirement is editable: the next reply reads it as it is now.
      await db.requirement.update({
        where: { id: "r-1" },
        data: { title: "Refresh feeds every 5 minutes", acceptanceCriteria: "[]" },
      });
      const second = await reply("t-req");
      const text = second.map((m) => m.content).join("\n");
      expect(text).toContain("Requirement: Refresh feeds every 5 minutes");
      expect(text).not.toContain("every 15 minutes\n");
      expect(text).toContain("Acceptance criteria: none recorded.");
    });

    it("an anchor outside the thread's project, or a deleted one, adds nothing", async () => {
      for (const t of [
        "t-cross",
        "t-deleted",
        "t-gone-analysis",
        "t-other-analysis",
        "t-other-feature",
      ]) {
        expect(await loadThreadAnchors({ id: t, projectId: "p-1" }), t).toEqual([]);
      }
      const text = (await reply("t-cross")).map((m) => m.content).join("\n");
      expect(text).not.toContain("SECRET other-project requirement");
      expect(text).not.toContain("Context: this discussion is about");
      // A thread read under the wrong project is no anchor either.
      expect(await loadThreadAnchors({ id: "t-req", projectId: "p-2" })).toEqual([]);
    });

    it("an anchored analysis shows its status and its live requirements' titles", async () => {
      // r-1 first (oldest), whatever the requirement test above renamed it to;
      // the deleted requirement and the other project's are not counted.
      const r1 = await db.requirement.findUniqueOrThrow({ where: { id: "r-1" } });
      const anchors = await loadThreadAnchors({ id: "t-analysis", projectId: "p-1" });
      expect(anchors).toEqual([
        {
          kind: "analysis",
          status: "completed",
          completedAt: null,
          requirementCount: 2,
          requirementTitles: [r1.title, "title of r-2"],
        },
      ]);
      const text = (await reply("t-analysis")).map((m) => m.content).join("\n");
      expect(text).toContain("Analysis status: completed");
      expect(text).toContain("- title of r-2");
    });

    it("#2249 — a message posted after the trigger is not in the reply's history", async () => {
      // On t-long, "after trigger" is the newest message of all, but the reply
      // answers the trigger: the window ends there.
      const history = await loadRecentHistory("t-long", "trigger");
      expect(history.map((h) => h.body)).not.toContain("after trigger");
      expect(history.at(-1)?.body).toBe("message 25");
      // A tie on createdAt is decided by id, as the ordering is: "m-tie-a"
      // sorts before "trigger-tie", "z-tie" after it.
      const tied = await loadRecentHistory("t-tie", "trigger-tie");
      expect(tied.map((h) => h.body)).toEqual(["tie a"]);
      // A trigger from another thread has no history here.
      expect(await loadRecentHistory("t-long", "trigger-tie")).toEqual([]);
    });

    it("#2282 — a Teams reply's history starts at the link: nothing written before it", async () => {
      // Linked between message 21 and 22 (message n is at base + n s).
      const since = new Date(Date.UTC(2026, 0, 1) + 21_500);
      const history = await loadRecentHistory("t-long", "trigger", { since });
      expect(history.map((h) => h.body)).toEqual(["message 22", "message 23", "message 25"]);
      // A message written at the link itself counts.
      const atLink = await loadRecentHistory("t-long", "trigger", {
        since: new Date(Date.UTC(2026, 0, 1) + 22_000),
      });
      expect(atLink.map((h) => h.body)).toEqual(["message 22", "message 23", "message 25"]);
    });

    it("#2249 — an anchored Spec Kit feature's spec summary reaches the prompt as a user turn", async () => {
      const sent = await reply("t-feature");
      const turn = sent.find((m) => String(m.content).includes("Spec Kit feature:"));
      expect(turn?.role).toBe("user");
      expect(turn?.content).toContain("Spec Kit feature: 004-csv-export — CSV export");
      expect(turn?.content).toContain("Status: specified");
      expect(turn?.content).toContain("Spec summary:\nAnalysts export requirements as CSV.");
      expect(turn?.content).not.toContain("Business analysts");
      const systemText = sent
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n");
      expect(systemText).not.toContain("CSV export");

      // A feature with no spec.md yet still names itself.
      const bare = (await reply("t-feature-bare")).map((m) => m.content).join("\n");
      expect(bare).toContain("Spec Kit feature: 005-bare — Bare");
      expect(bare).toContain("Spec summary: no spec written yet.");
    });

    it("#2249 — every live anchor is shown, in order; a gone one is left out", async () => {
      const both = await loadThreadAnchors({ id: "t-both", projectId: "p-1" });
      expect(both.map((a) => a.kind)).toEqual(["requirement", "analysis", "specKitFeature"]);
      const text = (await reply("t-both")).map((m) => m.content).join("\n");
      expect(text).toContain("Requirement: title of r-2");
      expect(text).toContain("Analysis status: completed");
      expect(text).toContain("Spec Kit feature: 004-csv-export");

      // The requirement is deleted: the analysis is shown as it always was,
      // and nothing stands in for the requirement.
      const partial = await loadThreadAnchors({ id: "t-deleted-and-analysis", projectId: "p-1" });
      expect(partial.map((a) => a.kind)).toEqual(["analysis"]);
    });
  },
);
