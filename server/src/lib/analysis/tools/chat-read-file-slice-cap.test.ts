/**
 * #2325 review — what the MODEL sees of a long `read_file_slice`.
 *
 * #138 caps the model's copy of every tool result (`capForModel`, default
 * `DEFAULT_TOOL_RESULT_MAX_TOKENS` × `DEFAULT_CHARS_PER_TOKEN` = 6,000
 * characters), keeping the head. A 200-line read of a real file is 8–10k
 * characters, so a stale warning or a paging hint written AFTER the lines is
 * cut away and the model reads stale lines unmarked. Here a real file on disk
 * is read by chat's tool through `runChatToolTurn` with the default cap, and
 * the request the provider receives must still carry both.
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    aIToolApproval: { create: vi.fn(), findFirst: vi.fn(async () => null) },
    repoConnection: { findMany: vi.fn(async () => []) },
    codeGraph: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { ApprovalGateService } from "../../ai/approval-policy.js";
import { OfflineStubProvider } from "../../ai/providers/offline-stub-provider.js";
import { runChatToolTurn } from "../../ai/tool-runtime/chat-turn.js";
import { makeToolset } from "../../ai/tool-runtime/toolset.js";
import type { RuntimeTool } from "../../ai/tool-runtime/types.js";
import { DEFAULT_TOOL_RESULT_MAX_TOKENS } from "../../ai/conversation/context-builder.js";
import { DEFAULT_CHARS_PER_TOKEN } from "../../ai/conversation/token-estimator.js";
import { codeVersionIndexOf } from "../../code-graph/code-version.js";
import { createChatReadFileSliceTool } from "./chat-read-file-slice.js";
import type { AgentTool } from "./types.js";

const INDEXED = "0123456789abcdef0123456789abcdef01234567";
const MOVED_ON = "fedcba9876543210fedcba9876543210fedcba98";
const DEFAULT_CAP = DEFAULT_TOOL_RESULT_MAX_TOKENS * DEFAULT_CHARS_PER_TOKEN;
const CTX = { sessionId: "s1", userId: "alice", projectId: "p1" };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "chat-rfs-cap-"));
  await mkdir(path.join(root, "src"));
  // 450 lines of ordinary-width code: 200 numbered lines run well past the cap.
  const body = Array.from(
    { length: 450 },
    (_, i) => `  const value${i} = computeSomething(input.field${i}, options.flag); // step ${i}`,
  ).join("\n");
  await writeFile(path.join(root, "src", "big.ts"), body);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Chat's code tool as a runtime tool, the way `codeRuntimeTool` maps its result. */
function runtime(tool: AgentTool): RuntimeTool {
  return {
    name: tool.name,
    wireName: tool.name,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
    risk: "low",
    source: "code",
    validate: (args) => ({ ok: true, args }),
    async execute(args, ctx) {
      const r = await tool.execute(args, { projectId: ctx.projectId ?? "" });
      return { text: r.content, ...(r.isError ? { isError: true } : {}) };
    },
  };
}

async function modelCopyOfRead(head: string): Promise<{ model: string; full: string }> {
  const tool = createChatReadFileSliceTool({
    listRepoIds: async () => ["conn-a"],
    resolveCloneDir: async () => root,
    loadVersions: async () =>
      codeVersionIndexOf([{ repoConnectionId: "conn-a", commitSha: INDEXED, repo: null }]),
    readHead: async () => head,
  });
  const gate = new ApprovalGateService({
    sessionId: CTX.sessionId,
    userId: CTX.userId,
    policy: { low: "auto", medium: "auto", high: "auto" },
  });
  const provider = new OfflineStubProvider({
    script: [
      { toolCalls: [{ id: "c1", name: "read_file_slice", args: { filePath: "src/big.ts" } }] },
      { content: "done" },
    ],
  });
  const out = await runChatToolTurn(
    provider,
    {
      messages: [{ role: "user", content: "read it" }],
      toolset: makeToolset([runtime(tool)]),
      native: true,
      ctx: CTX,
      gate,
    },
    { toolResultMaxChars: DEFAULT_CAP },
  );
  const toolMsg = provider.requests[1]!.messages.find((m) => m.role === "tool")!;
  return { model: String(toolMsg.content), full: out.toolResults[0]!.result ?? "" };
}

describe("chat read_file_slice under the model-context cap (#2325 review)", () => {
  it("a stale long read keeps its warning and its paging hint in the model's copy", async () => {
    const { model, full } = await modelCopyOfRead(MOVED_ON);
    // The cap really cut this read: the test is about what survives the cut.
    expect(full.length).toBeGreaterThan(DEFAULT_CAP);
    expect(model).toContain("tool result truncated");
    expect(model).toContain("⚠ Stale");
    expect(model).toContain("fedcba987654");
    expect(model).toContain("request lines 201-400 next");
    // Both precede the first numbered line, so no cut can drop them.
    expect(model.indexOf("⚠ Stale")).toBeLessThan(model.indexOf("1|   const value0"));
    expect(model.indexOf("request lines 201-400 next")).toBeLessThan(
      model.indexOf("1|   const value0"),
    );
  });

  it("a current long read keeps its version line in the model's copy", async () => {
    const { model } = await modelCopyOfRead(INDEXED);
    expect(model).toContain("tool result truncated");
    expect(model).toContain("Code version: indexed commit 0123456789ab.");
    expect(model).not.toContain("Stale");
  });
});
