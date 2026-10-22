/**
 * Issue #1007 — chat turns, read from the project ledger.
 *
 * A chat turn is not an agent run: it has no replay timeline (`AgentRun` holds
 * analyses and PR reviews), and writing one run row plus its steps per turn
 * would bury those under one-step runs that repeat the chat transcript. Its
 * spend was already recorded in `token_usages`; this lists it so `/runs` can
 * show a chat turn's tokens and cost without a second copy of the spend.
 *
 * WHAT A ROW IS. A turn writes ONE row for the chat model's own calls
 * (`agentStep` `chat`, summing the calls of its tool loop, #1080;
 * `chat-estimated` when the provider reported no usage; `chat-failed` for a
 * turn that failed after spending). That row is NOT always the whole turn:
 * three other writers bill the same session under their own step, and nothing
 * but the session id ties their rows to a turn —
 *
 *   • `subagent`        a sub-agent call the turn delegated to (`routes/ai.ts`);
 *   • `chat.apply-diff` the model call behind the `apply_diff` tool;
 *   • `compaction`      the summary written when the conversation is compacted.
 *
 * So they are not attributed to a turn. {@link listChatTurns} returns them per
 * SESSION ({@link ChatSessionSpend.other}) next to the session's turn rows, and
 * the two add up to the session's chat spend in the ledger.
 *
 * Every other step a ledger row can carry belongs to something that is not a
 * chat session — `analysis` (session = the analysis id), `docs-gen` and
 * `docs-gen-aborted`, `spec-kit.*`, `pr-review` — or to a backing session of
 * its own that is never a user's chat (`discussion` and `discussion-failed`:
 * one session per reply; `impact.*`: one per impact run), and is not listed
 * here. Rows with no step are from before #792 and cannot be classified.
 *
 * WHOSE. Only the caller's own sessions (`ai_sessions.userId`), for an admin
 * too: a chat session is owner-only everywhere else (`loadAuthorizedSession`),
 * and this list carries a session's id with each turn's time, model, tokens
 * and cost. Per-user totals stay where they were, `GET
 * /projects/:id/usage?groupBy=user`.
 *
 * ONE DIFFERENCE FROM SESSION ACCESS, on purpose: a chat the owner DELETED
 * (`ai_sessions.deletedAt` set) is still listed here, to its owner only.
 * `loadAuthorizedSession` hides it, so it cannot be opened, read or continued;
 * but what it spent is still the owner's spend and still in the project's
 * ledger, and dropping it would make this list add up to less than the usage
 * pages do. Only a session whose row no longer exists (deleted for good)
 * cannot be tied to anyone and is not listed.
 *
 * That is the chat being deleted, not its PROJECT. A soft-deleted project is
 * closed to non-admins on every project surface, and here too (#1122): the
 * route narrows a non-admin to `listAccessibleProjectIds`, which leaves it
 * out, and answers 404 for it as an explicit `?projectId=` — the same rule as
 * `GET /api/runs`. An admin still sees their own turns in it.
 *
 * Chat in a session with no project is not in the project ledger (it is in
 * `ai_token_usages` alone) and is not listed.
 */
import type { LedgerTokens } from "@metis/shared";
import { prisma } from "../../prisma.js";
import {
  LEDGER_USAGE_SELECT,
  summariseLedgerRows,
  summaryCostUsd,
  type LedgerUsageRow,
} from "../../finops/ledger-usage-summary.js";
import { pageSize } from "../../replay/runs-service.js";
import {
  CHAT_TURN_AGENT_STEP,
  COMPACTION_AGENT_STEP,
  ESTIMATED_TURN_AGENT_STEP,
  FAILED_TURN_AGENT_STEP,
  SUBAGENT_AGENT_STEP,
} from "./turn-usage.js";

/** The `agentStep` values a chat turn's own ledger row carries. */
export const CHAT_TURN_LEDGER_STEPS = [
  CHAT_TURN_AGENT_STEP,
  ESTIMATED_TURN_AGENT_STEP,
  FAILED_TURN_AGENT_STEP,
] as const;

/** `agentStep` of the `apply_diff` tool's model call (`ai/tools/apply-diff.ts`). */
export const CHAT_APPLY_DIFF_AGENT_STEP = "chat.apply-diff";

/**
 * The steps other writers bill to a chat session: spend of the conversation
 * that is in no turn's row. See the file comment.
 */
export const CHAT_SESSION_OTHER_STEPS = [
  SUBAGENT_AGENT_STEP,
  CHAT_APPLY_DIFF_AGENT_STEP,
  COMPACTION_AGENT_STEP,
] as const;

