/**
 * Issue #1007 — chat turns, read from the project ledger.
 *
 * A chat turn is not an agent run: it has no replay timeline (`AgentRun` holds
 * analyses and PR reviews), and writing one run row plus its steps per turn
 * would bury those under one-step runs that repeat the chat transcript. Its
 * cost was already recorded, exactly, as one `token_usages` row per turn
 * (`agentStep` `chat`, summing the turn's model calls, #1080). This lists those
 * rows so `/runs` can show a chat turn's tokens and cost without a second copy
 * of the spend.
 *
 * Chat in a session with no project is not in the project ledger (it is in
 * `ai_token_usages` alone) and is not listed.
 */
import type { LedgerTokens } from "@metis/shared";
import { prisma } from "../../prisma.js";
import { LEDGER_COST_SELECT, ledgerRowCents } from "../../finops/ledger-cost.js";
import { LEDGER_USAGE_SELECT, summariseLedgerRows } from "../../finops/ledger-usage-summary.js";
import { ledgerRowSummedRequests } from "../../finops/token-tracker.js";
import {
  CHAT_TURN_AGENT_STEP,
  ESTIMATED_TURN_AGENT_STEP,
  FAILED_TURN_AGENT_STEP,
} from "./turn-usage.js";

/** The `agentStep` values a chat turn's ledger row carries. */
export const CHAT_TURN_LEDGER_STEPS = [
  CHAT_TURN_AGENT_STEP,
  ESTIMATED_TURN_AGENT_STEP,
  FAILED_TURN_AGENT_STEP,
] as const;

export const CHAT_TURN_DEFAULT_LIMIT = 50;
export const CHAT_TURN_MAX_LIMIT = 200;

export interface ChatTurnFilter {
  projectId?: string;
  /**
   * The projects the caller may reach. When set, turns outside them are
   * excluded; absent means no narrowing (system admins). Same rule as
   * `listRuns`.
   */
  accessibleProjectIds?: string[];
  sessionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface ChatTurn {
  id: string;
  sessionId: string | null;
  projectId: string;
  /** `chat`, `chat-estimated` (the provider reported no usage) or `chat-failed`. */
  step: string;
  provider: string;
  model: string;
  createdAt: Date;
  /** The model calls the turn made; more than one when it ran a tool loop. */
  requests: number;
  tokens: LedgerTokens;
  /** The ledger's own unrounded cost in USD; `null` when the model is unpriced. */
  costUsd: number | null;
}

/** The newest chat turns in the ledger, at most {@link CHAT_TURN_MAX_LIMIT}. */
export async function listChatTurns(filter: ChatTurnFilter): Promise<ChatTurn[]> {
  const where: Record<string, unknown> = { agentStep: { in: [...CHAT_TURN_LEDGER_STEPS] } };
  if (filter.accessibleProjectIds) {
    const allowed = filter.projectId
      ? filter.accessibleProjectIds.filter((id) => id === filter.projectId)
      : filter.accessibleProjectIds;
    where.projectId = { in: allowed };
  } else if (filter.projectId) {
    where.projectId = filter.projectId;
  }
  if (filter.sessionId) where.sessionId = filter.sessionId;
  if (filter.from || filter.to) {
    const createdAt: { gte?: Date; lte?: Date } = {};
    if (filter.from) createdAt.gte = filter.from;
    if (filter.to) createdAt.lte = filter.to;
    where.createdAt = createdAt;
  }
  const limit = Number.isFinite(filter.limit) ? Math.trunc(filter.limit as number) : NaN;
  const rows = await prisma.tokenUsage.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(limit > 0 ? limit : CHAT_TURN_DEFAULT_LIMIT, CHAT_TURN_MAX_LIMIT),
    select: {
      ...LEDGER_USAGE_SELECT,
      ...LEDGER_COST_SELECT,
      id: true,
      sessionId: true,
      projectId: true,
      agentStep: true,
      createdAt: true,
    },
  });
  return rows.map((row) => {
    const cents = ledgerRowCents(row);
    return {
      id: row.id,
      sessionId: row.sessionId,
      projectId: row.projectId,
      step: row.agentStep ?? CHAT_TURN_AGENT_STEP,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
      requests: ledgerRowSummedRequests(row)?.length ?? 1,
      tokens: summariseLedgerRows([row]).tokens,
      costUsd: cents === null ? null : cents / 100,
    };
  });
}
