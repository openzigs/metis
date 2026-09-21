/**
 * Build the hand-crafted record/replay fixtures (#234) for the #235
 * generative-loop e2e test (epic #209).
 *
 * NO live LLM credentials are used or required. Each fixture's RESPONSE is
 * authored by hand in `e2e/fixtures/clarify-loop.ts`; this script only computes
 * the deterministic `fixtureKey()` for each `provider.chat()` call the loop
 * makes and writes the matching `<key>.json` so the `ReplayProvider` serves it.
 *
 * Keys are derived from the SAME prompt builders the server uses at runtime
 * (`buildQuestionMessages`, `buildResolutionMessages`, `buildSynthesisPrompt`,
 * `formatFindingsTable`), so the fixtures can never silently drift from the
 * live prompts — a prompt change shifts the key, this script regenerates it,
 * and the diff is reviewable. Run it from `e2e/global-setup.ts` (idempotent) so
 * a fresh checkout always replays green.
 *
 * Usage:
 *   AI_FIXTURE_DIR=/abs/path tsx server/scripts/e2e-build-clarify-fixtures.ts
 */
/* eslint-disable no-console -- CLI script: progress to stdout, errors to stderr */
import { HAIKU_MODEL_ID } from "../src/lib/ai/model-router.js";
import {
  buildQuestionMessages,
  buildResolutionMessages,
} from "../src/lib/analysis/clarification-dialog.js";
import { resolveFinalAnswerMaxOutputTokens } from "../src/lib/analysis/agent-runner.js";
import { buildSpecialistPrompt, buildSynthesisPrompt } from "../src/lib/analysis/prompts.js";
import {
  formatFindingsTable,
  resolveSynthesisMaxOutputTokens,
} from "../src/lib/analysis/synthesis.js";
import { fixtureKey } from "../src/lib/ai/fixtures/fixture-key.js";
import { FixtureStore, resolveFixtureDir } from "../src/lib/ai/fixtures/fixture-store.js";
import type { ChatMessage, ChatResponse } from "../src/lib/ai/types.js";
import {
  AMBIGUOUS_REQUIREMENT,
  ANSWER_TEXT,
  CLARIFYING_QUESTION,
  LOOP_MODEL_ID,
  PROJECT_DESCRIPTION,
  PROJECT_NAME,
  QUESTIONS_RESPONSE_JSON,
  REFINED_DESCRIPTION,
  REGENERATE_AGENT_KEY,
  RESOLUTION_RESPONSE_JSON,
  SEED_FINDING,
  SPECIALIST_RESPONSE_JSON,
  SYNTHESIS_RESPONSE_JSON,
} from "../../e2e/fixtures/clarify-loop.js";

