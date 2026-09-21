/**
 * #700 — chat system-prompt assembly: byte-stable lead + volatile tail.
 *
 * Verifies the ordering contract the cacheable prefix depends on:
 *   • the stable lead (persona + skills) leads the wire order;
 *   • the volatile tail (Chronicle + user override) follows it;
 *   • the stable lead is byte-identical across two consecutive requests in one
 *     session (the AC's byte-stability requirement) and invariant to changes in
 *     the volatile fields;
 *   • prompt SEMANTICS are unchanged — every non-empty piece still reaches the
 *     model, carrying the same content, only reordered.
 */
import { describe, expect, it } from "vitest";
import { assembleChatSystem, stableLeadText, CITATION_INSTRUCTION } from "./chat-system-prompt.js";

const PERSONA = "You are the METIS session agent. Follow the operator's policy.";
const SKILL_A = "[skill:review@1.0] Code Review\nReview diffs for defects.";
const SKILL_B = "[skill:sql@2.1] SQL Helper\nWrite safe parameterised queries.";
const CHRONICLE = "## Project memory\n- decided: use pgvector";
const USER_OVERRIDE = "Answer in terse bullet points.";
// #713 — the deterministically name-ordered tool-schema block (as produced by
// formatToolSchemas): static for a given flag/tool set, so it belongs in the
// byte-stable lead AFTER the skill blocks.
const TOOL_SCHEMAS =
  "## Available tools (full definitions)\n### Tool: search_code_graph\n...\n### Tool: search_code_symbols\n...";

