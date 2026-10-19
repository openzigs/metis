/**
 * #1252 — the requirement writers #1230 left out. Each one can change which
 * approved requirements a reader BRD lists, mostly by moving the run the
 * Requirements hub opens on (`defaultRequirementsRunIdFor`), so each asks the
 * auto-update check to look again after its write commits; or, for review
 * submit / withdraw / close, is shown here not to change the approved set.
 *
 * Every writer has its own test: removing its call fails that test alone
 * (`noteProjectRequirementsChanged` is the shared helper, so a test of the
 * helper would not notice a call site going missing).
 *
 * The real writers against a real migrated SQLite database; only the check
 * itself, notifications, audit and the source API are faked.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown, check: vi.fn(), layout: vi.fn() };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    resolveDatabaseProvider: () => "sqlite" as const,
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/audit/audit-service.js")>()),
  audit: vi.fn(),
}));
vi.mock("../src/lib/reviews/notify.js", () => ({
  dispatchReviewSubmitted: vi.fn(),
  dispatchReviewDecision: vi.fn(),
}));
vi.mock("../src/lib/docs-gen/incremental.js", () => ({
  checkIncrementalRegeneration: state.check,
}));
vi.mock("../src/lib/docs-gen/brd-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/docs-gen/brd-layout.js")>()),
  readBrdLayoutSetting: state.layout,
}));

const {
  finalizeAnalysisDelta,
  markAnalysisCompleted,
  markAnalysisRunning,
  persistRequirements,
  settleRunningAnalysisAsFailed,
} = await import("../src/lib/analysis/analysis-service.js");
const { defaultRequirementsRunIdFor } = await import("../src/lib/analysis/requirement-runs.js");
const { ImportService } = await import("../src/lib/importers/import-service.js");
const { promoteMessageToRequirement } = await import("../src/lib/discussions/promote.js");
const { createReviewRequest, submitReview, withdrawReview, closeReview } =
  await import("../src/lib/reviews/review-service.js");
const { approvedRequirementsFacts, loadApprovedRequirements } =
  await import("../src/lib/docs-gen/approved-requirements-section.js");
const { approvedRequirementsOutOfDate } =
  await import("../src/lib/docs-gen/approved-requirements-currency.js");
const { approvedRequirementsItem } = await import("../src/lib/docs-gen/generation-inputs.js");
const { APPROVED_REQUIREMENTS_ITEM, fingerprintInputs } =
  await import("../src/lib/docs-gen/regeneration-plan.js");
const { legacyGeneratedDocVersionManifest } =
  await import("../src/lib/docs-gen/generated-doc-provenance.js");

const USER = "u-1252";
const REVIEWER = "u-1252-rev";
const NO_TOKENS = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
/** Let any stray post-commit work run before asserting nothing ran. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1252 — the remaining requirement writers and a reader BRD's approved requirements (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;

    /** A project of its own per test, so one test's runs never move another's default run. */
    const makeProject = async () => {
      seq += 1;
      const id = `proj-1252-${seq}`;
      await db.project.create({
        data: { id, name: id, slug: id, createdById: USER, workspaceId: "ws-1252" },
      });
      return id;
    };
    const makeAnalysis = async (projectId: string, status = "completed") => {
      seq += 1;
      const row = await db.analysis.create({
        data: {
          id: `ana-1252-${seq}`,
          projectId,
          startedById: USER,
          status,
          startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
        },
      });
      return row.id;
    };
    const makeRequirement = async (
      projectId: string,
      analysisId: string,
      data: Record<string, unknown> = {},
    ) => {
      seq += 1;
      const row = await db.requirement.create({
        data: {
          id: `req-1252-${seq}`,
          projectId,
          analysisId,
          title: `Requirement ${seq}`,
          body: "The body",
          ...data,
        },
      });
      return row.id;
    };
    const checked = (projectId: string) => [
      projectId,
      undefined,
      { approvedRequirementsOnly: true },
    ];
    const synthesized = (title: string) =>
      ({
        requirements: [
          {
            type: "feature",
            title,
            body: "Synthesized",
            priority: "high",
            labels: [],
            evidenceFindingIndexes: [],
            acceptanceCriteria: [],
          },
        ],
      }) as unknown as Parameters<typeof persistRequirements>[0]["synthesis"];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1252-reader-brd-staleness");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const id of [USER, REVIEWER]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1252", name: "ws", slug: "ws-1252" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1252", userId: USER, role: "owner" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      state.check.mockReset();
      state.check.mockResolvedValue(undefined);
      state.layout.mockReturnValue({ layout: "reader" });
    });

    describe("a run's requirement set saved or replaced (persistRequirements)", () => {
      it("asks for the check after the set commits", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project);
        await persistRequirements({
          analysisId: analysis,
          projectId: project,
          synthesis: synthesized("A new requirement"),
          findingIdsByIndex: [],
        });
        expect(await db.requirement.count({ where: { analysisId: analysis } })).toBe(1);
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
      });

      it("asks for nothing when the replacement is withheld (#769): the set did not change", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project);
        // An analyst's approval is review work a replacement may not destroy.
        await makeRequirement(project, analysis, { reviewStatus: "approved" });
        const onWithheld = vi.fn();
        await persistRequirements({
          analysisId: analysis,
          projectId: project,
          synthesis: synthesized("Would replace it"),
          findingIdsByIndex: [],
          onWithheld,
        });
        expect(onWithheld).toHaveBeenCalledTimes(1);
        await settle();
        expect(state.check).not.toHaveBeenCalled();
      });
    });

    describe("a re-run (regenerate or repo resume) of the run Requirements opens on (PR #1267 review)", () => {
      /**
       * Two completed runs, each with an approved requirement, and the newer
       * one (the default) re-opened as a follow-up does it: `running` again,
       * its earlier `completedAt` kept.
       */
      const reopenedDefault = async (newerReviewStatus: string | null = "approved") => {
        const project = await makeProject();
        const older = await makeAnalysis(project);
        await makeRequirement(project, older, { reviewStatus: "approved", title: "Older run" });
        const newer = await makeAnalysis(project);
        await db.analysis.update({ where: { id: newer }, data: { completedAt: new Date() } });
        await makeRequirement(project, newer, {
          reviewStatus: newerReviewStatus,
          title: "Newer run",
        });
        expect(await defaultRequirementsRunIdFor(project)).toBe(newer);
        await markAnalysisRunning(newer);
        return { project, older, newer };
      };

      it("keeps the re-opened run as the one Requirements opens on, so a reader BRD lists it meanwhile", async () => {
        const { project, newer } = await reopenedDefault();
        expect(await defaultRequirementsRunIdFor(project)).toBe(newer);
        expect(
          JSON.parse(approvedRequirementsFacts(await loadApprovedRequirements(project))),
        ).toEqual([expect.objectContaining({ title: "Newer run" })]);
      });

      it("saving the re-run's set asks for nothing while it runs; its settle asks once", async () => {
        // Draft rows only: no review work, so the re-run's set really is replaced (#769).
        const { project, newer } = await reopenedDefault(null);
        await persistRequirements({
          analysisId: newer,
          projectId: project,
          synthesis: synthesized("Re-run requirement"),
          findingIdsByIndex: [],
        });
        expect(
          (await db.requirement.findMany({ where: { analysisId: newer } })).map((r) => r.title),
        ).toEqual(["Re-run requirement"]);
        await settle();
        expect(state.check).not.toHaveBeenCalled();
        await finalizeAnalysisDelta({ id: newer, status: "completed", delta: NO_TOKENS });
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
        await settle();
        expect(state.check).toHaveBeenCalledTimes(1);
      });

      it("does not mark an unchanged reader BRD out of date while the run is re-run", async () => {
        const project = await makeProject();
        const older = await makeAnalysis(project);
        await makeRequirement(project, older, { reviewStatus: "approved", title: "Older run" });
        const newer = await makeAnalysis(project);
        await db.analysis.update({ where: { id: newer }, data: { completedAt: new Date() } });
        await makeRequirement(project, newer, { reviewStatus: "approved", title: "Newer run" });
        const doc = await db.generatedDocument.create({
          data: { projectId: project, title: "BRD", scope: "full", status: "ready" },
        });
        await db.generatedDocumentVersion.create({
          data: {
            documentId: doc.id,
            version: 1,
            content: "# BRD",
            provenanceManifest: JSON.stringify({
              ...legacyGeneratedDocVersionManifest({
                projectId: project,
                generatedDocumentId: doc.id,
                version: 1,
              }),
              inputSnapshot: fingerprintInputs({
                [APPROVED_REQUIREMENTS_ITEM]: await approvedRequirementsItem(project),
              }),
            }),
          },
        });
        await markAnalysisRunning(newer);
        expect(
          await approvedRequirementsOutOfDate(
            await db.generatedDocument.findUniqueOrThrow({ where: { id: doc.id } }),
          ),
        ).toBe(false);
      });
    });

    describe("an analysis run's status settling (the default run can move)", () => {
      it("a run completing asks for the check (markAnalysisCompleted)", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project, "running");
        await markAnalysisCompleted(analysis, NO_TOKENS);
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
      });

      it("a re-run settling asks for the check (finalizeAnalysisDelta), completed or failed", async () => {
        for (const status of ["completed", "failed"] as const) {
          state.check.mockClear();
          const project = await makeProject();
          const analysis = await makeAnalysis(project, "running");
          await finalizeAnalysisDelta({ id: analysis, status, delta: NO_TOKENS });
          await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
        }
      });

      it("a re-run settled as failed after its own write failed asks for the check; a no-op settle does not", async () => {
        const project = await makeProject();
        const settled = await makeAnalysis(project, "running");
        expect(
          await settleRunningAnalysisAsFailed({ id: settled, delta: NO_TOKENS, errorMessage: "x" }),
        ).toBe(true);
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));

        state.check.mockClear();
        const other = await makeProject();
        const done = await makeAnalysis(other, "completed");
        expect(
          await settleRunningAnalysisAsFailed({ id: done, delta: NO_TOKENS, errorMessage: "x" }),
        ).toBe(false);
        await settle();
        expect(state.check).not.toHaveBeenCalled();
      });

      it("a settle that committed still reports it when reading its project for the check fails", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project, "running");
        const read = vi
          .spyOn(db.analysis, "findUnique")
          .mockRejectedValueOnce(new Error("connection lost") as never);
        try {
          expect(
            await settleRunningAnalysisAsFailed({
              id: analysis,
              delta: NO_TOKENS,
              errorMessage: "x",
            }),
          ).toBe(true);
        } finally {
          read.mockRestore();
        }
        expect(await db.analysis.findUniqueOrThrow({ where: { id: analysis } })).toMatchObject({
          status: "failed",
        });
      });
    });

    describe("import creating requirements (ImportService.runSource)", () => {
      const issues = [
        {
          number: 7,
          title: "Export orders",
          body: "As imported",
          html_url: "https://github.com/o/r/issues/7",
          state: "open",
          labels: [],
        },
      ];
      const service = () =>
        new ImportService({
          prisma: db,
          vault: {
            create: vi.fn(),
            read: vi.fn(async () => ({ summary: {} as never, plaintext: "tok" })),
            delete: vi.fn(),
          },
          enqueueTask: vi.fn(async () => ({ id: "task_1" })),
          createScheduledJob: vi.fn(async () => ({ id: "job_1" })),
          deleteScheduledJob: vi.fn(async () => undefined),
          resolveJira: vi.fn(),
          importerDeps: {
            fetchFn: vi.fn(async (url: string | URL | Request) =>
              String(url).includes("/graphql")
                ? res(200, { data: { search: { issueCount: issues.length } } })
                : res(200, issues),
            ),
            assertHostAllowed: () => undefined,
            backoff: { sleep: async () => undefined, now: () => 0, random: () => 0 },
          },
        } as unknown as ConstructorParameters<typeof ImportService>[0]);

      it("asks for the check once when a run creates requirements; a run that creates none does not", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project);
        const source = await db.importSource.create({
          data: {
            projectId: project,
            analysisId: analysis,
            source: "github",
            label: "GH",
            filter: JSON.stringify({ owner: "o", repo: "r", state: "open" }),
            secretId: "secret_1",
            createdById: USER,
          },
        });
        const svc = service();
        const first = await svc.runSource(source.id, { trigger: "manual" });
        expect(first).toMatchObject({ status: "completed", createdCount: 1 });
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
        await settle();
        expect(state.check).toHaveBeenCalledTimes(1);

        state.check.mockClear();
        const again = await svc.runSource(source.id, { trigger: "manual" });
        expect(again).toMatchObject({ status: "completed", createdCount: 0 });
        await settle();
        expect(state.check).not.toHaveBeenCalled();
      });
    });

    describe("a discussion promoted to a requirement (promoteMessageToRequirement)", () => {
      it("asks for the check after the requirement commits", async () => {
        const project = await makeProject();
        const thread = await db.discussionThread.create({
          data: { projectId: project, createdById: USER },
        });
        const message = await db.discussionMessage.create({
          data: { threadId: thread.id, authorKind: "human", authorUserId: USER, body: "Do X" },
        });
        const result = await promoteMessageToRequirement({
          actor: { id: USER, role: "admin" } as never,
          threadId: thread.id,
          messageId: message.id,
          title: "Promoted",
        });
        expect(await db.requirement.count({ where: { id: result.requirementId } })).toBe(1);
        await vi.waitFor(() => expect(state.check).toHaveBeenCalledWith(...checked(project)));
      });
    });

    describe("review submit, withdraw and close (#989: an approved requirement stays approved)", () => {
      it("never change the approved set, so they ask for nothing", async () => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project);
        const approved = await makeRequirement(project, analysis, {
          reviewStatus: "approved",
          version: 0,
        });
        const rejected = await makeRequirement(project, analysis, {
          reviewStatus: "rejected",
          version: 0,
        });
        const approvedSet = async () =>
          approvedRequirementsFacts(await loadApprovedRequirements(project));
        const before = await approvedSet();
        expect(JSON.parse(before)).toEqual([expect.objectContaining({ id: approved })]);

        for (const settleReview of [withdrawReview, closeReview]) {
          const created = (await createReviewRequest(USER, project, {
            title: "Sign-off",
            policy: "all",
            reviewerIds: [REVIEWER],
            items: [{ requirementId: approved }, { requirementId: rejected }],
          })) as { id: string };
          await submitReview(USER, created.id, false);
          // The submit moved the rejected one to awaiting review, not the approved one.
          expect(await db.requirement.findUniqueOrThrow({ where: { id: rejected } })).toMatchObject(
            { reviewStatus: "draft" },
          );
          expect(await approvedSet()).toBe(before);
          await settleReview(USER, created.id, true);
          expect(await db.requirement.findUniqueOrThrow({ where: { id: rejected } })).toMatchObject(
            { reviewStatus: "rejected" },
          );
          expect(await approvedSet()).toBe(before);
        }
        await settle();
        expect(state.check).not.toHaveBeenCalled();
      });
    });

    describe("a reader BRD without auto-update is marked out of date (approvedRequirementsOutOfDate)", () => {
      /** A published reader BRD whose latest version recorded the approvals as they are now. */
      const publishedReaderBrd = async (over: Record<string, unknown> = {}) => {
        const project = await makeProject();
        const analysis = await makeAnalysis(project);
        const approved = await makeRequirement(project, analysis, {
          reviewStatus: "approved",
          version: 0,
        });
        const draft = await makeRequirement(project, analysis, { version: 0 });
        const doc = await db.generatedDocument.create({
          data: {
            projectId: project,
            title: "Business requirements",
            scope: "full",
            scopeFilter: "{}",
            status: "ready",
            autoUpdate: false,
            ...over,
          },
        });
        const manifest = {
          ...legacyGeneratedDocVersionManifest({
            projectId: project,
            generatedDocumentId: doc.id,
            version: 1,
          }),
          inputSnapshot: fingerprintInputs({
            settings: "s",
            [APPROVED_REQUIREMENTS_ITEM]: await approvedRequirementsItem(project),
          }),
        };
        await db.generatedDocumentVersion.create({
          data: {
            documentId: doc.id,
            version: 1,
            content: "# BRD",
            provenanceManifest: JSON.stringify(manifest),
          },
        });
        return { project, approved, draft, doc };
      };
      const outOfDate = async (docId: string) =>
        approvedRequirementsOutOfDate(
          await db.generatedDocument.findUniqueOrThrow({ where: { id: docId } }),
        );

      it("is not out of date while nothing changed", async () => {
        const { doc } = await publishedReaderBrd();
        expect(await outOfDate(doc.id)).toBe(false);
      });

      it("is out of date once a requirement is approved, or an approved one edited", async () => {
        const first = await publishedReaderBrd();
        await db.requirement.update({
          where: { id: first.draft },
          data: { reviewStatus: "approved" },
        });
        expect(await outOfDate(first.doc.id)).toBe(true);

        const second = await publishedReaderBrd();
        await db.requirement.update({
          where: { id: second.approved },
          data: { title: "Renamed by the analyst" },
        });
        expect(await outOfDate(second.doc.id)).toBe(true);
      });

      it("ignores what the section does not show: a version bump, a draft edited", async () => {
        const { approved, draft, doc } = await publishedReaderBrd();
        await db.requirement.update({ where: { id: approved }, data: { version: 7 } });
        await db.requirement.update({ where: { id: draft }, data: { title: "Draft edit" } });
        expect(await outOfDate(doc.id)).toBe(false);
      });

      it.each<[string, Record<string, unknown>]>([
        ["has auto-update (the check regenerates it)", { autoUpdate: true }],
        ["is generating (the run captures afresh)", { status: "generating" }],
        ["failed (it offers its own regenerate)", { status: "failed" }],
        ["is not a BRD", { scopeFilter: JSON.stringify({ docType: "architecture" }) }],
      ])("is never marked when the document %s", async (_, over) => {
        const { draft, doc } = await publishedReaderBrd(over);
        await db.requirement.update({ where: { id: draft }, data: { reviewStatus: "approved" } });
        expect(await outOfDate(doc.id)).toBe(false);
      });

      it("is never marked under the catalogue layout, which lists no approved requirements", async () => {
        const { draft, doc } = await publishedReaderBrd();
        await db.requirement.update({ where: { id: draft }, data: { reviewStatus: "approved" } });
        state.layout.mockReturnValue({ layout: "catalogue" });
        expect(await outOfDate(doc.id)).toBe(false);
      });

      it("reads an unreadable manifest as not out of date, rather than failing to open the document", async () => {
        const { draft, doc } = await publishedReaderBrd();
        await db.generatedDocumentVersion.create({
          data: {
            documentId: doc.id,
            version: 2,
            content: "# BRD",
            provenanceManifest: "{not json",
          },
        });
        await db.requirement.update({ where: { id: draft }, data: { reviewStatus: "approved" } });
        expect(await outOfDate(doc.id)).toBe(false);
      });

      it("is never marked when the latest version predates the recorded approvals (#1230)", async () => {
        const { project, draft, doc } = await publishedReaderBrd();
        await db.generatedDocumentVersion.create({
          data: {
            documentId: doc.id,
            version: 2,
            content: "# BRD",
            provenanceManifest: JSON.stringify(
              legacyGeneratedDocVersionManifest({
                projectId: project,
                generatedDocumentId: doc.id,
                version: 2,
              }),
            ),
          },
        });
        await db.requirement.update({ where: { id: draft }, data: { reviewStatus: "approved" } });
        expect(await outOfDate(doc.id)).toBe(false);
      });
    });

    it("a background row completing (code-graph ingest) asks for nothing: it is never the run Requirements opens on", async () => {
      const project = await makeProject();
      const analysis = await makeAnalysis(project, "running");
      await db.analysis.update({
        where: { id: analysis },
        data: { metadata: JSON.stringify({ source: "code-graph-ingest" }) },
      });
      await markAnalysisCompleted(analysis, NO_TOKENS);
      await settle();
      expect(state.check).not.toHaveBeenCalled();
    });

    it("asks for nothing under the catalogue layout", async () => {
      state.layout.mockReturnValue({ layout: "catalogue" });
      const project = await makeProject();
      const analysis = await makeAnalysis(project, "running");
      await markAnalysisCompleted(analysis, NO_TOKENS);
      await settle();
      expect(state.check).not.toHaveBeenCalled();
    });
  },
);
