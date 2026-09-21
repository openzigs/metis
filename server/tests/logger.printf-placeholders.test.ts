/**
 * #21 — log messages must carry real values, never literal printf placeholders.
 *
 * The logger (`src/lib/logger.ts`) has no `format.splat()`, so a call such as
 * `log.info("Extracted %d requirements", n)` printed `%d` verbatim and dropped
 * `n` on the floor. The fix moves every value into structured meta rather than
 * adding `splat()`: interpolating into `message` would route values PAST the
 * redactor, which deliberately skips `message` (`redactInfo`).
 *
 * Two layers:
 *   1. Behaviour — the two call sites the issue names are driven through the
 *      REAL logger, and the emitted record is read back off a transport.
 *   2. Drift guard — every `<x>.<level>("…%d…")` literal in `server/src` is
 *      re-derived from disk, so a new printf-style call fails the build.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import winston from "winston";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/lib/logger.js";
import { RequirementsExtractor } from "../src/lib/analysis/requirements-extractor.js";
import { ClaimExtractor } from "../src/lib/docs-gen/grounding/claim-extractor.js";
import { buildGroundingContext } from "../src/lib/docs-gen/grounding/grounding-context.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";

const PRINTF_TOKEN = /%[sdifjoO]/;

function mockProvider(content: string): AIProvider {
  return {
    key: "test",
    model: "test-model",
    offline: false,
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "test-model",
      provider: "test",
    } as ChatResponse),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

describe("log records carry values, not printf placeholders (#21)", () => {
  let lines: string[];
  let transport: winston.transport;
  const prevLevel = logger.level;

  beforeEach(() => {
    lines = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    transport = new winston.transports.Stream({ stream: sink });
    logger.add(transport);
    logger.level = "info";
  });

  afterEach(() => {
    logger.remove(transport);
    logger.level = prevLevel;
  });

  /** Records emitted by one module, parsed from the transport's output. */
  function recordsFor(module: string): Array<Record<string, unknown>> {
    return lines
      .flatMap((chunk) => chunk.split("\n"))
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.module === module);
  }

  it("requirements-extractor logs the input size and the extracted counts", async () => {
    const llm = JSON.stringify({
      requirements: [
        {
          title: "A",
          description: "a",
          type: "functional",
          priority: "must-have",
          ambiguities: [{ field: "x", description: "d", suggestedQuestion: "q" }],
          evidenceNeeds: [
            { description: "e1", domain: "security", searchHints: [] },
            { description: "e2", domain: "security", searchHints: [] },
          ],
        },
        { title: "B", description: "b", type: "functional", priority: "must-have" },
      ],
    });
    const input = "The system needs sign-in."; // 25 chars
    await new RequirementsExtractor({ provider: mockProvider(llm) }).extract(input);

    const records = recordsFor("requirements-extractor");
    expect(records).toHaveLength(2);
    for (const r of records) expect(String(r.message)).not.toMatch(PRINTF_TOKEN);
    expect(records[0]).toMatchObject({ chars: input.length });
    expect(records[1]).toMatchObject({ requirements: 2, ambiguities: 1, evidenceNeeds: 2 });
  });

  it("claim-extractor logs the section size", async () => {
    const ctx = buildGroundingContext({
      ragChunks: [{ documentId: "d", chunkId: "c", filename: "F.java", text: "t" }],
      webDigests: [],
    });
    const section = "Invoices over 1000 need approval.";
    await new ClaimExtractor({ provider: mockProvider('{"claims":[]}') }).decompose(section, ctx);

    const records = recordsFor("docs-gen:claim-extractor");
    expect(records).toHaveLength(1);
    expect(String(records[0]!.message)).not.toMatch(PRINTF_TOKEN);
    expect(records[0]).toMatchObject({ chars: section.length });
  });
});

// ── Drift guard ──────────────────────────────────────────────────────────────

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Find `<ident>.<level>(` followed (across newlines) by a string literal whose
 * text contains a printf token. Returns
 * `file:line  message` strings so a failure names every offender.
 */
function findPrintfLogCalls(source: string, file = "<source>"): string[] {
  const call =
    /\b\w+\.(?:info|warn|error|debug|verbose|silly)\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  const hits: string[] = [];
  for (const m of source.matchAll(call)) {
    if (!PRINTF_TOKEN.test(m[2]!)) continue;
    const line = source.slice(0, m.index).split("\n").length;
    hits.push(`${file}:${line}  ${m[2]}`);
  }
  return hits;
}

describe("no printf-style log messages in server/src (#21 drift guard)", () => {
  it("the scanner recognises the defect shape (so an empty result means something)", () => {
    expect(findPrintfLogCalls('log.info(\n  "Extracted %d requirements",\n  n,\n);')).toHaveLength(
      1,
    );
    expect(findPrintfLogCalls('log.info("Extracted requirements", { n });')).toHaveLength(0);
  });

  it("scans a non-trivial number of source files", () => {
    expect(collectSourceFiles(SRC_ROOT).length).toBeGreaterThan(200);
  });

  it("finds no log call whose message literal contains %s/%d/%j/…", () => {
    const offenders = collectSourceFiles(SRC_ROOT).flatMap((f) =>
      findPrintfLogCalls(readFileSync(f, "utf8"), path.relative(SRC_ROOT, f)),
    );
    expect(offenders).toEqual([]);
  });
});
