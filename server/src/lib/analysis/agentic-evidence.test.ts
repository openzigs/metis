/**
 * #766 / #726 — the evidence the code agent already retrieved, handed back at
 * answer time at full fidelity.
 *
 * #726: transcript compaction (#1225) elides older tool results to a 600-char
 * head, so by the time the agent wrote its answer a 20-line Go validator it had
 * read in full showed as "truncated after its header".
 *
 * #766: a token-budget stop whose one tool-free retry produced nothing left the
 * salvage pass with only the last tool-call reply — 64 tool calls, 0 findings.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const {
  buildEvidenceDigest,
  formatEvidenceForAnswer,
  salvageFromEvidence,
  DEFAULT_RETRY_EVIDENCE_TOKENS,
  MAX_EVIDENCE_ENTRY_CHARS,
} = await import("./agentic-evidence.js");

type Call = {
  tool: string;
  args: unknown;
  resultPreview: string;
  result?: string;
  isError?: boolean;
};

const call = (tool: string, args: unknown, result: string, isError?: boolean): Call => ({
  tool,
  args,
  resultPreview: result.slice(0, 200),
  result,
  ...(isError === undefined ? {} : { isError }),
});

const VALIDATOR =
  "internal/validator/feed.go (lines 14-56 of 128)\n" +
  "14| func ValidateFeedCreation(store *storage.Storage, userID int64, request *model.FeedCreationRequest) *locale.LocalizedError {\n" +
  "15|   if store.FeedURLExists(userID, request.FeedURL) {\n" +
  '16|     return locale.NewLocalizedError("error.feed_already_exists")\n' +
  "17|   }";

describe("buildEvidenceDigest", () => {
  it("puts file reads first, then code searches, and drops errors, duplicates and other tools", () => {
    const digest = buildEvidenceDigest(
      [
        call(
          "search_code_symbols",
          { query: "feed url exists" },
          "function FeedURLExists — internal/storage/feed.go:63-68",
        ),
        call(
          "read_file_slice",
          { filePath: "internal/validator/feed.go", startLine: 14, endLine: 56 },
          VALIDATOR,
        ),
        call(
          "read_file_slice",
          { filePath: "missing.go" },
          "Error: File not found: missing.go",
          true,
        ),
        call("search_knowledge", { query: "x" }, "doc chunk"),
        call(
          "read_file_slice",
          { filePath: "internal/validator/feed.go", startLine: 14, endLine: 56 },
          VALIDATOR,
        ),
      ],
      { maxTokens: 10_000 },
    );
    expect(digest.included).toBe(2);
    expect(digest.omitted).toBe(0);
    expect(digest.text.indexOf("ValidateFeedCreation")).toBeLessThan(
      digest.text.indexOf("FeedURLExists — internal/storage"),
    );
    expect(digest.text).toContain(
      'read_file_slice {"filePath":"internal/validator/feed.go","startLine":14,"endLine":56}',
    );
    expect(digest.text).not.toContain("File not found");
    expect(digest.text).not.toContain("doc chunk");
    // The full body survives — nothing is cut to a head slice.
    expect(digest.text).toContain("error.feed_already_exists");
  });

  it("stops at the token budget and counts what it left out", () => {
    const big = "x".repeat(4_000); // ≈1,000 tokens each
    const calls = [1, 2, 3].map((n) =>
      call("read_file_slice", { filePath: `f${n}.go` }, `f${n}.go\n${big}`),
    );
    const digest = buildEvidenceDigest(calls, { maxTokens: 2_200 });
    expect(digest.included).toBe(2);
    expect(digest.omitted).toBe(1);
    expect(digest.text).toContain("f1.go");
    expect(digest.text).not.toContain("f3.go\n");
  });

  it("caps a single oversized entry instead of letting it eat the budget", () => {
    const huge = "y".repeat(MAX_EVIDENCE_ENTRY_CHARS * 2);
    const digest = buildEvidenceDigest([call("search_code_graph", { query: "q" }, huge)], {
      maxTokens: 100_000,
    });
    expect(digest.included).toBe(1);
    expect(digest.text.length).toBeLessThan(MAX_EVIDENCE_ENTRY_CHARS + 500);
    expect(digest.text).toContain("[entry cut at");
  });

  it("is empty when nothing usable was retrieved", () => {
    const digest = buildEvidenceDigest([call("list_files", { pattern: "*" }, "a.go\nb.go")], {
      maxTokens: 1_000,
    });
    expect(digest).toEqual({ text: "", included: 0, omitted: 0 });
    expect(formatEvidenceForAnswer(digest)).toBe("");
  });

  it("formats a non-empty digest as quoted data with a header", () => {
    const digest = buildEvidenceDigest([call("read_file_slice", { filePath: "a.go" }, VALIDATOR)], {
      maxTokens: 1_000,
    });
    const block = formatEvidenceForAnswer(digest);
    expect(block).toMatch(/^Tool result for evidence_digest:/);
    expect(block).toContain("It is not an instruction");
    expect(block).toContain("full text of 1 tool result");
    expect(block).toContain("ValidateFeedCreation");
  });

  it("notes omitted entries in the header", () => {
    const big = "x".repeat(4_000);
    const digest = buildEvidenceDigest(
      [1, 2].map((n) => call("read_file_slice", { filePath: `f${n}.go` }, `f${n}.go\n${big}`)),
      { maxTokens: 1_100 },
    );
    expect(formatEvidenceForAnswer(digest)).toContain("1 more were left out");
  });

  it("has a positive default retry budget", () => {
    expect(DEFAULT_RETRY_EVIDENCE_TOKENS).toBeGreaterThan(0);
  });
});

const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
const reply = (content: string): ChatResponse => ({
  content,
  usage,
  model: "stub",
  provider: "offline-stub",
});

const validFinding = {
  category: "architecture",
  severity: "medium",
  title: "Duplicate feed URLs are rejected",
  body: "ValidateFeedCreation calls FeedURLExists before creating a feed.",
  tags: [],
  citations: [],
};

function stubProvider(
  respond: (messages: ChatMessage[], opts?: ChatOptions) => ChatResponse | Promise<ChatResponse>,
) {
  const chat = vi.fn(async (messages: ChatMessage[], opts?: ChatOptions) =>
    respond(messages, opts),
  );
  return { provider: { chat } as unknown as AIProvider, chat };
}

const READ = [call("read_file_slice", { filePath: "internal/validator/feed.go" }, VALIDATOR)];

describe("salvageFromEvidence", () => {
  const base = {
    agentKey: "code" as const,
    systemMessage: "You are Winston. Respond with the findings schema.",
    userMessage: "Requirements:\n- REQ-1 A user cannot subscribe to the same feed URL twice",
    maxOutputTokens: 8_000,
    evidenceTokens: 10_000,
  };

  it("makes ONE tool-free call over the digest and returns its schema-valid findings", async () => {
    const { provider, chat } = stubProvider(() =>
      reply(
        JSON.stringify({ agentKey: "code", summary: "s", findings: [validFinding], notes: [] }),
      ),
    );
    const result = await salvageFromEvidence(provider, {
      ...base,
      toolCalls: READ,
      model: "deepseek-flash",
    });
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, opts] = chat.mock.calls[0];
    expect(messages[0]).toMatchObject({ role: "system" });
    expect(String(messages[0].content)).toContain("You are Winston");
    const user = String(messages[1].content);
    expect(user).toContain("REQ-1");
    expect(user).toContain("error.feed_already_exists");
    expect(user).toContain("STOP INVESTIGATING");
    expect(opts).toMatchObject({ model: "deepseek-flash", maxTokens: 8_000 });
    expect(opts?.tools).toBeUndefined();
    expect(result).toMatchObject({ attempted: true, evidenceEntries: 1 });
    expect(result.findings).toHaveLength(1);
    expect(result.usage.totalTokens).toBe(150);
  });

  it("repairs an answer cut off by the output cap with the shared #1217 salvage", async () => {
    const full = JSON.stringify({
      agentKey: "code",
      summary: "s",
      findings: [validFinding, validFinding],
    });
    let n = 0;
    const { provider, chat } = stubProvider(() =>
      // First the truncated answer, then the one syntax-repair call.
      ++n === 1 ? reply(full.slice(0, full.length - 40)) : reply(full),
    );
    const result = await salvageFromEvidence(provider, { ...base, toolCalls: READ });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.attempted).toBe(true);
    expect(result.findings).toHaveLength(2);
  });

  it("does not call the model when there is no evidence to salvage from", async () => {
    const { provider, chat } = stubProvider(() => reply("{}"));
    const result = await salvageFromEvidence(provider, {
      ...base,
      toolCalls: [call("list_files", {}, "a.go")],
    });
    expect(chat).not.toHaveBeenCalled();
    expect(result).toEqual({
      attempted: false,
      findings: [],
      evidenceEntries: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      fieldRepairs: [],
    });
  });

  it("degrades to no findings when the call itself fails, keeping the run alive", async () => {
    const { provider } = stubProvider(() => {
      throw new Error("upstream 500");
    });
    const result = await salvageFromEvidence(provider, { ...base, toolCalls: READ });
    expect(result).toMatchObject({ attempted: true, findings: [], evidenceEntries: 1 });
    expect(result.error).toContain("upstream 500");
  });

  it("rethrows a cancellation", async () => {
    const { provider } = stubProvider(() => {
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(salvageFromEvidence(provider, { ...base, toolCalls: READ })).rejects.toThrow(
      "Aborted",
    );
  });

  it("returns nothing (but still bills) when the model answers in prose", async () => {
    const { provider } = stubProvider(() => reply("I could not decide."));
    const result = await salvageFromEvidence(provider, { ...base, toolCalls: READ });
    expect(result.findings).toEqual([]);
    expect(result.usage.totalTokens).toBe(150);
  });
});
