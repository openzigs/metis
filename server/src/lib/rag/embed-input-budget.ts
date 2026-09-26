/**
 * Issue #201 — how much text one embedding input may carry, bounded by TOKENS.
 *
 * #189 capped the in-process model at {@link MAX_EMBED_SEQUENCE_TOKENS} and argued
 * that every chunk fits because "a BPE token covers at least one character". That
 * holds for ASCII and fails for everything else: gte-modernbert's tokenizer is a
 * byte-level BPE, so a character outside ASCII is 2–4 UTF-8 bytes and can be as
 * many tokens. Measured with the real tokenizer on 2,048-character inputs:
 *
 *   | text                     | UTF-8 bytes | tokens (incl. specials) |
 *   | ------------------------ | ----------- | ----------------------- |
 *   | English prose            | 2,048       | 458                     |
 *   | common Japanese          | 6,144       | 2,365                   |
 *   | emoji                    | 4,096       | 3,074                   |
 *   | rare CJK ideographs      | 6,144       | 5,378                   |
 *
 * Every one of the last three was silently truncated at 2,048 tokens, so the
 * stored vector described only the head of its chunk.
 *
 * The bound used instead is the UTF-8 byte length. A byte-level BPE token covers
 * at least one byte (merges only ever join bytes), so a text of `n` bytes is at
 * most `n` tokens plus the model's special tokens — for gte-modernbert `[CLS]` and
 * `[SEP]`. It needs no tokenizer, so a chunker can apply it on the main thread for
 * any backend, and it is tight where it matters: rare CJK measured 0.875 tokens
 * per byte.
 */

/**
 * Issue #189 — the longest token sequence the in-process model is ever given.
 * Re-exported by `embedder.ts`; lives here so the chunkers can bound their output
 * without importing the embedder.
 */
export const MAX_EMBED_SEQUENCE_TOKENS = 2048;

/** Special tokens the tokenizer adds around every input (`[CLS]` … `[SEP]`). */
export const EMBED_SEQUENCE_SPECIAL_TOKENS = 2;

/**
 * The most UTF-8 bytes one embedding input may carry and still be embedded
 * whole: at most one token per byte, plus the special tokens.
 */
export const EMBED_INPUT_MAX_BYTES = MAX_EMBED_SEQUENCE_TOKENS - EMBED_SEQUENCE_SPECIAL_TOKENS;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * True when `text` could be truncated by the model: it holds non-ASCII text and
 * its UTF-8 encoding exceeds {@link EMBED_INPUT_MAX_BYTES}. The generated-doc
 * chunker splits such chunks; the document chunker applies the same bound inside
 * its window (`chunker.ts` `windowEnd`).
 *
 * Pure-ASCII text is exempt on purpose. There a byte IS a character, so the
 * chunkers' character windows already bound it (#189's argument holds for ASCII),
 * and exempting it keeps every existing ASCII chunk byte-identical.
 */
export function exceedsEmbedInputBudget(text: string): boolean {
  const bytes = utf8ByteLength(text);
  return bytes > text.length && bytes > EMBED_INPUT_MAX_BYTES;
}

/**
 * Split `text` into pieces of at most `maxBytes` UTF-8 bytes, in order and losing
 * nothing (`pieces.join("")` reproduces `text`): at line breaks first, so a table
 * or a code block stays row-aligned, then — for a single line over budget — at a
 * code-point boundary, never inside a surrogate pair.
 */
export function splitToByteBudget(
  text: string,
  maxBytes: number = EMBED_INPUT_MAX_BYTES,
): string[] {
  if (maxBytes < 4) throw new RangeError("maxBytes must hold at least one code point (4 bytes)");
  if (utf8ByteLength(text) <= maxBytes) return [text];
  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  const flush = () => {
    if (current) pieces.push(current);
    current = "";
    currentBytes = 0;
  };
  // Keep each line's trailing "\n" on the line, so joining the pieces is exact.
  for (const line of text.split(/(?<=\n)/)) {
    const lineBytes = utf8ByteLength(line);
    if (currentBytes + lineBytes <= maxBytes) {
      current += line;
      currentBytes += lineBytes;
      continue;
    }
    flush();
    if (lineBytes <= maxBytes) {
      current = line;
      currentBytes = lineBytes;
      continue;
    }
    for (const codePoint of line) {
      const cpBytes = utf8ByteLength(codePoint);
      if (currentBytes + cpBytes > maxBytes) flush();
      current += codePoint;
      currentBytes += cpBytes;
    }
  }
  flush();
  return pieces;
}
