/**
 * Issue #2236 — a Spec Kit `/clarify` answer kept as project knowledge: stored
 * as a clarification record of the project (keyed by the feature and the
 * question) and indexed in its RAG store, as an analysis's answers are.
 */
import { createChildLogger } from "../logger.js";
import { specKitClarificationKey } from "./clarification-key.js";
import { indexClarification } from "./clarification-knowledge.js";
import {
  projectProductIds,
  recordClarification,
  type StoredClarification,
} from "./clarification-records.js";

const log = createChildLogger("spec-kit-clarifications");

export interface SpecKitClarificationInput {
  projectId: string;
  /** The feature slug, or null for the project's `.specify/` set. */
  feature: string | null;
  question: string;
  answer: string;
  answeredById: string | null;
  now?: Date;
}

/**
 * Record (and, when new or changed, index) one `/clarify` answer. Returns the
 * record, or null when it could not be stored; never throws, since the answer
 * is already in `clarify.md`.
 */
export async function recordSpecKitClarification(
  input: SpecKitClarificationInput,
  deps: { index?: typeof indexClarification } = {},
): Promise<StoredClarification | null> {
  try {
    const { record, changed } = await recordClarification(input.projectId, {
      origin: "spec-kit",
      questionKey: specKitClarificationKey(input.feature, input.question),
      specKitFeature: input.feature,
      question: input.question,
      answer: input.answer,
      answeredById: input.answeredById,
      answeredAt: input.now ?? new Date(),
      requirementIds: [],
      productIds: await projectProductIds(input.projectId),
    });
    if (changed) await (deps.index ?? indexClarification)(record);
    return record;
  } catch (err) {
    log.warn("a /clarify answer could not be recorded", {
      projectId: input.projectId,
      feature: input.feature,
      error: (err as Error).message,
    });
    return null;
  }
}
