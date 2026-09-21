/**
 * Epic #712 / Issue #714 — chat call-site: fused code retrieval in
 * `buildAutoRagContext`, plus the epic #696 caching-placement guarantee.
 *
 * Covers:
 *   - flag OFF ⇒ byte-identical to the doc-RAG-only block AND the code searcher
 *     is never queried (no code-graph latency);
 *   - flag ON ⇒ a deduped, locator-bearing symbol block is appended to the RAG
 *     block;
 *   - caching placement (#700): the fused block enters via the VOLATILE region
 *     (it is spliced in after `assembleChatSystem`'s stable lead), so the
 *     byte-stable lead is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { search, findUnique } = vi.hoisted(() => ({
  search: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("../lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({ search }),
}));
vi.mock("../lib/prisma.js", () => ({
  prisma: { project: { findUnique } },
}));

import type { ChatMessage } from "../lib/ai/types.js";
import {
  assembleChatSystem,
  stableLeadText,
  CITATION_INSTRUCTION,
} from "../lib/ai/chat-system-prompt.js";
import { __resetConfigSingleton } from "../lib/config/config-service.js";
import type {
  FusedCodeDeps,
  buildAutoRagContext as BuildAutoRagContextType,
  buildLibrarySystemMessages as BuildLibrarySystemMessagesType,
} from "./ai.js";
import type {
  FusedCodeSearcher,
  RawCodeSymbolHit,
  SymbolLineLookup,
} from "../lib/rag/fused-code-context.js";

// Imported after the mocks are registered.
let buildAutoRagContext: typeof BuildAutoRagContextType;
let buildLibrarySystemMessages: typeof BuildLibrarySystemMessagesType;

beforeEach(async () => {
  ({ buildAutoRagContext, buildLibrarySystemMessages } = await import("./ai.js"));
  search.mockReset();
  findUnique.mockReset();
  findUnique.mockResolvedValue({ name: "ETAG" });
});

afterEach(() => {
  delete process.env.CHAT_FUSED_CODE_RETRIEVAL;
  __resetConfigSingleton();
});

function fusedDeps(
  results: RawCodeSymbolHit[],
  lines: Record<string, { filePath: string; startLine: number; endLine: number }>,
): FusedCodeDeps & { searcher: FusedCodeSearcher & { search: ReturnType<typeof vi.fn> } } {
  const searcher = { search: vi.fn().mockResolvedValue(results) };
  const lineLookup: SymbolLineLookup = {
    resolve: vi.fn().mockResolvedValue(new Map(Object.entries(lines))),
  };
  return { searcher, lineLookup };
}

const userTurn: ChatMessage = { role: "user", content: "How does the tag validator work?" };

const docHit = {
  chunkId: "c1",
  documentId: "d1",
  filename: "connector:repo:cid1:src/main/java/Doc.java",
  position: 0,
  text: "public class Doc {}",
  score: 0.9,
  embeddingModel: "test",
};

describe("buildAutoRagContext — flag OFF (byte-identical, no code-graph query)", () => {
  it("returns the doc-RAG block unchanged and never queries the searcher", async () => {
    __resetConfigSingleton(); // flag unset ⇒ false
    search.mockResolvedValue({ hits: [docHit] });
    const deps = fusedDeps(
      [{ symbolId: "s1", filePath: "x", name: "Sym", kind: "class", score: 1 }],
      { s1: { filePath: "src/main/java/Sym.java", startLine: 1, endLine: 9 } },
    );

    const out = await buildAutoRagContext("p1", [userTurn], deps);

    expect(out).toContain("## Retrieved Knowledge (project-scoped RAG)");
    expect(out).not.toContain("## Retrieved Code Symbols");
    expect(deps.searcher.search).not.toHaveBeenCalled();
  });

  it("is byte-identical to a run where fused deps are irrelevant", async () => {
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [docHit] });
    const withHits = fusedDeps(
      [{ symbolId: "s1", filePath: "x", name: "Sym", kind: "class", score: 1 }],
      { s1: { filePath: "src/main/java/Sym.java", startLine: 1, endLine: 9 } },
    );
    const withoutHits = fusedDeps([], {});

    const a = await buildAutoRagContext("p1", [userTurn], withHits);
    const b = await buildAutoRagContext("p1", [userTurn], withoutHits);
    expect(a).toBe(b);
  });
});

describe("buildAutoRagContext — flag ON (fused merge)", () => {
  beforeEach(() => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
  });

  it("appends a deduped, locator-bearing symbol block to the RAG block", async () => {
    search.mockResolvedValue({ hits: [docHit] });
    // s1 duplicates the doc chunk (same file) → dropped; s2 survives.
    const deps = fusedDeps(
      [
        { symbolId: "s1", filePath: "x", name: "Doc", kind: "class", score: 2 },
        { symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 },
      ],
      {
        s1: { filePath: "main/java/Doc.java", startLine: 1, endLine: 9 },
        s2: { filePath: "src/main/java/Validator.java", startLine: 20, endLine: 55 },
      },
    );

    const out = await buildAutoRagContext("p1", [userTurn], deps);

    expect(out).toContain("## Retrieved Knowledge (project-scoped RAG)");
    expect(out).toContain("## Retrieved Code Symbols (project-scoped code graph)");
    expect(out).toContain("src/main/java/Validator.java:20-55");
    // The duplicate symbol (same file as the doc chunk) is not injected twice.
    expect(out).not.toContain("[1] Doc (class)");
    expect(deps.searcher.search).toHaveBeenCalledWith("How does the tag validator work?", "p1", {
      limit: 12,
    });
  });

  it("surfaces a code-only block when doc RAG returns zero hits", async () => {
    search.mockResolvedValue({ hits: [] });
    const deps = fusedDeps(
      [{ symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 }],
      { s2: { filePath: "src/Validator.java", startLine: 20, endLine: 55 } },
    );
    const out = await buildAutoRagContext("p1", [userTurn], deps);
    expect(out).toContain("## Retrieved Code Symbols");
    expect(out).toContain("src/Validator.java:20-55");
    expect(out).not.toContain("## Retrieved Knowledge (project-scoped RAG)");
  });
});

describe("caching placement — fused block lands in the volatile tail (#700/#696)", () => {
  beforeEach(() => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
  });

  it("injects the fused block AFTER the byte-stable lead, never into it", async () => {
    search.mockResolvedValue({ hits: [docHit] });
    const deps = fusedDeps(
      [{ symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 }],
      { s2: { filePath: "src/Validator.java", startLine: 20, endLine: 55 } },
    );

    // Reproduce the /chat route's message assembly (server/src/routes/ai.ts).
    const librarySystem = assembleChatSystem({
      persona: "You are the METIS session agent.",
      skillBlocks: ["[skill:review@1.0] Code Review"],
      chronicle: "## Project memory\n- decided: use pgvector",
    });
    const messages: ChatMessage[] = [...librarySystem.stable, ...librarySystem.volatile, userTurn];

    const ragContext = await buildAutoRagContext("p1", messages, deps);
    expect(ragContext).toContain("## Retrieved Code Symbols");
    // Route splices the RAG+fused system message just before the last user turn.
    messages.splice(messages.length - 1, 0, { role: "system", content: ragContext });

    // 1. The byte-stable lead does not carry any fused/RAG content.
    const lead = stableLeadText(librarySystem);
    expect(lead).not.toContain("## Retrieved Code Symbols");
    expect(lead).not.toContain("src/Validator.java:20-55");

    // 2. The fused block sits strictly AFTER every stable-lead message.
    const fusedIdx = messages.findIndex((m) => m.content === ragContext);
    expect(fusedIdx).toBeGreaterThan(librarySystem.stable.length - 1);
    for (let i = 0; i < librarySystem.stable.length; i++) {
      expect(messages[i]).toEqual(librarySystem.stable[i]);
    }
  });

  it("keeps the stable lead byte-identical whether the fused flag is on or off", async () => {
    // The fused feature is never an input to assembleChatSystem, so the cache
    // prefix is invariant to it — the #700 guarantee holds unchanged.
    const parts = {
      persona: "You are the METIS session agent.",
      skillBlocks: ["[skill:review@1.0] Code Review"],
      chronicle: "## memory\n- a",
    };
    const first = stableLeadText(assembleChatSystem(parts));
    const second = stableLeadText(
      assembleChatSystem({ ...parts, chronicle: "## memory\n- a\n- b" }),
    );
    expect(second).toBe(first);
  });

  // ── #715 — the citation policy is wired into the production stable lead ──────

  it("threads the static citation instruction into the byte-stable lead", async () => {
    // A session with no agent, no skills and no project touches no DB, so this
    // exercises the real production wiring: buildLibrarySystemMessages must place
    // CITATION_INSTRUCTION in the stable lead (not the volatile tail).
    const assembled = await buildLibrarySystemMessages({
      agentId: null,
      loadedSkillIds: "[]",
      projectId: null,
    });
    expect(assembled.stable.map((m) => m.content)).toContain(CITATION_INSTRUCTION);
    expect(assembled.volatile.map((m) => m.content)).not.toContain(CITATION_INSTRUCTION);
    expect(stableLeadText(assembled)).toContain("## Source citation policy");
  });

  it("keeps the citation-bearing lead byte-identical across two same-config requests", async () => {
    const session = { agentId: null, loadedSkillIds: "[]", projectId: null };
    const first = await buildLibrarySystemMessages(session);
    const second = await buildLibrarySystemMessages(session);
    // The citation instruction is static, so it shifts the cached prefix once per
    // deploy and never per request (#700 byte-stability holds with the new lead).
    expect(stableLeadText(second)).toBe(stableLeadText(first));
    expect(JSON.stringify(second.stable)).toBe(JSON.stringify(first.stable));
  });
});

// ── #1321 — RAG context capture for the online-eval observer ─────────────────
//
// The observer needs the contexts the model actually saw. The first cut derived
// them by re-splitting the assembled block on its `\n\n---\n\n` separator, which
// is wrong for two shapes the corpus really produces. These tests round-trip
// through the *builder*, so they would have caught both.
describe("buildAutoRagContext — #1321 context capture", () => {
  it("captures one entry per retrieved chunk, without the preamble", async () => {
    __resetConfigSingleton();
    search.mockResolvedValue({
      hits: [docHit, { ...docHit, chunkId: "c2", filename: "B.java", position: 1, score: 0.8 }],
    });
    const capture = { contexts: [] as string[] };
    const out = await buildAutoRagContext("p1", [userTurn], fusedDeps([], {}), capture);

    expect(capture.contexts).toHaveLength(2);
    expect(capture.contexts[0]).toContain("public class Doc {}");
    expect(capture.contexts[0]).not.toContain("## Retrieved Knowledge");
    expect(capture.contexts[1]).toContain("[2] B.java#1");
    expect(out).toContain("public class Doc {}");
  });

  it("does not split a chunk that itself contains a markdown horizontal rule", async () => {
    __resetConfigSingleton();
    // An ordinary `---` rule with blank lines around it — the exact byte
    // sequence the block separator uses.
    const ruled = { ...docHit, text: "before the rule\n\n---\n\nafter the rule" };
    search.mockResolvedValue({ hits: [ruled] });
    const capture = { contexts: [] as string[] };
    await buildAutoRagContext("p1", [userTurn], fusedDeps([], {}), capture);

    expect(capture.contexts).toHaveLength(1);
    expect(capture.contexts[0]).toContain("before the rule");
    expect(capture.contexts[0]).toContain("after the rule");
  });

  it("keeps the #714 fused block as its own context, not glued to the last chunk", async () => {
    process.env.CHAT_FUSED_CODE_RETRIEVAL = "true";
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [docHit] });
    const deps = fusedDeps(
      [{ symbolId: "s2", filePath: "y", name: "Validator", kind: "class", score: 1 }],
      { s2: { filePath: "src/main/java/Validator.java", startLine: 3, endLine: 40 } },
    );
    const capture = { contexts: [] as string[] };
    await buildAutoRagContext("p1", [userTurn], deps, capture);

    expect(capture.contexts).toHaveLength(2);
    expect(capture.contexts[0]).toContain("public class Doc {}");
    expect(capture.contexts[0]).not.toContain("Retrieved Code Symbols");
    expect(capture.contexts[1]).toContain("Retrieved Code Symbols");
  });

  it("leaves the capture empty when retrieval throws mid-way", async () => {
    __resetConfigSingleton();
    search.mockRejectedValue(new Error("lancedb down"));
    const capture = { contexts: ["stale"] };
    const out = await buildAutoRagContext("p1", [userTurn], fusedDeps([], {}), capture);

    expect(out).toBe("");
    expect(capture.contexts).toEqual([]);
  });

  it("captures nothing when there are no hits", async () => {
    __resetConfigSingleton();
    search.mockResolvedValue({ hits: [] });
    const capture = { contexts: [] as string[] };
    expect(await buildAutoRagContext("p1", [userTurn], fusedDeps([], {}), capture)).toBe("");
    expect(capture.contexts).toEqual([]);
  });
});
