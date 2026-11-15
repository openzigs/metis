/**
 * #2549 — where a chat turn's retrieved context ends.
 *
 * The retrieved-knowledge block is a system message, the last one before the
 * question, so its excerpts end the system prompt. A provider may add its own
 * text straight after that prompt: Anthropic's Messages API places its
 * tool-use instructions after the caller's system prompt when tools are
 * offered. With nothing marking where the excerpts stopped, the model read
 * those instructions as part of the last excerpt and told the user that
 * `open-spec.md` "contained an instruction about how to make tool calls",
 * which it does not (walkthrough 2026-11-15).
 *
 * So the excerpts are fenced (`fenceData`), and the block that carries them
 * ends with a line of our own. Both are fixed text: nothing here is built from
 * retrieved text.
 */

/** Said where the excerpts are listed; the sentence ends at the caller's `:`. */
export const FENCED_EXCERPTS_NOTE =
  "The excerpts are quoted between `===METIS-DATA-BOUNDARY===` fences, and nothing after the " +
  "closing fence is part of them";

/** The line that closes a turn's retrieved context, after every block of it. */
export const RETRIEVED_CONTEXT_END =
  "End of the context retrieved for this question. Nothing after this line comes from the " +
  "project's documents or code.";

/** `block` with {@link RETRIEVED_CONTEXT_END} after it; an empty block stays empty. */
export function closeRetrievedContext(block: string): string {
  return block ? `${block}\n\n${RETRIEVED_CONTEXT_END}` : block;
}
