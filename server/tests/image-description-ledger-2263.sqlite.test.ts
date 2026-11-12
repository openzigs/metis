/**
 * #2263 — Word image descriptions are project spend. Up to 20 vision calls per ingest wrote no
 * `token_usages` row and skipped `assertWithinBudget`, so uploads could exceed a project's
 * monthly budget and the spend never showed on the usage page.
 *
 * Here the real project describer converts the BRD fixture over a real migrated SQLite
 * database, and the spend is read back through `summarizeUsage` (what the usage page reads);
 * then the project's budget is set to what it has used, and the next conversion is refused.
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
import type { AIProvider, ChatChunk } from "../src/lib/ai/types.js";
import { buildBrdDocx } from "./fixtures/docx-2232.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/prisma.js")>()),
  get prisma() {
    return state.db;
  },
}));

const { docxToMarkdown } = await import("../src/lib/documents/docx-to-markdown.js");
const { projectImageDescriber, IMAGE_DESCRIPTION_AGENT_STEP } =
  await import("../src/lib/documents/image-description.js");
const { summarizeUsage } = await import("../src/lib/finops/budget-enforcer.js");

const PROJECT = "p-2263";
const USER = "u-2263";
const MODEL = "claude-sonnet-4-6";
const CALL = { promptTokens: 1_500, completionTokens: 120, totalTokens: 1_620 };

function visionProvider(): AIProvider & { calls: number } {
  const p = {
    key: "anthropic" as const,
    model: MODEL,
    offline: false,
    calls: 0,
    capabilities: { responseFormat: false, nativeToolCalls: false },
    capabilitiesFor: () => ({ responseFormat: false, nativeToolCalls: false, vision: true }),
    async *stream(): AsyncGenerator<ChatChunk> {
      p.calls += 1;
      yield { type: "delta", content: "A login form." };
      yield { type: "usage", usage: { ...CALL }, model: MODEL };
      yield { type: "done" };
    },
  };
  return p as unknown as AIProvider & { calls: number };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2263 — Word image descriptions are metered and budgeted (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2263-image-description");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJECT, name: PROJECT, slug: PROJECT, createdById: USER },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("writes the description's usage where the usage page reads it, then stops at the budget", async () => {
      const provider = visionProvider();
      const describe = () =>
        projectImageDescriber({ projectId: PROJECT, documentId: "doc-1" }, async () => provider);

      const first = await docxToMarkdown(await buildBrdDocx(), { describeImage: describe() });
      expect(first.markdown).toContain(
        '> **Image 1** (image1.png, alt text "Login wireframe"): A login form.',
      );
      expect(provider.calls).toBe(1);

      // The describer awaits its own write; the summary bounds its window with `lt: now`.
      await new Promise((r) => setTimeout(r, 2));
      const summary = await summarizeUsage(PROJECT);
      expect(summary.totalTokens).toBe(CALL.totalTokens);
      expect(summary.byProvider).toEqual([
        expect.objectContaining({ provider: "anthropic", model: MODEL, totalTokens: 1_620 }),
      ]);
      const rows = await db.tokenUsage.findMany({ where: { projectId: PROJECT } });
      expect(rows).toEqual([
        expect.objectContaining({
          sessionId: "document:doc-1",
          agentStep: IMAGE_DESCRIPTION_AGENT_STEP,
          inputTokens: CALL.promptTokens,
          outputTokens: CALL.completionTokens,
        }),
      ]);

      // The month's usage now meets the budget: the next ingest's image is not sent.
      await db.project.update({
        where: { id: PROJECT },
        data: { monthlyTokenBudget: CALL.totalTokens },
      });
      const second = await docxToMarkdown(await buildBrdDocx(), { describeImage: describe() });
      expect(provider.calls).toBe(1);
      expect(second.markdown).toContain(
        "image not read: the project's monthly token budget is spent.",
      );
      expect(second.markdown).toContain("Session timeout is 15 minutes.");
    });
  },
);
