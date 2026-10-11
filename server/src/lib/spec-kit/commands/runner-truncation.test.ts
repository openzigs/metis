/**
 * #944 item 1 — a Spec Kit call cut off at the output-token cap must not be
 * written as if it were whole. `runSpecKitAgent` salvages the complete lines,
 * asks the model to continue, and — when the cap still wins — returns
 * `truncated: true` and marks the artifact body, so the step can warn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage } from "../../ai/types.js";

vi.mock("../../finops/index.js", () => ({
  assertWithinBudget: vi.fn().mockResolvedValue(undefined),
  recordUsage: vi.fn(),
  BudgetExceededError: class BudgetExceededError extends Error {},
}));
vi.mock("../../safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class SafetyDeniedError extends Error {},
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../../prisma.js", () => ({ prisma: {} }));
vi.mock("../constitution.js", () => ({
  readProjectConstitution: vi.fn().mockResolvedValue(null),
}));
vi.mock("../constitution-meta.js", () => ({
  loadAsPreamble: vi.fn().mockResolvedValue(null),
}));

const {
  runSpecKitAgent,
  keepWholeLines,
  joinContinuation,
  SPEC_KIT_TRUNCATION_NOTE,
  SPEC_KIT_TRUNCATION_NOTE_YAML,
  SPEC_KIT_OUTPUT_EXHAUSTED_CODE,
  SPEC_KIT_EMPTY_OUTPUT_CODE,
  isIncompleteArtifact,
  keepsPriorVersion,
} = await import("./runner.js");

const project = {
  id: "p1",
  name: "Proj",
  description: "",
  safetyMode: "standard" as const,
  aiProviderId: null,
};

type Reply = { content: string; finishReason?: string };

function scriptedProvider(replies: Reply[]): {
  provider: AIProvider;
  calls: ChatMessage[][];
} {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const provider = {
    key: "anthropic",
    model: "m",
    offline: false,
    async chat(messages: ChatMessage[]) {
      calls.push(messages.map((m) => ({ ...m })));
      const r = replies[Math.min(i++, replies.length - 1)];
      return {
        content: r.content,
        ...(r.finishReason ? { finishReason: r.finishReason } : {}),
        provider: "anthropic",
        model: "m",
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  } as unknown as AIProvider;
  return { provider, calls };
}

const run = (provider: AIProvider) =>
  runSpecKitAgent({
    command: "plan",
    project,
    systemPrompt: "Base.",
    userPrompt: "Produce quickstart.md.",
    deps: { provider },
  });

describe("keepWholeLines / joinContinuation", () => {
  it("drops the partial last line and keeps the newline", () => {
    expect(keepWholeLines("# Q\n\n- step one\n- see `client/client.go:327")).toBe(
      "# Q\n\n- step one\n",
    );
  });
  it("returns empty when no line was finished", () => {
    expect(keepWholeLines("half a line")).toBe("");
  });
  it("joins a continuation onto the kept prefix without repeating blank lines", () => {
    expect(joinContinuation("# Q\n- a\n", "\n- b\n")).toBe("# Q\n- a\n- b\n");
    expect(joinContinuation("", "- b")).toBe("- b");
  });
});

describe("runSpecKitAgent output-cap recovery (#944)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a complete reply is one call, untouched, and not truncated", async () => {
    const { provider, calls } = scriptedProvider([{ content: "# Done\n", finishReason: "stop" }]);
    const out = await run(provider);
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ content: "# Done\n", truncated: false, continuations: 0 });
  });

  it("salvages whole lines and continues a reply cut at the cap", async () => {
    const { provider, calls } = scriptedProvider([
      {
        content: "# Quickstart\n\n## Run locally\n1. go build\n2. see `client/client.go:327",
        finishReason: "max_tokens",
      },
      { content: "2. run `make test`\n\n## Verify\n- it works\n", finishReason: "end_turn" },
    ]);
    const out = await run(provider);

    expect(calls).toHaveLength(2);
    // The continuation replays the salvaged prefix as the assistant's turn.
    const second = calls[1];
    expect(second[0]).toMatchObject({ role: "user", content: "Produce quickstart.md." });
    expect(second[1]).toMatchObject({
      role: "assistant",
      content: "# Quickstart\n\n## Run locally\n1. go build\n",
    });
    expect(second[2].role).toBe("user");
    expect(String(second[2].content)).toMatch(/continue/i);

    expect(out.content).toBe(
      "# Quickstart\n\n## Run locally\n1. go build\n2. run `make test`\n\n## Verify\n- it works\n",
    );
    expect(out.truncated).toBe(false);
    expect(out.continuations).toBe(1);
    expect(out.tokensUsed).toBe(30);
  });

  it("each call is billed to the ledger", async () => {
    const finops = await import("../../finops/index.js");
    const { provider } = scriptedProvider([
      { content: "a\nb", finishReason: "length" },
      { content: "b\n", finishReason: "stop" },
    ]);
    await run(provider);
    expect(vi.mocked(finops.recordUsage)).toHaveBeenCalledTimes(2);
  });

  it("detects the gateway placeholder even without a finish reason", async () => {
    const { provider, calls } = scriptedProvider([
      {
        content: "# Q\n- one\n[No response text was returned by the model (stopReason=max_tokens)]",
      },
      { content: "- two\n" },
    ]);
    const out = await run(provider);
    expect(calls).toHaveLength(2);
    expect(out.content).toBe("# Q\n- one\n- two\n");
    expect(out.truncated).toBe(false);
  });

  it("when the cap still wins, keeps what it has, marks it, and reports truncated", async () => {
    const { provider, calls } = scriptedProvider([
      { content: "# Q\n- one\n- tw", finishReason: "max_tokens" },
    ]);
    const audit = (await import("../../audit/audit-service.js")).audit;
    const out = await run(provider);

    expect(calls.length).toBe(3); // first call + two continuations
    expect(out.truncated).toBe(true);
    expect(out.continuations).toBe(2);
    expect(out.content.startsWith("# Q\n- one\n")).toBe(true);
    expect(out.content.trimEnd().endsWith(SPEC_KIT_TRUNCATION_NOTE)).toBe(true);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "spec_kit.command.plan",
        metadata: expect.objectContaining({ truncated: true, continuations: 2 }),
      }),
    );
  });

  it("a cut-off YAML artifact gets a # comment note and still parses", async () => {
    const yaml = await import("js-yaml");
    const { provider } = scriptedProvider([
      {
        content: "- a\n- b\n- par",
        finishReason: "max_tokens",
      },
    ]);
    const out = await runSpecKitAgent({
      command: "plan",
      project,
      systemPrompt: "Base.",
      userPrompt: "Produce the contract.",
      deps: { provider },
      format: "yaml",
    });
    expect(out.truncated).toBe(true);
    expect(out.content).not.toContain("> **Incomplete");
    expect(out.content.trimEnd().endsWith(SPEC_KIT_TRUNCATION_NOTE_YAML)).toBe(true);
    const doc = yaml.load(out.content) as string[];
    expect(doc[0]).toBe("a");
  });

  it("#1057 — a reply cut before any whole line fails the command instead of re-sending it", async () => {
    const { provider, calls } = scriptedProvider([
      { content: "", finishReason: "max_tokens" },
      { content: "# Q\n", finishReason: "stop" },
    ]);
    const audit = (await import("../../audit/audit-service.js")).audit;
    await expect(run(provider)).rejects.toMatchObject({
      status: 502,
      code: SPEC_KIT_OUTPUT_EXHAUSTED_CODE,
      message: expect.stringMatching(/output-token limit before writing any text/),
    });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "spec_kit.command.plan.failed",
        metadata: expect.objectContaining({ reason: "output_exhausted" }),
      }),
    );
    expect(vi.mocked(audit)).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "spec_kit.command.plan" }),
    );
  });

  it("#1057 — reasoning-only replies (half a line, then length) never become a stub", async () => {
    const { provider, calls } = scriptedProvider([
      { content: "Let me think about the pl", finishReason: "length" },
    ]);
    await expect(run(provider)).rejects.toMatchObject({ code: SPEC_KIT_OUTPUT_EXHAUSTED_CODE });
    expect(calls).toHaveLength(1);
  });

  it("#1057 — an empty gateway placeholder reply fails too", async () => {
    const { provider } = scriptedProvider([
      { content: "[No response text was returned by the model (stopReason=max_tokens)]" },
    ]);
    await expect(run(provider)).rejects.toMatchObject({ code: SPEC_KIT_OUTPUT_EXHAUSTED_CODE });
  });

  it("#1057 — an empty reply that finished normally fails instead of returning ''", async () => {
    for (const content of ["", "  \n\t\n"]) {
      vi.clearAllMocks();
      const { provider, calls } = scriptedProvider([{ content, finishReason: "stop" }]);
      const audit = (await import("../../audit/audit-service.js")).audit;
      await expect(run(provider)).rejects.toMatchObject({
        status: 502,
        code: SPEC_KIT_EMPTY_OUTPUT_CODE,
      });
      expect(calls).toHaveLength(1);
      expect(vi.mocked(audit)).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "spec_kit.command.plan.failed",
          metadata: expect.objectContaining({ reason: "empty_output" }),
        }),
      );
    }
  });

  it("#1057 — isIncompleteArtifact / keepsPriorVersion decide when a stored version stays", () => {
    const partial = `# Q\n\n${SPEC_KIT_TRUNCATION_NOTE}\n`;
    expect(isIncompleteArtifact(partial)).toBe(true);
    expect(isIncompleteArtifact(`a: 1\n${SPEC_KIT_TRUNCATION_NOTE_YAML}\n`)).toBe(true);
    expect(isIncompleteArtifact("# Whole plan\n")).toBe(false);
    expect(keepsPriorVersion(true, { content: "# Whole plan\n" })).toBe(true);
    expect(keepsPriorVersion(true, { content: partial })).toBe(false);
    expect(keepsPriorVersion(true, null)).toBe(false);
    expect(keepsPriorVersion(false, { content: "# Whole plan\n" })).toBe(false);
    // An empty stored artifact is no complete version (gates.ts reads it the same way).
    expect(keepsPriorVersion(true, { content: "" })).toBe(false);
    expect(keepsPriorVersion(true, { content: " \n\t\n" })).toBe(false);
  });

  it("#1057 — allowEmptyOutput returns '' for an empty or no-text reply instead of failing", async () => {
    for (const reply of [
      { content: "", finishReason: "stop" },
      { content: "Let me think about the pl", finishReason: "length" },
    ]) {
      const { provider, calls } = scriptedProvider([reply]);
      const out = await runSpecKitAgent({
        command: "checklist",
        project,
        systemPrompt: "SYS",
        userPrompt: "USER",
        deps: { provider },
        allowEmptyOutput: true,
      });
      expect(out.content).toBe("");
      expect(out.truncated).toBe(reply.finishReason === "length");
      expect(calls).toHaveLength(1);
    }
  });

  it("#1057 — a continuation that adds nothing is not re-sent; the salvage is kept and marked", async () => {
    const { provider, calls } = scriptedProvider([
      { content: "# Q\n- one\n- tw", finishReason: "max_tokens" },
      { content: "", finishReason: "max_tokens" },
    ]);
    const out = await run(provider);
    expect(calls).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.continuations).toBe(1);
    expect(out.content).toBe(`# Q\n- one\n\n${SPEC_KIT_TRUNCATION_NOTE}\n`);
  });
});

describe("runSpecKitAgent output budget (#1057)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends an explicit max_tokens on every call", async () => {
    const seen: unknown[] = [];
    const { provider } = scriptedProvider([{ content: "# Done\n", finishReason: "stop" }]);
    const chat = provider.chat.bind(provider);
    provider.chat = async (m, o) => {
      seen.push(o);
      return chat(m, o);
    };
    await run(provider);
    expect(seen[0]).toMatchObject({ maxTokens: expect.any(Number), callType: "spec-kit" });
  });

  it("asks a thinking-by-default model for low reasoning effort", async () => {
    const seen: unknown[] = [];
    const { provider } = scriptedProvider([{ content: "# Done\n", finishReason: "stop" }]);
    const chat = provider.chat.bind(provider);
    const deepseek = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, {
      model: "deepseek-flash",
      chat: async (m: ChatMessage[], o: unknown) => {
        seen.push(o);
        return chat(m, o as never);
      },
    }) as AIProvider;
    await run(deepseek);
    expect(seen[0]).toMatchObject({ reasoningEffort: "low" });
  });
});
