/**
 * Epic #127 / #136 — carry a pre-transcript session's conversation over.
 *
 * Before `ai_messages` existed, the only server-side copy of a conversation was
 * the session `snapshot` (#1367), written after each streamed turn. A session
 * opened for the first time after the upgrade has no transcript rows; without
 * this import its earlier turns would simply vanish from resume.
 *
 * Only `user` and `assistant` text is imported, each row tagged
 * `meta.importedFrom = "legacy-snapshot"` so its provenance stays visible. The
 * import runs only while the session has NO transcript rows, so it happens at
 * most once and never mixes into a live transcript: the rows take ordinals
 * 1..n inside one transaction, so of two concurrent first reads exactly one
 * import lands — the other hits the `(sessionId, ordinal)` unique index, rolls
 * back and writes nothing (PR #205 review).
 */
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { countMessages, messageRowData } from "./transcript-store.js";
import { DEFAULT_CHARS_PER_TOKEN } from "./token-estimator.js";

const log = createChildLogger("legacy-snapshot");

/** Import the snapshot's turns; returns how many rows were written. */
export async function importLegacySnapshot(
  sessionId: string,
  snapshotJson: string,
): Promise<number> {
  let messages: unknown;
  try {
    const snap = JSON.parse(snapshotJson) as { messages?: unknown; derivedFrom?: unknown } | null;
    // A snapshot DERIVED from the transcript is a copy, not a legacy source.
    if (snap?.derivedFrom === "ai_messages") return 0;
    messages = snap?.messages;
  } catch {
    return 0;
  }
  if (!Array.isArray(messages)) return 0;
  const turns = messages.filter(
    (m): m is { role: "user" | "assistant"; content: string } =>
      !!m &&
      typeof m === "object" &&
      ((m as { role?: unknown }).role === "user" ||
        (m as { role?: unknown }).role === "assistant") &&
      typeof (m as { content?: unknown }).content === "string" &&
      (m as { content: string }).content.length > 0,
  );
  if (turns.length === 0) return 0;
  if ((await countMessages(sessionId)) > 0) return 0;
  try {
    await prisma.$transaction(async (tx) => {
      let ordinal = 0;
      for (const t of turns) {
        await tx.aIMessage.create({
          data: messageRowData(sessionId, ++ordinal, {
            role: t.role,
            parts: [{ type: "text", text: t.content }],
            estimatedTokens: Math.ceil(t.content.length / DEFAULT_CHARS_PER_TOKEN),
            meta: { importedFrom: "legacy-snapshot" },
          }),
        });
      }
    });
  } catch (err) {
    // Another request imported (or appended) first; its rows stand.
    if ((err as { code?: unknown }).code === "P2002") return 0;
    throw err;
  }
  log.info("Imported a pre-transcript session snapshot", { sessionId, messages: turns.length });
  return turns.length;
}
