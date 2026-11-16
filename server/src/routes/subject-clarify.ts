/**
 * #2270 — the request half of an Impact Analysis run's and a portfolio check's
 * clarification dialog, shared by `GET|POST /api/impact-analyses/:id/clarify`
 * and `GET|POST /api/portfolio-assessments/:id/clarify`. Each route checks the
 * caller may read the run (or check) and its document, then hands the dialog
 * here; nothing here decides access.
 *
 * The requirements asked about are always the ones the run stored: the body
 * carries only answers (a strict schema), never a requirement list.
 */
import type { Request, Response } from "express";
import type { ApiResponse } from "@metis/shared";
import { AppError } from "../middleware/error-handler.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import type { AIProvider } from "../lib/ai/types.js";
import { meterAnalysisProvider } from "../lib/analysis/analysis-usage.js";
import { sharedAudienceRetriever } from "../lib/analysis/document-access.js";
import type { GroundingRetriever } from "../lib/analysis/ambiguity-grounding.js";
import { getKnowledgeService } from "../lib/rag/knowledge-service.js";
import type {
  ClarificationState,
  StructuredRequirements,
} from "../lib/analysis/types/requirements.js";
import {
  persistSubjectClarificationKnowledge,
  startSubjectClarification,
  subjectClarifyRequestSchema,
  submitSubjectAnswers,
  type SubjectDialog,
  type SubjectKey,
} from "../lib/clarifications/subject-clarifications.js";

/** Test seams: the model and the knowledge search the dialog uses. */
export interface SubjectClarifyDeps {
  provider?: AIProvider;
  retriever?: GroundingRetriever;
  /** Runs the post-submit record-and-index; default fire-and-forget. */
  persist?: typeof persistSubjectClarificationKnowledge;
}

/** What `GET …/clarify` answers. */
export interface SubjectClarifyRead {
  state: ClarificationState | null;
  /** The requirements the run read and asks about; null when it has no dialog. */
  requirements: StructuredRequirements | null;
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

export const noDialog = () =>
  new AppError(404, "NO_DIALOG", "No clarification dialog for this result");

/** The GET payload for a dialog the caller may read, or for none. */
export function subjectClarifyRead(dialog: SubjectDialog | null): SubjectClarifyRead {
  return dialog
    ? { state: dialog.state, requirements: dialog.requirements }
    : { state: null, requirements: null };
}

/**
 * `POST …/clarify`: no answers starts the dialog (or returns its open round);
 * answers submit the open round, then the answers are recorded and indexed as
 * project knowledge, off the response's path. A client that goes away aborts
 * the model calls.
 */
export async function handleSubjectClarifyPost(
  req: Request,
  res: Response,
  key: SubjectKey,
  dialog: SubjectDialog,
  deps: SubjectClarifyDeps = {},
): Promise<void> {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  const parsed = subjectClarifyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid clarification payload", {
      issues: parsed.error.flatten(),
    });
  }
  const userId = req.user?.userId ?? null;
  const ctx = {
    key,
    dialog,
    provider: meterAnalysisProvider(deps.provider ?? buildProvider({ config: loadAIConfig() })),
    // #2431 — the grounded answers are stored on the dialog, read by every
    // reader of the result: search as the shared audience.
    retriever: deps.retriever ?? sharedAudienceRetriever(getKnowledgeService(), userId),
    signal: ac.signal,
  };
  const answers = parsed.data.answers ?? [];
  if (answers.length === 0) {
    res.json(ok(await startSubjectClarification(ctx)));
    return;
  }
  if (!dialog.state) throw noDialog();
  const answeredRound = dialog.state.rounds.at(-1)?.round;
  const result = await submitSubjectAnswers(ctx, answers);
  // #2236 / #2310 — only the round this submit answered becomes a record.
  void (deps.persist ?? persistSubjectClarificationKnowledge)({
    key,
    projectId: dialog.projectId,
    answeredById: userId,
    ...(answeredRound !== undefined ? { rounds: [answeredRound] } : {}),
  });
  res.json(ok(result));
}
