/**
 * #1872 (epic #1866) — applicability for a requirement of a project in
 * workspace A reads workspace A's rules and nothing else, over a REAL SQLite
 * database (the real migration chain).
 *
 * The fixture holds both workspaces' rules, plus A's superseded revision and a
 * deleted A document, each with a rule. The model is a recording stub that
 * flags every rule it is shown; the retriever is a stub that returns B's rule
 * ids too, as a stale or crossed index would. Only A's current rules may reach
 * a prompt or the applicability set.
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

const { governingApplicabilityForProject } = await import("../src/lib/governing/applicability.js");
const { currentWorkspaceRules } = await import("../src/lib/governing/governing-store.js");
type AIProvider = import("../src/lib/ai/types.js").AIProvider;

function recordingModel() {
  const prompts: string[] = [];
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-4-5",
    offline: false,
    chat: async (messages: Array<{ content: unknown }>, o: { systemMessage?: string } = {}) => {
      const user = messages.map((m) => String(m.content)).join("\n");
      prompts.push(`${o.systemMessage ?? ""}\n${user}`);
      const handles = [...user.matchAll(/^(R\d+) \[/gm)].map((m) => m[1]);
      const content = user.includes("governing_rule_summaries")
        ? JSON.stringify({ rules: handles })
        : JSON.stringify({
            decisions: handles.map((h) => ({ rule: h, verdict: "applies", reason: "Shown." })),
          });
      return { content, model: "m", provider: "anthropic" };
    },
  } as unknown as AIProvider;
  return { provider, prompts };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1872 — applicability reads only the project's workspace's current rules (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const ids: Record<string, string> = {};

    async function documentWithRules(
      workspaceId: string,
      title: string,
      revisions: Array<{ label: string; rules: Array<{ controlId: string; summary: string }> }>,
    ) {
      const doc = await db.governingDocument.create({
        data: { workspaceId, title, createdById: "u1" },
      });
      let current = "";
      for (const rev of revisions) {
        const text = rev.rules.map((r) => `${r.controlId}: ${r.summary}`).join("\n\n");
        const row = await db.governingDocumentRevision.create({
          data: {
            documentId: doc.id,
            revisionLabel: rev.label,
            effectiveDate: new Date("2026-01-01"),
            storagePath: `${doc.id}/${rev.label}`,
            contentHash: `${doc.id}-${rev.label}`,
            mimeType: "text/markdown",
            sizeBytes: text.length,
            extractedText: text,
            indexState: "indexed",
            extractionState: "done",
            uploadedById: "u1",
          },
        });
        let at = 0;
        for (const r of rev.rules) {
          const rule = await db.governingRule.create({
            data: {
              revisionId: row.id,
              controlId: r.controlId,
              summary: r.summary,
              clauseRef: "§1",
              clauseStart: at,
              clauseEnd: at + r.summary.length,
              clauseExcerpt: r.summary,
            },
          });
          ids[r.controlId] = rule.id;
          at += r.summary.length + 2;
        }
        current = row.id;
      }
      await db.governingDocument.update({
        where: { id: doc.id },
        data: { currentRevisionId: current },
      });
      return doc.id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1872-applicability-scope");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u1", username: "u1872", displayName: "u", email: "u1872@example.test" },
      });
      await db.workspace.create({ data: { id: "ws_a1872", name: "A", slug: "a-1872" } });
      await db.workspace.create({ data: { id: "ws_b1872", name: "B", slug: "b-1872" } });
      await db.project.create({
        data: {
          id: "pr_a1872",
          name: "A project",
          slug: "a-project-1872",
          workspaceId: "ws_a1872",
          createdById: "u1",
        },
      });
      await db.project.create({
        data: { id: "pr_none1872", name: "Loose project", slug: "loose-1872", createdById: "u1" },
      });
      await documentWithRules("ws_a1872", "A policy", [
        { label: "v1", rules: [{ controlId: "A-OLD", summary: "A superseded obligation." }] },
        {
          label: "v2",
          rules: [
            { controlId: "A-LOG", summary: "A: log every read of customer records." },
            { controlId: "A-DEL", summary: "A: a rule an admin deleted." },
          ],
        },
      ]);
      await db.governingRule.update({
        where: { id: ids["A-DEL"] },
        data: { deletedAt: new Date() },
      });
      const gone = await documentWithRules("ws_a1872", "A deleted policy", [
        { label: "v1", rules: [{ controlId: "A-GONE", summary: "A: a deleted document's rule." }] },
      ]);
      await db.governingDocument.update({ where: { id: gone }, data: { deletedAt: new Date() } });
      await documentWithRules("ws_b1872", "B policy", [
        {
          label: "v1",
          rules: [
            { controlId: "B-LOG", summary: "B: log every read of customer records." },
            { controlId: "B-KEEP", summary: "B: keep invoices for seven years." },
          ],
        },
      ]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      delete process.env.GOVERNING_DOCS_ENABLED;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("currentWorkspaceRules returns only the current revision's live rules of the workspace's live documents", async () => {
      const a = await currentWorkspaceRules("ws_a1872");
      expect(a.map((r) => r.controlId)).toEqual(["A-LOG"]);
      expect(a[0]).toMatchObject({ revisionLabel: "v2", documentTitle: "A policy" });
      const b = await currentWorkspaceRules("ws_b1872");
      expect(b.map((r) => r.controlId).sort()).toEqual(["B-KEEP", "B-LOG"]);
      expect(await currentWorkspaceRules("ws_none")).toEqual([]);
    });

    it("a requirement of workspace A's project is screened and judged against A's rules only", async () => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      const { provider, prompts } = recordingModel();
      const hook = await governingApplicabilityForProject({
        projectId: "pr_a1872",
        provider,
        // A crossed index: B's rule ids, and A's superseded and deleted ones.
        retrieve: async () => [ids["B-LOG"]!, ids["B-KEEP"]!, ids["A-OLD"]!, ids["A-GONE"]!],
      });
      expect(hook).toMatchObject({ workspaceId: "ws_a1872", rules: 1 });
      const set = await hook!.decide({ id: "REQ-1", text: "Export customer records as CSV." });
      expect(set.decisions.map((d) => d.ruleId)).toEqual([ids["A-LOG"]]);
      expect(set.rulesScreened).toBe(1);
      expect(prompts.length).toBeGreaterThan(0);
      for (const p of prompts) {
        expect(p).toContain("A-LOG");
        for (const other of ["B-LOG", "B-KEEP", "B:", "A-OLD", "A-DEL", "A-GONE"]) {
          expect(p).not.toContain(other);
        }
      }
    });

    it("a project with no workspace is skipped", async () => {
      process.env.GOVERNING_DOCS_ENABLED = "1";
      const { provider, prompts } = recordingModel();
      expect(
        await governingApplicabilityForProject({ projectId: "pr_none1872", provider }),
      ).toBeNull();
      expect(prompts).toEqual([]);
    });
  },
);
