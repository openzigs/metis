/**
 * Epic #209 (#235) — the key generative-path e2e.
 *
 * Drives the full chain merged in epic #201:
 *   ambiguous input → clarifying questions → user answers →
 *   PERSISTED refined requirement → refinement visible in the regenerated spec.
 *
 * Determinism: runs entirely against the #234 record/replay LLM harness. The
 * Playwright web server boots with `AI_REPLAY=1` + `AI_FIXTURE_DIR`
 * (see `playwright.config.ts`), so every `provider.chat()` the loop makes —
 * question generation, ambiguity resolution, and synthesis — is served from
 * committed fixtures. NO live LLM credentials are needed. Fixture misses fall
 * back to the deterministic offline stub, so unrelated calls never flake.
 *
 * How the fixtures were produced (no live keys): they are HAND-CRAFTED. The
 * responses are authored in `e2e/fixtures/clarify-loop.ts`;
 * `server/scripts/e2e-build-clarify-fixtures.ts` computes each fixture's exact
 * `fixtureKey()` from the SAME prompt builders the server uses at runtime and
 * writes them. `global-setup.ts` regenerates them before the suite, so they
 * stay in lock-step with the live prompts. The seeded specialist finding
 * (`e2e-seed-clarify-loop.ts`) makes the synthesis prompt — and therefore its
 * key — fully deterministic.
 *
 * Acceptance criteria coverage:
 *   1. Full chain driven via UI/API ............ this spec (login UI + clarify/regenerate API)
 *   2. Refined requirement is PERSISTED ........ asserted via Prisma (DB read) + snapshot
 *   3. Refinement appears in regenerated spec .. asserted on regenerated Requirement rows
 *   4. Deterministic under replay .............. AI_REPLAY=1 + committed fixtures, no keys
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, request, test, type APIRequestContext } from "@playwright/test";
import { apiBase } from "../fixtures/api-base.js";
import { ADMIN_USER, primeAdminUser } from "../fixtures/seed-user.js";
import {
  readAnalysisMetadataViaCli,
  seedClarifyLoopAnalysisViaCli,
} from "../fixtures/seed-helpers.js";
import { LoginPage } from "../pages/login.page.js";
import { ClarifyLoopPage } from "../pages/clarify-loop.page.js";
import {
  AMBIGUITY_FIELD,
  ANSWER_TEXT,
  buildAnswer,
  PROJECT_NAME,
  PROJECT_SLUG_PREFIX,
  REFINED_DESCRIPTION,
  REFINEMENT_SENTINEL,
  REGENERATE_AGENT_KEY,
  REQUIREMENT_ID,
  START_REQUIREMENTS,
} from "../fixtures/clarify-loop.js";
import type { StructuredRequirements } from "../../server/src/lib/analysis/types/requirements.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = apiBase();

function dbUrl(): string {
  return `file:${
    process.env.E2E_DB_FILE ??
    path.join(__dirname, "..", "test-results", "stack-data", "metis-e2e.db")
  }`;
}

async function authedApi(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
}

test.describe("Generative loop: clarify → refine → persist → regenerated spec (#235)", () => {
  test.describe.configure({ timeout: 120_000 });

  let accessToken: string;
  let userId: string;
  let projectId: string;
  let analysisId: string;

  test.beforeEach(async ({ page }) => {
    const primed = await primeAdminUser(API_BASE);
    accessToken = primed.accessToken;
    userId = primed.userId;

    // Fixed project NAME (the synthesis prompt embeds it, so the fixture key
    // depends on it); slug stays unique per run for isolation.
    const slug = `${PROJECT_SLUG_PREFIX}-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const api = await authedApi(accessToken);
    const res = await api.post("/api/projects", {
      data: { name: PROJECT_NAME, slug, description: "epic-209 #235 generative loop" },
    });
    expect(res.status()).toBe(201);
    const body = (await res.json()) as {
      id?: string;
      data?: { id?: string; project?: { id?: string } };
    };
    projectId = (body.data?.project?.id ?? body.data?.id ?? body.id) as string;
    expect(projectId).toBeTruthy();
    await api.dispose();

    // Seed a COMPLETED analysis with one deterministic specialist finding so
    // synthesis (and its replay fixture key) is fully predictable.
    analysisId = seedClarifyLoopAnalysisViaCli({
      projectId,
      startedById: userId,
      databaseUrl: dbUrl(),
    });
    expect(analysisId).toBeTruthy();

    // AC1 (UI half): authenticate through the real browser login + proxy path.
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.login(ADMIN_USER.username, ADMIN_USER.password);
  });

  // AC 1–4: the whole chain, asserted end-to-end.
  test("ambiguous input is clarified, persisted, and surfaces in the regenerated spec", async ({
    page,
  }) => {
    const loop = new ClarifyLoopPage(page, API_BASE, accessToken);

    await test.step("AC1: open the project Analysis page in the browser", async () => {
      await loop.gotoAnalysis(projectId);
    });

    let questionId = "";
    await test.step("ambiguous requirement yields a clarifying question (replayed)", async () => {
      const state = await loop.startClarification(projectId, analysisId, START_REQUIREMENTS);
      expect(state.rounds.length).toBeGreaterThan(0);
      const round = state.rounds[state.rounds.length - 1]!;
      expect(round.questions.length).toBeGreaterThan(0);
      const question = round.questions[0]!;
      expect(question.requirementId).toBe(REQUIREMENT_ID);
      expect(question.ambiguityField).toBe(AMBIGUITY_FIELD);
      expect(question.question).toContain("authentication");
      questionId = question.id;
      expect(questionId).toBeTruthy();
    });

    let refined: StructuredRequirements;
    await test.step("answering the question refines the requirement (replayed resolution)", async () => {
      const result = await loop.submitAnswers(
        projectId,
        analysisId,
        [buildAnswer(questionId)],
        START_REQUIREMENTS,
      );
      refined = result.updatedRequirements;
      const refinedReq = refined.requirements.find((r) => r.id === REQUIREMENT_ID);
      expect(refinedReq, "refined requirement present in response").toBeTruthy();
      // The answer text the user supplied carried the sentinel...
      expect(ANSWER_TEXT).toContain(REFINEMENT_SENTINEL);
      // ...and the resolution folded it into the requirement description.
      expect(refinedReq!.description).toBe(REFINED_DESCRIPTION);
      expect(refinedReq!.description).toContain(REFINEMENT_SENTINEL);
    });

    await test.step("AC2: refined requirement is PERSISTED (asserted via Prisma DB read)", async () => {
      // Read straight from the SQLite row — proves persistence, not just the
      // HTTP response echo. The clarify route writes via persistAnalysisEnhancement.
      const metadata = readAnalysisMetadataViaCli({ analysisId, databaseUrl: dbUrl() });
      expect(metadata, "analysis metadata row exists").toBeTruthy();
      const persisted = metadata!.structuredRequirements as StructuredRequirements | undefined;
      expect(persisted, "structuredRequirements persisted to Analysis.metadata").toBeTruthy();
      const persistedReq = persisted!.requirements.find((r) => r.id === REQUIREMENT_ID);
      expect(persistedReq, "refined requirement persisted").toBeTruthy();
      expect(persistedReq!.description).toBe(REFINED_DESCRIPTION);
      expect(persistedReq!.description).toContain(REFINEMENT_SENTINEL);

      // Cross-check the durable dialog state was persisted too (DB-backed store).
      const dialogState = await loop.getClarificationState(projectId, analysisId);
      expect(dialogState, "dialog state persisted").toBeTruthy();
      expect(dialogState!.resolvedAmbiguities).toContain(`${REQUIREMENT_ID}:${AMBIGUITY_FIELD}`);
    });

    await test.step("AC3: regenerating re-runs synthesis and the refinement appears in the spec", async () => {
      // Regenerate a specialist agent that did NOT produce the seeded finding,
      // so the seeded `code` finding survives into synthesis. Regenerate always
      // re-runs synthesis afterwards, feeding the persisted refined requirement
      // into the synthesis prompt (orchestrator: getStructuredRequirements).
      await loop.regenerateAgent(analysisId, REGENERATE_AGENT_KEY);

      const snap = await loop.waitForSnapshot(
        analysisId,
        (s) =>
          s.status === "completed" &&
          s.requirements.some((r) => r.body.includes(REFINEMENT_SENTINEL)),
      );

      const specReq = snap.requirements.find((r) => r.body.includes(REFINEMENT_SENTINEL));
      expect(specReq, "regenerated spec contains the clarified requirement").toBeTruthy();
      expect(specReq!.body).toContain(REFINEMENT_SENTINEL);
    });
  });
});
