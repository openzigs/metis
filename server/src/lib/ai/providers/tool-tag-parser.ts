/**
 * Inline tool-tag stream parser (#718).
 *
 * Some text-only provider paths — most notably the local-gemma / qwen2.5
 * chat-template convention — hallucinate textual tool calls of the shape:
 *
 *   <tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>
 *   <tool_response>{"output":"..."}</tool_response>
 *
 * These providers stream plain text deltas, so without intervention the raw
 * XML leaks verbatim into the rendered chat. This parser sits at the provider
 * boundary and converts inline tool XML into structured `tool_call` ChatChunk
 * events, removing it from the visible text stream.
 *
 * Design constraints:
 * - **Streaming-safe.** A single tag may be split across two (or more) deltas.
 *   The parser buffers the boundary and never emits a half-tag.
 * - **Bounded scanning.** Detection uses `indexOf`/`startsWith` only — no
 *   backtracking regex — so it cannot be driven into ReDoS (Semgrep-clean).
 * - **Code-block safe.** A lone `<` that is not the prefix of a tool tag (e.g.
 *   `<div>` inside a fenced code block) is passed through untouched.
 *
 * Usage: one parser instance per stream. Feed each text delta to `push()` and
 * yield the returned chunks; call `flush()` once at end-of-stream to drain any
 * buffered plain text.
 */
import type { ChatChunk } from "../types.js";

/** Chunks the parser can emit — a subset of {@link ChatChunk}. */
export type ToolTagChunk =
  | { type: "delta"; content: string }
  | { type: "tool_call"; name: string; arguments: unknown; toolCallId?: string };

const OPEN_TAGS = ["<tool_call>", "<tool_response>"] as const;
type OpenTag = (typeof OPEN_TAGS)[number];

const CLOSE_TAG: Record<OpenTag, string> = {
  "<tool_call>": "</tool_call>",
  "<tool_response>": "</tool_response>",
};

/**
 * Hard cap on buffered tool-body length. Real hallucinated tool calls are tiny
 * JSON blobs; a body that grows past this without a closing tag is pathological
 * (or malicious), so we abandon it rather than buffer unboundedly.
 */
const MAX_TOOL_BODY = 100_000;

type OpenMatch = { kind: "full"; tag: OpenTag } | { kind: "partial" } | { kind: "none" };

/**
 * Classify a buffer that begins with `<` against the known open tags.
 * - `full` — the buffer starts with a complete open tag.
 * - `partial` — the buffer is a proper prefix of an open tag; more data needed.
 * - `none` — the `<` cannot begin a tool tag (safe to emit as literal text).
 */
function matchOpenTag(buffer: string): OpenMatch {
  for (const tag of OPEN_TAGS) {
    if (buffer.startsWith(tag)) return { kind: "full", tag };
  }
  for (const tag of OPEN_TAGS) {
    // buffer is shorter than tag AND is a prefix of it → could complete later.
    if (buffer.length < tag.length && tag.startsWith(buffer)) return { kind: "partial" };
  }
  return { kind: "none" };
}

function parseToolBody(tag: OpenTag, rawBody: string): ToolTagChunk {
  const body = rawBody.trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (tag === "<tool_call>") {
    const obj = (parsed ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof obj.name === "string" && obj.name ? obj.name : "tool";
    const args = obj.arguments ?? (parsed !== null ? parsed : body);
    return { type: "tool_call", name, arguments: args };
  }
  // <tool_response> — a hallucinated tool result. Surface it structurally so it
  // never renders as literal text; the arguments carry the (parsed) payload.
  return { type: "tool_call", name: "tool_response", arguments: parsed !== null ? parsed : body };
}

export class ToolTagStreamParser {
  private buffer = "";
  /** Non-null while scanning inside an open tool block. */
  private openTag: OpenTag | null = null;

  /** Feed a text delta; returns the chunks emitted so far. */
  push(text: string): ToolTagChunk[] {
    if (text) this.buffer += text;
    return this.drain(false);
  }

  /** Drain remaining buffered text at end-of-stream. */
  flush(): ToolTagChunk[] {
    const out = this.drain(true);
    // An unterminated tool block is dropped — never leak a half-tag.
    this.openTag = null;
    this.buffer = "";
    return out;
  }

  private drain(final: boolean): ToolTagChunk[] {
    const out: ToolTagChunk[] = [];
    for (;;) {
      if (this.openTag) {
        const close = CLOSE_TAG[this.openTag];
        const idx = this.buffer.indexOf(close);
        if (idx === -1) {
          // No complete closing tag yet. Guard against unbounded buffering.
          if (this.buffer.length > MAX_TOOL_BODY) {
            this.buffer = "";
            this.openTag = null;
          }
          return out; // wait for more data (or drop at flush)
        }
        const body = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + close.length);
        out.push(parseToolBody(this.openTag, body));
        this.openTag = null;
        continue;
      }

      const lt = this.buffer.indexOf("<");
      if (lt === -1) {
        if (this.buffer) {
          out.push({ type: "delta", content: this.buffer });
          this.buffer = "";
        }
        return out;
      }
      if (lt > 0) {
        out.push({ type: "delta", content: this.buffer.slice(0, lt) });
        this.buffer = this.buffer.slice(lt);
      }

      const m = matchOpenTag(this.buffer);
      if (m.kind === "full") {
        this.openTag = m.tag;
        this.buffer = this.buffer.slice(m.tag.length);
        continue;
      }
      if (m.kind === "partial") {
        // Might complete into an open tag once more data arrives. Hold it back
        // unless the stream has ended, in which case it was just literal text.
        if (final && this.buffer) {
          out.push({ type: "delta", content: this.buffer });
          this.buffer = "";
        }
        return out;
      }
      // kind === "none": this `<` is literal text (e.g. `<div>`). Emit it and
      // keep scanning after it.
      out.push({ type: "delta", content: "<" });
      this.buffer = this.buffer.slice(1);
    }
  }
}

/** Convenience: parse a complete (non-streamed) string in one shot. */
export function parseToolTags(text: string): ToolTagChunk[] {
  const parser = new ToolTagStreamParser();
  return [...parser.push(text), ...parser.flush()];
}

/** Narrowing helper so providers can yield parser output as {@link ChatChunk}. */
export function asChatChunk(chunk: ToolTagChunk): ChatChunk {
  return chunk;
}