export const CHAT_TURN_DEFAULT_LIMIT = 50;
export const CHAT_TURN_MAX_LIMIT = 200;

/**
 * How many of the caller's session ids one ledger statement names.
 *
 * Prisma refuses a statement that binds more values than the engine takes —
 * 999 on the better-sqlite3 adapter, 32,766 on Postgres — with P2029 ("The
 * query parameter limit supported by your database is exceeded"), and it does
 * not split a read that has an `orderBy` or a `take`, which the page read has.
 * (Measured on Prisma 7.10: 993 session ids, one project, three steps and
 * LIMIT/OFFSET bind exactly 999 and pass; 994 fail. The 5,000-session cap this
 * replaces was a 500 for a caller with about 1,000 sessions.)
 *
 * So the caller's sessions are read {@link CHAT_TURN_SESSION_BATCH} at a time.
 * Every value a statement binds counts, not only the ids: the page read binds
 * a batch's session ids, their projects (at most one per session), the three
 * steps, the two dates and LIMIT/OFFSET — at most 400 + 400 + 3 + 2 + 2 = 807.
 * There is no cap on the sessions themselves: a caller with several thousand
 * gets the same page, in one more statement per 400 sessions.
 */
export const CHAT_TURN_SESSION_BATCH = 400;

export interface ChatTurnFilter {
  /** The caller. Only sessions this user owns are read. */
  userId: string;
  projectId?: string;
  /**
   * The projects the caller may reach. When set, sessions outside them are
   * excluded; absent means no project narrowing (system admins). Same rule as
   * `listRuns`. The ownership rule applies either way.
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
  /** The chat model's calls in the turn; more than one when it ran a tool loop. */
  requests: number;
  tokens: LedgerTokens;
  /** The ledger's own unrounded cost in USD; `null` when the row was recorded unpriced. */
  costUsd: number | null;
}

/** A slice of a session's ledger rows, summed. */
export interface ChatSpend {
  /** Model calls: a summed row counts each call it lists. */
  calls: number;
  tokens: LedgerTokens;
  /** Stored cost of the priced rows, unrounded USD; `null` when none was priced; `0` for no rows. */
  costUsd: number | null;
  /** Tokens of rows recorded unpriced (#22). */
  unpricedTokens: number;
}

/** One chat session's WHOLE chat spend in the ledger, whatever page of turns is shown. */
export interface ChatSessionSpend {
  sessionId: string;
  projectId: string;
  /** Turn rows in the ledger for this session. */
  turnCount: number;
  /** The turn rows ({@link CHAT_TURN_LEDGER_STEPS}). */
  turns: ChatSpend;
  /** Sub-agents, apply-diff and summaries ({@link CHAT_SESSION_OTHER_STEPS}). */
  other: ChatSpend;
  /** `turns` + `other`. */
  total: ChatSpend;
}

export interface ChatTurnPage {
  /** The newest chat turns, at most {@link CHAT_TURN_MAX_LIMIT}. */
  items: ChatTurn[];
  /** One entry per session that has a turn in `items`, in order of first appearance. */
  sessions: ChatSessionSpend[];
}

function spend(rows: readonly LedgerUsageRow[]): ChatSpend {
  const summary = summariseLedgerRows(rows);
  return {
    calls: summary.requests,
    tokens: summary.tokens,
    costUsd: summaryCostUsd(summary),
    unpricedTokens: summary.unpricedTokens,
  };
}

interface OwnedSession {
  id: string;
  projectId: string;
}

/**
 * The caller's chat sessions the filter admits: id and project, grouped by
 * project so a batch of them names few projects.
 *
 * No `deletedAt` term: a chat its owner deleted is still listed to them (see
 * WHOSE in the file comment). And no `IN` list: the caller's reachable
 * projects are an unbounded per-user set, so they are applied here rather
 * than bound into the statement, which binds three values at most.
 */
async function ownedSessions(filter: ChatTurnFilter): Promise<OwnedSession[]> {
  const rows = await prisma.aISession.findMany({
    where: {
      userId: filter.userId,
      projectId: filter.projectId ?? { not: null },
      ...(filter.sessionId ? { id: filter.sessionId } : {}),
    },
    select: { id: true, projectId: true },
    orderBy: [{ projectId: "asc" }, { id: "asc" }],
  });
  const reachable = filter.accessibleProjectIds ? new Set(filter.accessibleProjectIds) : null;
  return rows.filter(
    (s): s is OwnedSession =>
      s.projectId !== null && (reachable === null || reachable.has(s.projectId)),
  );
}