const usage = (tokens: number) => ({
  promptTokens: tokens,
  completionTokens: tokens,
  totalTokens: tokens * 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

function response(content: string): ChatResponse {
  return {
    content,
    usage: usage(64),
    model: "e2e-replay-235",
    provider: "offline-stub",
    offline: false,
  };
}

/**
 * Build every fixture into {@link resolveFixtureDir}'s directory.
 *
 * Exported (#1224) so a unit test can drive the real build into a temp dir and
 * check the keys against what the runtime actually sends — the drift this
 * script exists to prevent was previously only observable as a red
 * `generative-e2e`, twenty minutes after the fact.
 */
export async function main(): Promise<void> {
  const dir = resolveFixtureDir();
  const store = new FixtureStore(dir);

  // 1) Question-generation call (round 1, nothing resolved yet).
  const questionMessages = buildQuestionMessages([AMBIGUOUS_REQUIREMENT], 1, []);
  const questionOpts = { model: HAIKU_MODEL_ID, disableTools: true };
  const questionKey = fixtureKey(questionMessages, questionOpts);
  await store.write(questionKey, questionMessages, questionOpts, response(QUESTIONS_RESPONSE_JSON));

  // 2) Resolution call. `resolveAmbiguities` builds the Q&A block as
  //    `Q: <question>\nA: <answer>` joined by "\n" (one Q here).
  const qaBlock = `Q: ${CLARIFYING_QUESTION.question}\nA: ${ANSWER_TEXT}`;
  const resolutionMessages = buildResolutionMessages(
    { title: AMBIGUOUS_REQUIREMENT.title, description: AMBIGUOUS_REQUIREMENT.description },
    qaBlock,
  );
  const resolutionOpts = { model: HAIKU_MODEL_ID, disableTools: true };
  const resolutionKey = fixtureKey(resolutionMessages, resolutionOpts);
  await store.write(
    resolutionKey,
    resolutionMessages,
    resolutionOpts,
    response(RESOLUTION_RESPONSE_JSON),
  );

  // 3) Regenerate specialist call. Triggering a regenerate re-runs one
  //    specialist agent before synthesis. The seeded analysis pins
  //    `metadata.model` and has no documents, so this call's prompt is fully
  //    determined: fixed name/description, empty retrieved context, no extra
  //    instructions, and the pinned model. It returns empty findings so the
  //    synthesis findings table stays equal to the single seeded finding.
  const specialistPrompt = buildSpecialistPrompt({
    agentKey: REGENERATE_AGENT_KEY,
    projectName: PROJECT_NAME,
    projectDescription: PROJECT_DESCRIPTION,
    retrievedContext: "", // no documents → formatRetrievedContext([]) === ""
  });
  const specialistMessages: ChatMessage[] = [
    { role: "user", content: specialistPrompt.userMessage },
  ];
  // #1224 — `maxTokens` is part of `keyedOptions`, so the single-shot call's new
  // explicit OUTPUT cap shifts this fixture's key. Read through the SAME
  // resolver `runAgent` uses rather than restating 16384: a second copy of the
  // number is a second source of truth, and the only thing that notices the
  // drift is a red `generative-e2e` on someone else's PR.
  const specialistOpts = {
    systemMessage: specialistPrompt.systemMessage,
    model: LOOP_MODEL_ID,
    maxTokens: resolveFinalAnswerMaxOutputTokens(),
  };
  const specialistKey = fixtureKey(specialistMessages, specialistOpts);
  await store.write(
    specialistKey,
    specialistMessages,
    specialistOpts,
    response(SPECIALIST_RESPONSE_JSON),
  );

  // 4) Synthesis call. The orchestrator feeds the persisted refined requirement
  //    (refined description above) plus the one seeded finding into synthesis.
  //    Regenerate passes the pinned `metadata.model`, so the keyed options are
  //    the derived `systemMessage`, that model, and — since #1223 — the
  //    explicit output cap.
  const findingsTable = formatFindingsTable([
    {
      agentKey: SEED_FINDING.agentKey,
      category: SEED_FINDING.category,
      severity: SEED_FINDING.severity,
      title: SEED_FINDING.title,
      body: SEED_FINDING.body,
      tags: SEED_FINDING.tags,
      citations: [],
    },
  ]);
  const { systemMessage, userMessage } = buildSynthesisPrompt({
    projectName: PROJECT_NAME,
    findingsTable,
    refinedRequirements: [{ title: AMBIGUOUS_REQUIREMENT.title, description: REFINED_DESCRIPTION }],
  });
  const synthesisMessages: ChatMessage[] = [{ role: "user", content: userMessage }];
  // #1223 — `maxTokens` is part of `keyedOptions`, so synthesis's new explicit
  // OUTPUT cap shifts this fixture's key. Read through the SAME resolver
  // `runSynthesis` uses rather than restating 21000: a second copy of the
  // number is a second source of truth, and the only thing that notices the
  // drift is a red `generative-e2e` on someone else's PR.
  const synthesisOpts = {
    systemMessage,
    model: LOOP_MODEL_ID,
    maxTokens: resolveSynthesisMaxOutputTokens(),
  };
  const synthesisKey = fixtureKey(synthesisMessages, synthesisOpts);
  await store.write(
    synthesisKey,
    synthesisMessages,
    synthesisOpts,
    response(SYNTHESIS_RESPONSE_JSON),
  );

  // #253 — fail loud if any expected fixture is missing after the build. A
  // silent fall-through to the offline stub at replay time would let a stale or
  // renamed fixture (e.g. after a prompt change shifts the derived key) pass CI
  // without anyone noticing the deterministic path went stale. Assert every
  // expected key resolved to a file on disk; throw naming the missing key(s).
  const expected: Array<{ label: string; key: string }> = [
    { label: "questions", key: questionKey },
    { label: "resolution", key: resolutionKey },
    { label: "specialist", key: specialistKey },
    { label: "synthesis", key: synthesisKey },
  ];
  await assertFixturesPresent(store, expected);

  console.log(
    `[e2e-build-clarify-fixtures] wrote 4 fixtures to ${dir}\n` +
      `  questions:  ${questionKey}.json\n` +
      `  resolution: ${resolutionKey}.json\n` +
      `  specialist: ${specialistKey}.json\n` +
      `  synthesis:  ${synthesisKey}.json`,
  );
}

/**
 * #253 — verify each expected fixture key resolved to a readable file in the
 * store. Throws an `Error` naming every missing `<label> (<key>)` so a stale or
 * renamed fixture fails the build/replay setup loudly instead of degrading to
 * the offline stub. Exported for unit testing.
 */
export async function assertFixturesPresent(
  store: FixtureStore,
  expected: Array<{ label: string; key: string }>,
): Promise<void> {
  const missing: string[] = [];
  for (const { label, key } of expected) {
    if (!(await store.has(key))) missing.push(`${label} (${key})`);
  }
  if (missing.length > 0) {
    throw new Error(
      `[e2e-build-clarify-fixtures] missing expected fixture(s) in ${store.directory}: ` +
        `${missing.join(", ")}. The generative-e2e replay would silently fall back to the ` +
        `offline stub. Re-run the fixture build (a prompt change may have shifted the key).`,
    );
  }
}

// Only auto-run when executed directly as a script (tsx scripts/...). Importing
// this module (e.g. from a unit test of `assertFixturesPresent`) must not kick
// off a real fixture build.
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].includes("e2e-build-clarify-fixtures");
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
