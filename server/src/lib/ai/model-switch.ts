/**
 * Epic #165 (#120) — Mid-session `/model` switching.
 *
 * Parses the `/model <name> [reasoning=high]` slash command from the chat
 * input and persists the chosen model/reasoning-effort onto the session.
 * The chat handler reads `currentModel` ahead of every provider call; the
 * original `model` column is preserved for telemetry continuity.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { SDK_REASONING_EFFORTS, type SdkReasoningEffort } from "@metis/shared";

export class ModelSwitchError extends Error {}

const SLASH_RE = /^\s*\/model\s+([A-Za-z0-9._:\-/]+)(?:\s+(?:reasoning=)?(low|medium|high))?\s*$/i;

export interface ParsedModelCommand {
  model: string;
  reasoningEffort: SdkReasoningEffort | null;
}

/**
 * Recognise `/model <name>` and `/model <name> [reasoning=]<effort>`. Returns
 * `null` when the input is not a model command — callers should pass the
 * input verbatim to the chat handler in that case.
 */
export function parseModelCommand(input: string): ParsedModelCommand | null {
  const m = SLASH_RE.exec(input);
  if (!m) return null;
  const model = m[1]!;
  const effort = m[2]?.toLowerCase() as SdkReasoningEffort | undefined;
  if (effort && !SDK_REASONING_EFFORTS.includes(effort)) {
    throw new ModelSwitchError(
      `Reasoning effort must be one of: ${SDK_REASONING_EFFORTS.join(", ")}`,
    );
  }
  return { model, reasoningEffort: effort ?? null };
}

export interface SwitchModelInput {
  sessionId: string;
  model: string;
  reasoningEffort?: SdkReasoningEffort | null;
  /** When provided, only models in this list are accepted. */
  allowedModels?: readonly string[];
  actorId?: string;
}

export interface SwitchedSession {
  sessionId: string;
  currentModel: string;
  currentReasoningEffort: SdkReasoningEffort | null;
  previousModel: string | null;
}

export async function switchModel(input: SwitchModelInput): Promise<SwitchedSession> {
  const session = await prisma.aISession.findUnique({ where: { id: input.sessionId } });
  if (!session) throw new ModelSwitchError("Session not found");
  if (session.deletedAt) throw new ModelSwitchError("Session deleted");
  if (input.allowedModels && !input.allowedModels.includes(input.model)) {
    throw new ModelSwitchError(`Model '${input.model}' is not available for this provider`);
  }
  const updated = await prisma.aISession.update({
    where: { id: input.sessionId },
    data: {
      currentModel: input.model,
      currentReasoningEffort: input.reasoningEffort ?? null,
    },
  });
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "session.model.switched",
    target: { type: "ai_session", id: input.sessionId },
    metadata: {
      from: session.currentModel ?? session.model,
      to: input.model,
      reasoningEffort: input.reasoningEffort ?? null,
    },
  });
  return {
    sessionId: updated.id,
    currentModel: updated.currentModel ?? updated.model,
    currentReasoningEffort: (updated.currentReasoningEffort as SdkReasoningEffort | null) ?? null,
    previousModel: session.currentModel ?? session.model,
  };
}

export function effectiveModel(session: { model: string; currentModel: string | null }): string {
  return session.currentModel ?? session.model;
}
