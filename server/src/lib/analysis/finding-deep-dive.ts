/**
 * Issue #178 — Finding deep-dive engine.
 *
 * Expands a single analysis finding into a structured, publishable issue draft
 * (`FindingIssueDraft`) via ONE bounded LLM call, plus at most one re-prompt
 * when that call's answer cannot be read (#1002). The provider is injected so
 * tests can assert call-count and feed deterministic output without a network
 * round-trip.
 *
 * Security: the finding text and any user-supplied `instructions` are treated
 * as UNTRUSTED data — fenced and scrubbed by `buildDeepDivePrompt`
 * (prompt-injection defence-in-depth). The model output is never trusted: it is
 * parsed loosely (`extractJsonObject`) then validated against
 * `findingIssueDraftSchema` before it leaves this module — both inside
 * `requestStructuredVerdict`, which re-prompts once with the parse or schema
 * error (#1002). The parser's own message never leaves this module.
 */
import {
  findingIssueDraftSchema,
  formatCodeCitationLocator,
  isCodeCitation,
  repoDocumentPath,
  type AnalysisAgentKey,
  type FindingIssueDraft,
  type SnapshotCitation,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { HAIKU_MODEL_ID, tierModelFor } from "../ai/model-router.js";
import { createChildLogger } from "../logger.js";
import { AppError } from "../../middleware/error-handler.js";
import { getPersona } from "./personas.js";
import { buildDeepDivePrompt } from "./prompts.js";
import { hasVerdict, requestStructuredVerdict } from "./structured-verdict.js";

const log = createChildLogger("analysis-deep-dive");

/**
 * #1002 — what the user is told when the model's answer could not be read as a
 * draft after the re-prompt. Deliberately free of parser detail: the reported
 * defect was `Unexpected non-whitespace character after JSON at position 2019`
 * shown verbatim in the dialog. The cause is in the server log.
 */
export const DEEP_DIVE_UNREADABLE_MESSAGE =
  "The model's answer could not be turned into an issue draft. Please try again.";

/** The shape quoted back to the model in the re-prompt. */
const DRAFT_SHAPE = [
  "{",
  '  "title": string,',
  '  "problemStatement": string,',
  '  "affected": { "files": string[], "requirementIds": string[] },',
  '  "acceptanceCriteria": string[],',
  '  "suggestedLabels": string[]',
  "}",
].join("\n");

export interface DeepDiveEngineInput {
  projectName: string;
  agentKey: AnalysisAgentKey;
  finding: {
    title: string;
    body: string;
    category: string;
    severity: string;
    /** #717 — a document citation's `source` decides whether it names a repo path. */
    citations: SnapshotCitation[];
    requirementId: string | null;
  };
  /** Optional user steering — bounded + escaped upstream and here. */
  instructions?: string;
  /**
   * Model override; defaults to Haiku to keep the deep-dive cheap, or the
   * provider's configured model when it cannot serve Claude tier ids (#532).
   */
  model?: string;
  signal?: AbortSignal;
}

export interface DeepDiveFindingResult {
  draft: FindingIssueDraft;
  usage: TokenUsage;
  model: string;
}

/**
 * #717 — a repository document citation is named by its repository-relative
 * path. The stored filename is `connector:repo:<id>:src/<relPath>`, and the model
 * copied that `src/` into the draft's "Affected files", which then named files
 * that do not exist.
 */
function documentCitationName(c: Exclude<SnapshotCitation, { filePath: string }>): string {
  const repoPath = c.source === "repo" && c.filename ? repoDocumentPath(c.filename) : undefined;
  return repoPath ?? c.filename ?? c.documentId;
}

function formatCitations(citations: SnapshotCitation[]): string[] {
  return citations.map((c) => {
    // #734 — code citations render as their `filePath:startLine-endLine` locator.
    const where = isCodeCitation(c)
      ? formatCodeCitationLocator(c)
      : `${documentCitationName(c)}#${c.chunkIndex}`;
    return c.snippet ? `${where} :: ${c.snippet}` : where;
  });
}

/**
 * Run the deep-dive expansion. Makes one `provider.chat` call, and a second
 * only when the first answer was empty, not JSON, or failed the draft schema.
 *
 * @throws AppError 502 `DEEP_DIVE_UNREADABLE` — both answers were unreadable.
 * @throws the provider's own error, unchanged, when the call itself failed.
 */
export async function deepDiveFinding(
  provider: AIProvider,
  input: DeepDiveEngineInput,
): Promise<DeepDiveFindingResult> {
  if (input.signal?.aborted) {
    throw new DOMException("Aborted before start", "AbortError");
  }

  const persona = getPersona(input.agentKey);
  const { systemMessage, userMessage } = buildDeepDivePrompt({
    projectName: input.projectName,
    personaName: persona.name,
    personaRole: persona.role,
    finding: {
      title: input.finding.title,
      body: input.finding.body,
      category: input.finding.category,
      severity: input.finding.severity,
      citations: formatCitations(input.finding.citations),
      requirementId: input.finding.requirementId,
    },
    instructions: input.instructions,
  });

  const messages: ChatMessage[] = [{ role: "user", content: userMessage }];

  const outcome = await requestStructuredVerdict(provider, {
    label: "deep-dive",
    schema: findingIssueDraftSchema,
    schemaName: "issue draft",
    expectedShape: DRAFT_SHAPE,
    messages,
    systemMessage,
    model: input.model ?? tierModelFor(provider, HAIKU_MODEL_ID),
    signal: input.signal,
    // #1077 — JSON mode where the provider has one (the OpenAI-compatible
    // adapters); omitted by the helper everywhere else.
    responseFormat: { type: "json_object" },
  });

  if (!hasVerdict(outcome)) {
    // A transport failure is not a malformed answer: surface the provider's
    // own error (and its HTTP mapping) exactly as before the helper was used.
    if (outcome.reason === "provider-error") throw outcome.cause;
    log.error("Deep-dive answer unreadable after re-prompt", {
      reason: outcome.reason,
      detail: outcome.detail,
      attempts: outcome.attempts,
      provider: provider.key,
      model: outcome.model,
    });
    throw new AppError(502, "DEEP_DIVE_UNREADABLE", DEEP_DIVE_UNREADABLE_MESSAGE);
  }

  return {
    draft: outcome.verdict,
    usage: outcome.usage,
    model: outcome.model ?? provider.model,
  };
}
