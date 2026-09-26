/** Epic #129 (#145) — the one definition: refs, mapping, the catalog-checked model. */
import { afterEach, describe, expect, it } from "vitest";
import {
  agentRef,
  customDtoDefinition,
  libraryDefinition,
  parseAgentRef,
  renderPersona,
  resolveAgentModel,
} from "./definition.js";
import { renderAgentSystemMessage } from "../library/session-runtime.js";

afterEach(() => {
  delete process.env.AI_MODEL_CATALOG_OVERRIDES;
});

describe("agent refs", () => {
  it("round-trip, and reject anything else", () => {
    expect(parseAgentRef(agentRef("library", "abc_1-2"))).toEqual({
      kind: "library",
      id: "abc_1-2",
    });
    expect(parseAgentRef("custom:x")).toEqual({ kind: "custom", id: "x" });
    for (const bad of [
      "agent:x",
      "library:",
      "custom:a/b",
      "library:../x",
      42,
      null,
      `custom:${"a".repeat(200)}`,
    ]) {
      expect(parseAgentRef(bad)).toBeNull();
    }
  });
});

describe("mapping", () => {
  it("a library agent with no tools declares NO allowlist (null); a custom agent's empty list means none ([])", () => {
    const lib = libraryDefinition({
      id: "a",
      key: "k",
      name: "n",
      displayName: "",
      description: "d",
      systemPrompt: "p",
      tools: "[]",
      model: "",
      version: "1.0.0",
    });
    expect(lib).toMatchObject({ name: "n", toolAllowlist: null, model: null, skillKeys: [] });
    const custom = customDtoDefinition({
      id: "c",
      projectId: "p1",
      name: "My Agent!",
      description: "",
      systemPrompt: "p",
      tools: [],
      approvalPolicy: { high: "deny" },
      skillKeys: ["s1"],
    });
    expect(custom).toMatchObject({
      key: "my-agent",
      toolAllowlist: [],
      approvalPolicy: { high: "deny" },
      skillKeys: ["s1"],
      version: "1.0.0",
      reasoningEffort: null,
    });
  });

  it("the persona block is byte-identical to the library's session persona (the #700 cached prefix is unchanged)", () => {
    const agent = {
      key: "lead",
      name: "lead",
      displayName: "Lead",
      version: "2.0.0",
      description: "Leads.",
      systemPrompt: "  You lead.\n",
    };
    const def = libraryDefinition({ ...agent, id: "a", tools: "[]", model: "" });
    expect(renderPersona(def)).toBe(renderAgentSystemMessage(agent));
  });
});

describe("resolveAgentModel (#135)", () => {
  it("uses the preferred model only when the catalog knows it for the provider", () => {
    expect(resolveAgentModel("anthropic", "claude-sonnet-4-6", "fallback")).toEqual({
      model: "claude-sonnet-4-6",
      usedPreferred: true,
    });
    expect(resolveAgentModel("anthropic", "made-up-model", "fallback").model).toBe("fallback");
    expect(resolveAgentModel("anthropic", null, "fallback").model).toBe("fallback");
    process.env.AI_MODEL_CATALOG_OVERRIDES = JSON.stringify({ "local-gemma:my-model": {} });
    expect(resolveAgentModel("local-gemma", "my-model", "fallback").model).toBe("my-model");
    // Known to ANOTHER provider only: not sent.
    expect(resolveAgentModel("openai", "claude-sonnet-4-6", "fallback").model).toBe("fallback");
  });
});