/** `items` in consecutive runs of at most `size`. */
function inBatches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Newest first; rows written in the same millisecond by id, so the order is total. */
function newestFirst(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const byTime = b.createdAt.getTime() - a.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : -1;
}

/**
 * The caller's newest chat turns, with each listed session's whole chat spend.
 *
 * The caller's sessions come off `ai_sessions(userId)`. The ledger is then
 * read one batch of sessions at a time ({@link CHAT_TURN_SESSION_BATCH}), and
 * every statement names the batch's projects, so it searches
 * `token_usages(projectId, createdAt)` and never scans the table — for an
 * admin with no filter as well.
 *
 * THE PAGE ACROSS BATCHES. Each batch returns its own newest `take` rows in
 * the order {@link newestFirst} sorts by; the page is the newest `take` of
 * those together. Any row of the true page is among its own batch's newest
 * `take`, so nothing is missed, and the order is the one a single statement
 * would give. The session subtotals read only the sessions on the page.
 */
export async function listChatTurns(filter: ChatTurnFilter): Promise<ChatTurnPage> {
  const owned = await ownedSessions(filter);
  if (owned.length === 0) return { items: [], sessions: [] };
  const sessionProject = new Map(owned.map((s) => [s.id, s.projectId]));
  const take = pageSize(filter.limit, CHAT_TURN_DEFAULT_LIMIT, CHAT_TURN_MAX_LIMIT);

  const createdAt: { gte?: Date; lte?: Date } = {};
  if (filter.from) createdAt.gte = filter.from;
  if (filter.to) createdAt.lte = filter.to;

  const found = [];
  for (const batch of inBatches(owned, CHAT_TURN_SESSION_BATCH)) {
    found.push(
      ...(await prisma.tokenUsage.findMany({
        where: {
          projectId: { in: [...new Set(batch.map((s) => s.projectId))] },
          sessionId: { in: batch.map((s) => s.id) },
          agentStep: { in: [...CHAT_TURN_LEDGER_STEPS] },
          ...(filter.from || filter.to ? { createdAt } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take,
        select: {
          ...LEDGER_USAGE_SELECT,
          id: true,
          sessionId: true,
          projectId: true,
          agentStep: true,
          createdAt: true,
        },
      })),
    );
  }
  // A ledger row is the session's only under the session's own project.
  const rows = found
    .filter((r) => r.sessionId !== null && sessionProject.get(r.sessionId) === r.projectId)
    .sort(newestFirst)
    .slice(0, take);
  const items = rows.map((row) => {
    const one = spend([row]);
    return {
      id: row.id,
      sessionId: row.sessionId,
      projectId: row.projectId,
      step: row.agentStep ?? CHAT_TURN_AGENT_STEP,
      provider: row.provider,
      model: row.model,
      createdAt: row.createdAt,
      requests: one.calls,
      tokens: one.tokens,
      costUsd: one.costUsd,
    };
  });
  return {
    items,
    sessions: await sessionSpend(
      rows.map((r) => r.sessionId as string),
      sessionProject,
    ),
  };
}

/**
 * Each listed session's turn rows, other chat rows and their sum, from the
 * whole ledger. `listed` is ONE PAGE's sessions, so the statement binds at most
 * {@link CHAT_TURN_MAX_LIMIT} ids, as many projects and six steps (406) and
 * needs no batching. It has no `orderBy` or `take` either.
 */
async function sessionSpend(
  listed: readonly string[],
  sessionProject: ReadonlyMap<string, string>,
): Promise<ChatSessionSpend[]> {
  const sessionIds = [...new Set(listed)];
  if (sessionIds.length === 0) return [];
  const turnSteps: readonly string[] = CHAT_TURN_LEDGER_STEPS;
  const rows = await prisma.tokenUsage.findMany({
    where: {
      projectId: { in: [...new Set(sessionIds.map((id) => sessionProject.get(id) as string))] },
      sessionId: { in: sessionIds },
      agentStep: { in: [...CHAT_TURN_LEDGER_STEPS, ...CHAT_SESSION_OTHER_STEPS] },
    },
    select: { ...LEDGER_USAGE_SELECT, sessionId: true, projectId: true, agentStep: true },
  });
  return sessionIds.map((sessionId) => {
    const projectId = sessionProject.get(sessionId) as string;
    const mine = rows.filter((r) => r.sessionId === sessionId && r.projectId === projectId);
    const turns = mine.filter((r) => turnSteps.includes(r.agentStep ?? ""));
    const other = mine.filter((r) => !turnSteps.includes(r.agentStep ?? ""));
    return {
      sessionId,
      projectId,
      turnCount: turns.length,
      turns: spend(turns),
      other: spend(other),
      total: spend(mine),
    };
  });
}
