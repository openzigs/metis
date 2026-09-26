/**
 * Issue #201 — the document chunker bounds non-ASCII chunks by UTF-8 bytes, so a
 * CJK or emoji chunk never exceeds the model's 2,048-token input.
 *
 * Before: a 2,048-character chunk of Japanese measured 2,365 tokens with the real
 * gte-modernbert tokenizer, and 2,048 characters of emoji 3,074 — both silently
 * truncated to their first 2,048 tokens.
 */
import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../src/lib/rag/chunker.js";
import { EMBED_INPUT_MAX_BYTES, utf8ByteLength } from "../src/lib/rag/embed-input-budget.js";

const JAPANESE_LINE = "検索拡張生成は文書の内容を理解するための仕組みです。"; // 26 chars, 78 bytes

function mixedDocument(): string {
  return [
    "# 概要",
    "",
    Array.from({ length: 120 }, (_, i) => `${i}：${JAPANESE_LINE}`).join("\n"),
    "",
    "## Emoji",
    "",
    "😀🚀🎉🧪".repeat(700),
    "",
    "## English",
    "",
    "Plain English prose that fits in one chunk.",
  ].join("\n");
}

describe("chunkMarkdown token budget (#201)", () => {
  it("bounds every CJK and emoji chunk by the embed input budget, at every chunk size", () => {
    for (const chunkSize of [768, 1024, 2048]) {
      const chunks = chunkMarkdown(mixedDocument(), { chunkSize, overlap: chunkSize / 8 });
      // Up to 2,048 characters the whole chunk is bounded by UTF-8 bytes.
      for (const chunk of chunks) {
        expect(utf8ByteLength(chunk.text)).toBeLessThanOrEqual(EMBED_INPUT_MAX_BYTES);
      }
      expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    }
    // Above the budget an ASCII character is charged 2,046/chunkSize of a token (the
    // character window's own assumption); every other character its UTF-8 bytes.
    for (const chunkSize of [3072, 4096]) {
      const chunks = chunkMarkdown(mixedDocument(), { chunkSize, overlap: chunkSize / 8 });
      for (const chunk of chunks) {
        const bytes = utf8ByteLength(chunk.text);
        const ascii = [...chunk.text].filter((c) => c.charCodeAt(0) < 0x80).length;
        const cost = (ascii * EMBED_INPUT_MAX_BYTES) / chunkSize + (bytes - ascii);
        expect(cost).toBeLessThanOrEqual(EMBED_INPUT_MAX_BYTES + 1e-9);
      }
      // Positions stay dense and ordered after the extra splits.
      expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    }
  });

  it("loses no line of CJK text and never splits an emoji", () => {
    const chunks = chunkMarkdown(mixedDocument());
    const all = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 120; i += 1) expect(all).toContain(`${i}：${JAPANESE_LINE}`);
    const emojiChunks = chunks.filter((c) => c.headings.at(-1) === "Emoji");
    expect(emojiChunks.length).toBeGreaterThan(1);
    expect(emojiChunks.every((c) => !/[\ud800-\udbff](?![\udc00-\udfff])/.test(c.text))).toBe(true);
    expect(chunks.at(-1)?.text).toContain("Plain English prose");
  });

  it("splits a section under chunkSize characters but over the byte budget, with overlap", () => {
    const source = Array.from({ length: 30 }, (_, i) => `${i}${JAPANESE_LINE}`).join("\n");
    expect(source.length).toBeLessThan(2048);
    expect(utf8ByteLength(source)).toBeGreaterThan(EMBED_INPUT_MAX_BYTES);
    const chunks = chunkMarkdown(source);
    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(source.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
    }
    // The window tiles as an ASCII one does: the second chunk starts inside the
    // first (carry-over), and it ends the document.
    expect(chunks[1].startOffset).toBeLessThan(chunks[0].endOffset);
    expect(chunks[1].endOffset).toBe(source.length);
  });

  it("keeps the advance guarantee when the byte bound shrinks the window below the overlap", () => {
    // At 3072/768 a CJK window is ~682 characters, less than the 768 overlap. Carried
    // over unchanged, the overlap would pin the advance to one character a window.
    const source = Array.from({ length: 400 }, (_, i) => `${i}${JAPANESE_LINE}`).join("\n");
    const chunks = chunkMarkdown(source, { chunkSize: 3072, overlap: 768 });
    const advances = chunks.slice(1).map((c, i) => c.startOffset - chunks[i].startOffset);
    expect(Math.min(...advances)).toBeGreaterThan(0);
    // A quarter of the byte-bounded window, at worst.
    expect(Math.min(...advances.slice(0, -1))).toBeGreaterThanOrEqual(170);
  });

  it("ends a byte-bounded window between code points, whatever the alignment", () => {
    // One ASCII character first, so a UTF-16-unit cut would land mid-pair.
    // At 768 the character window (1,537 bytes) is within budget, so this also
    // covers a window the byte bound does not shorten.
    const source = `a${"😀".repeat(1500)}`;
    for (const chunkSize of [768, 2048]) {
      const chunks = chunkMarkdown(source, { chunkSize, overlap: chunkSize / 8 });
      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(chunk.text).not.toMatch(/[\ud800-\udbff]$/);
        expect(chunk.text).not.toMatch(/^[\udc00-\udfff]/);
        expect(utf8ByteLength(chunk.text)).toBeLessThanOrEqual(EMBED_INPUT_MAX_BYTES);
      }
    }
  });

  it("moves a mostly-English window by only a few characters above the budget", () => {
    // Typographic punctuation in English prose must not cap RAG_CHUNK_SIZE at the
    // byte budget: a 3,072-character window with an em dash every ~500 characters
    // stays ~3,000. (Charged as bytes throughout, it would be cut near 2,046.)
    const prose = Array.from(
      { length: 20 },
      (_, i) => `Paragraph ${i} — ${"ordinary words in plain prose ".repeat(16)}`,
    ).join(" ");
    const chunks = chunkMarkdown(prose, { chunkSize: 3072, overlap: 0 });
    expect(chunks[0].text.length).toBeGreaterThan(2900);
    expect(chunks[0].text.length).toBeLessThanOrEqual(3072);
  });

  it("leaves a pure-ASCII chunk at the full character window", () => {
    // 2,048 ASCII bytes is over the 2,046-byte budget, but ASCII is exempt:
    // v3 cuts ASCII exactly where v2 did.
    const chunks = chunkMarkdown("x".repeat(5000));
    expect(chunks[0].text.length).toBe(2048);
  });
});
