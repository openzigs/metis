/**
 * Epic #156 (#150) — Context compaction.
 *
 * Implements both auto + on-demand summarization of older turns. Pure
 * functions for the message-array reshaping; the side-effecting glue is in
 * `compactSession()` which loads the session, mutates the snapshot, and
 * writes the new `lastCompactedAt` + `compactionCount` fields.
 */
import { prisma } from "../prisma.js";

export interface ChatTurn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface CompactionResult {
  before: ChatTurn[];
  after: ChatTurn[];
  beforeTokens: number;
  afterTokens: number;
  summarizedTurns: number;
}

/** Cheap token approximation: ~1 token / 4 characters. Matches Anthropic
 *  documented heuristic and is more than sufficient for threshold gating. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function totalTokens(messages: ChatTurn[]): number {
  return messages.reduce((s, m) => s + estimateTokens(m.content), 0);
}

export type Summarizer = (turns: ChatTurn[]) => Promise<string>;

const SYSTEM_PROMPT =
  "You are a context compactor. Summarize the prior turns preserving every concrete decision, " +
  "fact, citation, file path, and unresolved TODO. Be terse — 30% of the original length max. " +
  "Output a single coherent paragraph.";

export interface CompactOptions {
  thresholdTokens?: number;
  /** Fraction of oldest turns to summarize (default 0.7 — keep newest 30%). */
  oldestFraction?: number;
  summarizer?: Summarizer;
}

const DEFAULT_THRESHOLD = 60_000;

/**
 * Reshape a message array by summarizing the oldest fraction. Pure — the
 * `summarizer` is the only side-effecting input. Returns the new array AND
 * the original so callers can audit the diff.
 */
export async function compactMessages(
  messages: ChatTurn[],
  opts: CompactOptions = {},
): Promise<CompactionResult> {
  const threshold = opts.thresholdTokens ?? DEFAULT_THRESHOLD;
  const fraction = opts.oldestFraction ?? 0.7;
  const beforeTokens = totalTokens(messages);
  if (beforeTokens <= threshold) {
    return {
      before: messages,
      after: messages,
      beforeTokens,
      afterTokens: beforeTokens,
      summarizedTurns: 0,
    };
  }

  // Always preserve any leading system messages verbatim — the system prompt
  // is identity-defining and must not be replaced.
  let leadingSystem = 0;
  while (leadingSystem < messages.length && messages[leadingSystem]!.role === "system") {
    leadingSystem++;
  }
  const head = messages.slice(0, leadingSystem);
  const body = messages.slice(leadingSystem);
  const summarizeCount = Math.max(1, Math.floor(body.length * fraction));
  const toSummarize = body.slice(0, summarizeCount);
  const tail = body.slice(summarizeCount);

  const summarize = opts.summarizer ?? defaultSummarizer;
  const summary = await summarize(toSummarize);
  const after: ChatTurn[] = [
    ...head,
    {
      role: "system",
      content: `[Compacted summary of ${toSummarize.length} prior turns]\n${summary}`,
    },
    ...tail,
  ];
  return {
    before: messages,
    after,
    beforeTokens,
    afterTokens: totalTokens(after),
    summarizedTurns: toSummarize.length,
  };
}

const defaultSummarizer: Summarizer = async (turns) => {
  // Default deterministic summarizer — concatenates head/tail of each turn.
  // The route-level handler injects a real LLM-backed summarizer. Tests use
  // a canned summarizer so the assertions are stable.
  const lines = turns.map((t) => `${t.role}: ${truncate(t.content, 60)}`);
  return lines.join(" | ");
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export interface SessionLike {
  id: string;
  snapshot: string | null;
  compactionCount: number;
  projectId: string | null;
}

/**
 * Compact a session's message history. Returns `{compacted: false}` when the
 * snapshot is below threshold. The session snapshot string is JSON of
 * `{ messages: ChatTurn[] }` — extra fields are passed through.
 */
export async function compactSession(
  sessionId: string,
  opts: CompactOptions = {},
): Promise<{
  compacted: boolean;
  before: number;
  after: number;
  summarizedTurns: number;
}> {
  const session = await prisma.aISession.findUnique({
    where: { id: sessionId },
    select: { id: true, snapshot: true, compactionCount: true, projectId: true },
  });
  if (!session) throw new Error("SESSION_NOT_FOUND");
  const snap: { messages?: ChatTurn[]; [k: string]: unknown } = session.snapshot
    ? (JSON.parse(String(session.snapshot)) as { messages?: ChatTurn[] })
    : { messages: [] };
  const messages: ChatTurn[] = Array.isArray(snap.messages) ? snap.messages : [];

  const threshold = await resolveThreshold(session.projectId, opts.thresholdTokens);
  const result = await compactMessages(messages, { ...opts, thresholdTokens: threshold });
  if (result.summarizedTurns === 0) {
    return {
      compacted: false,
      before: result.beforeTokens,
      after: result.afterTokens,
      summarizedTurns: 0,
    };
  }
  const newSnapshot = JSON.stringify({ ...snap, messages: result.after });
  await prisma.aISession.update({
    where: { id: sessionId },
    data: {
      snapshot: newSnapshot,
      snapshotUpdatedAt: new Date(),
      lastCompactedAt: new Date(),
      compactionCount: { increment: 1 },
    },
  });
  return {
    compacted: true,
    before: result.beforeTokens,
    after: result.afterTokens,
    summarizedTurns: result.summarizedTurns,
  };
}

/** Auto-compaction wrapper used by chat hot path. Cheap when below threshold. */
export async function compactIfNeeded(
  sessionId: string,
  opts: CompactOptions = {},
): Promise<{ compacted: boolean }> {
  const r = await compactSession(sessionId, opts);
  return { compacted: r.compacted };
}

async function resolveThreshold(
  projectId: string | null,
  override: number | undefined,
): Promise<number> {
  if (override) return override;
  if (projectId) {
    const proj = await prisma.project.findUnique({
      where: { id: projectId },
      select: { contextCompactionThreshold: true },
    });
    if (proj?.contextCompactionThreshold) return proj.contextCompactionThreshold;
  }
  const env = Number.parseInt(process.env.CONTEXT_COMPACTION_THRESHOLD_TOKENS ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_THRESHOLD;
}

export const COMPACTION_SYSTEM_PROMPT = SYSTEM_PROMPT;
