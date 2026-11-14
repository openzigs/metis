/**
 * #2220 — what counts as an `@mention`, shared by the server (who is notified)
 * and the UI (what shows as a mention chip), so the two cannot disagree.
 *
 * A handle starts after the start of the text or a character that cannot be
 * part of a word or an address, so `ana@example.com` mentions nobody. It is
 * letters, digits, `_`, `.` and `-`, but a trailing `.` or `-` ends the
 * sentence, not the handle: "Thanks @priya." mentions `priya`.
 */
const MENTION_SOURCE = String.raw`(^|[^\w@.])@([A-Za-z0-9_](?:[\w.-]*[A-Za-z0-9_])?)`;

/** One mention in a text: where its `@` sits and the handle after it. */
export interface MentionMatch {
  /** Index of the `@` in the text. */
  index: number;
  /** The handle as written, without the `@`. */
  handle: string;
}

/** Every mention in `text`, in order, with its handle as written. */
export function findMentions(text: string): MentionMatch[] {
  const out: MentionMatch[] = [];
  for (const m of text.matchAll(new RegExp(MENTION_SOURCE, "g"))) {
    out.push({ index: m.index + m[1].length, handle: m[2] });
  }
  return out;
}