describe("assembleChatSystem", () => {
  it("orders stable lead (persona + skills) before the volatile tail", () => {
    const a = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });

    expect(a.stable.map((m) => m.content)).toEqual([PERSONA, SKILL_A, SKILL_B]);
    expect(a.volatile.map((m) => m.content)).toEqual([CHRONICLE, USER_OVERRIDE]);
    // Wire order = stable ++ volatile.
    expect(a.all.map((m) => m.content)).toEqual([
      PERSONA,
      SKILL_A,
      SKILL_B,
      CHRONICLE,
      USER_OVERRIDE,
    ]);
    // Every message is a system message.
    expect(a.all.every((m) => m.role === "system")).toBe(true);
  });

  it("keeps the stable lead byte-identical across two consecutive requests", () => {
    const first = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // Second request in the same session: SAME persona + skills, but the
    // volatile Chronicle grew and the user override differs.
    const second = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      chronicle: `${CHRONICLE}\n- decided: enable 1h TTL`,
      userSystemMessage: "Now answer in prose.",
    });

    // The AC: byte-stability of the cacheable lead across requests.
    expect(stableLeadText(second)).toBe(stableLeadText(first));
    expect(JSON.stringify(second.stable)).toBe(JSON.stringify(first.stable));
    // ...even though the volatile tail changed.
    expect(JSON.stringify(second.volatile)).not.toBe(JSON.stringify(first.volatile));
  });

  it("preserves prompt semantics: the same content is present, only reordered", () => {
    const parts = {
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    };
    const a = assembleChatSystem(parts);
    const assembled = new Set(a.all.map((m) => m.content));
    const expected = new Set([PERSONA, SKILL_A, SKILL_B, CHRONICLE, USER_OVERRIDE]);
    expect(assembled).toEqual(expected);
  });

  it("drops empty/whitespace-only pieces (matches the previous inline assembly)", () => {
    const a = assembleChatSystem({
      persona: "   ",
      skillBlocks: ["", SKILL_A, "  \n "],
      chronicle: "",
      userSystemMessage: null,
    });
    expect(a.stable.map((m) => m.content)).toEqual([SKILL_A]);
    expect(a.volatile).toEqual([]);
    expect(a.all.map((m) => m.content)).toEqual([SKILL_A]);
  });

  it("handles a bare session with no library content", () => {
    const a = assembleChatSystem({});
    expect(a.stable).toEqual([]);
    expect(a.volatile).toEqual([]);
    expect(a.all).toEqual([]);
    expect(stableLeadText(a)).toBe("");
  });

  it("puts persona ahead of skills and skills in load order", () => {
    const a = assembleChatSystem({ persona: PERSONA, skillBlocks: [SKILL_B, SKILL_A] });
    expect(a.stable.map((m) => m.content)).toEqual([PERSONA, SKILL_B, SKILL_A]);
  });

  it("treats a lone user override as volatile with an empty stable lead", () => {
    const a = assembleChatSystem({ userSystemMessage: USER_OVERRIDE });
    expect(a.stable).toEqual([]);
    expect(a.volatile.map((m) => m.content)).toEqual([USER_OVERRIDE]);
    expect(stableLeadText(a)).toBe("");
  });

  // ── #713 — code-tool schemas ride in the byte-stable lead ────────────────

  it("places the tool-schema block in the stable lead, after skills, before the volatile tail", () => {
    const a = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A],
      toolSchemas: TOOL_SCHEMAS,
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // Stable lead: persona, skill, THEN schemas — schemas never in the volatile tail.
    expect(a.stable.map((m) => m.content)).toEqual([PERSONA, SKILL_A, TOOL_SCHEMAS]);
    expect(a.volatile.map((m) => m.content)).toEqual([CHRONICLE, USER_OVERRIDE]);
  });

  it("flag ON: the stable lead (with schemas) is byte-identical across two same-flag requests", () => {
    const first = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      toolSchemas: TOOL_SCHEMAS,
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // Second request, same flag/tool set (same schema block), but volatile grew.
    const second = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      toolSchemas: TOOL_SCHEMAS,
      chronicle: `${CHRONICLE}\n- decided: enable code tools`,
      userSystemMessage: "Now answer in prose.",
    });

    expect(stableLeadText(second)).toBe(stableLeadText(first));
    expect(JSON.stringify(second.stable)).toBe(JSON.stringify(first.stable));
    // The schema bytes are actually present in the cached lead.
    expect(stableLeadText(first)).toContain(TOOL_SCHEMAS);
  });

  it("flag OFF: the stable lead is byte-identical to today (no schema bytes)", () => {
    const withoutFlag = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // An empty/absent schema block must not perturb the lead at all.
    const emptyBlock = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      toolSchemas: "",
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });

    expect(stableLeadText(emptyBlock)).toBe(stableLeadText(withoutFlag));
    expect(JSON.stringify(emptyBlock.stable)).toBe(JSON.stringify(withoutFlag.stable));
    expect(stableLeadText(withoutFlag)).toEqual([PERSONA, SKILL_A, SKILL_B].join("\n"));
  });

  // ── #715 — the static source-citation policy rides in the byte-stable lead ──

  it("places the citation instruction in the stable lead, after the tool schemas", () => {
    const a = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A],
      toolSchemas: TOOL_SCHEMAS,
      citationInstruction: CITATION_INSTRUCTION,
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // Stable lead: persona, skill, schemas, THEN the citation policy — never in
    // the volatile tail.
    expect(a.stable.map((m) => m.content)).toEqual([
      PERSONA,
      SKILL_A,
      TOOL_SCHEMAS,
      CITATION_INSTRUCTION,
    ]);
    expect(a.volatile.map((m) => m.content)).toEqual([CHRONICLE, USER_OVERRIDE]);
    // The static instruction is present in the cacheable prefix. It is byte-for-
    // byte the constant — the lead carries only the fixed POLICY text (an
    // illustrative `e.g.` format), never any per-request hit's locator values,
    // which are rendered downstream into the volatile retrieved-knowledge block.
    expect(stableLeadText(a)).toContain(CITATION_INSTRUCTION);
    const lead = stableLeadText(a);
    expect(lead.slice(lead.indexOf("## Source citation policy"))).toBe(CITATION_INSTRUCTION);
  });

  it("keeps the stable lead (with the citation policy) byte-identical across two same-config requests", () => {
    const first = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      toolSchemas: TOOL_SCHEMAS,
      citationInstruction: CITATION_INSTRUCTION,
      chronicle: CHRONICLE,
      userSystemMessage: USER_OVERRIDE,
    });
    // Second request in the same session: SAME static lead, but the volatile
    // Chronicle grew and the user override differs.
    const second = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A, SKILL_B],
      toolSchemas: TOOL_SCHEMAS,
      citationInstruction: CITATION_INSTRUCTION,
      chronicle: `${CHRONICLE}\n- decided: cite file:line`,
      userSystemMessage: "Now answer in prose.",
    });

    // The #700 AC still holds with the extended lead: byte-stability across requests.
    expect(stableLeadText(second)).toBe(stableLeadText(first));
    expect(JSON.stringify(second.stable)).toBe(JSON.stringify(first.stable));
    // ...even though the volatile tail changed.
    expect(JSON.stringify(second.volatile)).not.toBe(JSON.stringify(first.volatile));
    // The citation bytes are actually part of the cached lead.
    expect(stableLeadText(first)).toContain("Source citation policy");
  });

  it("the citation instruction survives with no tool schemas (flag-off tools still get the policy)", () => {
    const a = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A],
      // no toolSchemas (code-search tools flag off) — the citation policy is
      // independent of that flag and must still lead.
      citationInstruction: CITATION_INSTRUCTION,
      chronicle: CHRONICLE,
    });
    expect(a.stable.map((m) => m.content)).toEqual([PERSONA, SKILL_A, CITATION_INSTRUCTION]);
    expect(a.volatile.map((m) => m.content)).toEqual([CHRONICLE]);
  });

  it("the citation policy text names the locator format, forbids fabrication, and bans the vague disclaimer", () => {
    // Guards the graceful-degradation contract (AC #4) at the prompt level.
    expect(CITATION_INSTRUCTION).toContain("filePath:startLine-endLine");
    expect(CITATION_INSTRUCTION).toContain("do NOT fabricate");
    expect(CITATION_INSTRUCTION).toContain("reconstructed from the knowledge base");
  });

  it("an absent citation instruction does not perturb the lead (mechanical part-ordering)", () => {
    const withInstr = assembleChatSystem({ persona: PERSONA, skillBlocks: [SKILL_A] });
    const withEmpty = assembleChatSystem({
      persona: PERSONA,
      skillBlocks: [SKILL_A],
      citationInstruction: "  ",
    });
    expect(stableLeadText(withEmpty)).toBe(stableLeadText(withInstr));
  });
});
