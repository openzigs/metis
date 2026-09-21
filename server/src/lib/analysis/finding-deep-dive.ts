/**
 * Issue #178 — Finding deep-dive engine.
 *
 * Expands a single analysis finding into a structured, publishable issue draft
 * (`FindingIssueDraft`) via exactly ONE bounded LLM call. The provider is
 * injected so tests can assert call-count and feed deterministic output without
 * a network round-trip.
 *
 * Security: the finding text and any user-supplied `instructions` are treated
 * as UNTRUSTED data — fenced and scrubbed by `buildDeepDivePrompt`
 * (prompt-injection defence-in-depth). The model output is never trusted: it is
 * parsed loosely (`extractJsonObject`) then validated against
 * `findingIssueDraftSchema` before it leaves this module.
 */
import {
  findingIssueDraftSchema,
  formatCodeCitationLocator,
  isCodeCitation,
  type AnalysisAgentKey,
  type Citation,
  type FindingIssueDraft,
} from "@metis/shared";
import type { AIProvider, ChatMessage, TokenUsage } from "../ai/types.js";
import { HAIKU_MODEL_ID } from "../ai/model-router.js";
import { createChildLogger } from "../logger.js";
import { extractJsonObject } from "./agent-runner.js";
import { getPersona } from "./personas.js";
import { buildDeepDivePrompt } from "./prompts.js";

const log = createChildLogger("analysis-deep-dive");

const DEFAULT_USAGE: TokenUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

export interface DeepDiveEngineInput {
  projectName: string;
  agentKey: AnalysisAgentKey;
  finding: {
    title: string;
    body: string;
    category: string;
    severity: string;
    citations: Citation[];
    requirementId: string | null;
  };
  /** Optional user steering — bounded + escaped upstream and here. */
  instructions?: string;
  /** Model override; defaults to Haiku to keep the deep-dive cheap. */
  model?: string;
  signal?: AbortSignal;
}

export interface DeepDiveFindingResult {
  draft: FindingIssueDraft;
  usage: TokenUsage;
  model: string;
}

function formatCitations(citations: Citation[]): string[] {
  return citations.map((c) => {
    // #734 — code citations render as their `filePath:startLine-endLine` locator.
    const where = isCodeCitation(c)
      ? formatCodeCitationLocator(c)
      : c.filename
        ? `${c.filename}#${c.chunkIndex}`
        : `${c.documentId}#${c.chunkIndex}`;
    return c.snippet ? `${where} :: ${c.snippet}` : where;
  });
}

/**
 * Run the deep-dive expansion. Makes exactly one `provider.chat` call.
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

  const response = await provider.chat(messages, {
    systemMessage,
    model: input.model ?? HAIKU_MODEL_ID,
    signal: input.signal,
  });

  let parsed: unknown;
  try {
    parsed = extractJsonObject(response.content);
  } catch (err) {
    log.error("Deep-dive non-JSON response", {
      contentLength: response.content.length,
      contentPreview: response.content.slice(0, 500),
      provider: response.provider,
      model: response.model,
    });
    throw new Error(`Deep-dive returned non-JSON output: ${(err as Error).message}`);
  }

  const draft = findingIssueDraftSchema.parse(parsed);

  return {
    draft,
    usage: response.usage ?? DEFAULT_USAGE,
    model: response.model,
  };
}
