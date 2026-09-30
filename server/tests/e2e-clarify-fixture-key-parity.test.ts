/**
 * #1224 — the generative-e2e replay fixtures must be keyed EXACTLY as the
 * runtime's request.
 *
 * `fixtureKey` hashes the messages plus `keyedOptions`, and `maxTokens` is in
 * that subset. So giving `runAgent` an explicit output cap shifts the specialist
 * call's key, and `e2e-build-clarify-fixtures.ts` — a SECOND statement of what
 * the runtime sends — has to move with it. When it does not, `ReplayProvider`
 * misses, falls back to the offline stub, the `database` agent fails with
 * non-JSON output, and the only signal is a red `generative-e2e` on a job that
 * takes five minutes and does not say why.
 *
 * This test closes that gap: it runs the REAL builder into a temp directory,
 * then asks the REAL `runAgent` what it would send, and requires the key those
 * two agree on to exist. Neither side is restated here, so the test cannot drift
 * with them — it fails whenever they disagree, for any reason, including a
 * prompt change neither this file nor the builder anticipated.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_REQUIREMENT,
  ANSWER_TEXT,
  LOOP_MODEL_ID,
  PROJECT_DESCRIPTION,
  PROJECT_NAME,
  REFINED_DESCRIPTION,
  REGENERATE_AGENT_KEY,
  SEED_FINDING,
  SPECIALIST_RESPONSE_JSON,
  SYNTHESIS_RESPONSE_JSON,
} from "../../e2e/fixtures/clarify-loop.js";
import { e2eServerAIEnv } from "../../e2e/fixtures/ai-mode.js";
import { fixtureKey } from "../src/lib/ai/fixtures/fixture-key.js";
import { FixtureStore } from "../src/lib/ai/fixtures/fixture-store.js";
import type { AIProvider, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";
import { runAgent } from "../src/lib/analysis/agent-runner.js";
import { runSynthesis, type FlatFinding } from "../src/lib/analysis/synthesis.js";
import { main as buildClarifyFixtures } from "../scripts/e2e-build-clarify-fixtures.js";
import { buildServerProvider } from "../src/lib/ai/server-provider.js";
import { OfflineStubProvider } from "../src/lib/ai/providers/offline-stub-provider.js";
import { ClarificationDialog } from "../src/lib/analysis/clarification-dialog.js";

// #532 — the dialog persists its state; keep it in memory for this test.
const dialogStore = new Map<string, unknown>();
vi.mock("../src/lib/analysis/clarification-dialog-store.js", () => ({
  readDialogState: vi.fn(async (id: string) => structuredClone(dialogStore.get(id))),
  writeDialogState: vi.fn(async (id: string, state: unknown) => {
    dialogStore.set(id, structuredClone(state));
  }),
  deleteDialogState: vi.fn(async (id: string) => {
    dialogStore.delete(id);
  }),
}));

describe("generative-e2e clarify fixtures", () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.AI_FIXTURE_DIR;
    dir = mkdtempSync(join(tmpdir(), "metis-clarify-fixtures-"));
    process.env.AI_FIXTURE_DIR = dir;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (previous === undefined) delete process.env.AI_FIXTURE_DIR;
    else process.env.AI_FIXTURE_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys the specialist fixture exactly as runAgent's real request", async () => {
    await buildClarifyFixtures();

    // Ask the runner itself what it sends — never restate it.
    let captured: { messages: ChatMessage[]; opts: ChatOptions } | undefined;
    const provider = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
        captured = { messages, opts };
        return {
          content: SPECIALIST_RESPONSE_JSON,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: LOOP_MODEL_ID,
          provider: "offline-stub" as const,
        };
      }),
      stream: vi.fn(async function* () {
        yield { type: "done" };
      }),
      embed: vi.fn(async () => ({ vectors: [], dimension: 0, model: "stub" })),
      models: vi.fn(async () => ["stub"]),
      ping: vi.fn(async () => true),
    } as unknown as AIProvider;

    await runAgent(provider, {
      agentKey: REGENERATE_AGENT_KEY,
      projectName: PROJECT_NAME,
      projectDescription: PROJECT_DESCRIPTION,
      retrieved: [],
      model: LOOP_MODEL_ID,
    });

    expect(captured, "runAgent never called the provider").toBeDefined();
    const key = fixtureKey(captured!.messages, captured!.opts);
    const present = await new FixtureStore(dir).has(key);
    expect(
      present,
      `No built fixture for the key runAgent produces (${key}). ` +
        "The builder and the runtime disagree — generative-e2e will replay the offline stub.",
    ).toBe(true);
  });

  // #1223 gave the synthesis call its own explicit output cap, so the synthesis
  // fixture is keyed on `maxTokens` for exactly the same reason the specialist
  // one is. Same oracle: run the real builder, then ask the real `runSynthesis`
  // what it sends. Neither side is restated, so the pair cannot silently drift.
  it("keys the synthesis fixture exactly as runSynthesis's real request", async () => {
    await buildClarifyFixtures();

    let captured: { messages: ChatMessage[]; opts: ChatOptions } | undefined;
    const provider = {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
        captured = { messages, opts };
        return {
          content: SYNTHESIS_RESPONSE_JSON,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: LOOP_MODEL_ID,
          provider: "offline-stub" as const,
        };
      }),
      stream: vi.fn(async function* () {
        yield { type: "done" };
      }),
      embed: vi.fn(async () => ({ vectors: [], dimension: 0, model: "stub" })),
      models: vi.fn(async () => ["stub"]),
      ping: vi.fn(async () => true),
    } as unknown as AIProvider;

    const findings: FlatFinding[] = [
      {
        agentKey: SEED_FINDING.agentKey,
        category: SEED_FINDING.category,
        severity: SEED_FINDING.severity,
        title: SEED_FINDING.title,
        body: SEED_FINDING.body,
        tags: SEED_FINDING.tags,
        citations: [],
      },
    ];
    await runSynthesis(provider, {
      projectName: PROJECT_NAME,
      findings,
      model: LOOP_MODEL_ID,
      refinedRequirements: [
        { title: AMBIGUOUS_REQUIREMENT.title, description: REFINED_DESCRIPTION },
      ],
    });

    expect(captured, "runSynthesis never called the provider").toBeDefined();
    const key = fixtureKey(captured!.messages, captured!.opts);
    const present = await new FixtureStore(dir).has(key);
    expect(
      present,
      `No built fixture for the key runSynthesis produces (${key}). ` +
        "The builder and the runtime disagree — generative-e2e will replay the offline stub.",
    ).toBe(true);
  });

  // #532 — the dialog's model is no longer a hard-coded Claude tier id: it is
  // whatever `tierModelFor` picks on the active provider. #558 — and the active
  // provider is whatever the e2e server is started with, which is NOT always the
  // offline stub: `AI_PROVIDER` reaches it (playwright.config.ts). So neither the
  // builder nor this test names a provider: both build it through the server's
  // own construction (`buildServerProvider`) from the e2e server's environment
  // (`e2eServerAIEnv`). Drive the REAL dialog on that provider and require both
  // of its calls to hit a built fixture — under the default AND a real provider.
  it.each([
    ["the default offline stub", { AI_PROVIDER: undefined }],
    [
      "a real provider (AI_PROVIDER=openai)",
      {
        AI_PROVIDER: "openai",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "sk-test-558",
        AI_MODEL: "gpt-558-e2e",
      },
    ],
  ])(
    "keys the clarification question and resolution fixtures as the dialog's real requests on %s",
    async (_label, env) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      await buildClarifyFixtures();
      dialogStore.clear();

      const provider = buildServerProvider({
        ...process.env,
        ...e2eServerAIEnv(process.env, dir),
      });
      if (env.AI_PROVIDER !== undefined) {
        // The case is only a check if this provider's model is not the stub's.
        expect(provider.model).not.toBe(new OfflineStubProvider().model);
      }
      const chat = vi.spyOn(provider, "chat");
      const dialog = new ClarificationDialog({ provider });

      const state = await dialog.startOrContinue("parity-532", {
        requirements: [AMBIGUOUS_REQUIREMENT],
        totalAmbiguities: AMBIGUOUS_REQUIREMENT.ambiguities.length,
        totalEvidenceNeeds: 0,
      });
      const question = state.rounds[0]?.questions[0];
      expect(question, "the questions call did not replay its fixture").toBeDefined();
      await dialog.submitAnswers(
        "parity-532",
        [{ questionId: question!.id, answer: ANSWER_TEXT }],
        {
          requirements: [AMBIGUOUS_REQUIREMENT],
          totalAmbiguities: AMBIGUOUS_REQUIREMENT.ambiguities.length,
          totalEvidenceNeeds: 0,
        },
      );

      expect(chat).toHaveBeenCalledTimes(2);
      const store = new FixtureStore(dir);
      for (const [messages, opts] of chat.mock.calls) {
        const key = fixtureKey(messages, opts);
        expect(
          await store.has(key),
          `No built fixture for the key the clarification dialog produces (${key}, model ${opts?.model}). ` +
            "The builder and the runtime disagree — generative-e2e will replay the offline stub.",
        ).toBe(true);
      }
    },
  );
});
