/**
 * Epic #260 (#82) — custom-agent import/export JSON.
 *
 * Export emits a versioned, side-effect-free document. Import validates
 * STRICTLY: rejects unknown/dangerous fields, enforces types, and refuses any
 * value that looks like a remote URL (SSRF) in import-only contexts. Round-trip
 * preserves all portable fields.
 */
import { describe, expect, it } from "vitest";
import type { CustomAgentDto } from "@metis/shared";
import {
  AgentImportError,
  exportAgent,
  parseAgentImport,
} from "../src/lib/custom-agents/portability.js";

const dto: CustomAgentDto = {
  id: "ag_1",
  projectId: "p1",
  name: "Reviewer",
  description: "Reviews PRs",
  systemPrompt: "You review pull requests.",
  tools: ["search_code", "search_documents"],
  model: "claude-x",
  reasoningEffort: "high",
  isBuiltIn: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("exportAgent (#82)", () => {
  it("emits a versioned doc without server-owned identity fields", () => {
    const doc = exportAgent(dto);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.agent.name).toBe("Reviewer");
    expect(doc.agent.tools).toEqual(["search_code", "search_documents"]);
    // never export id / projectId / isBuiltIn / timestamps
    expect(doc.agent).not.toHaveProperty("id");
    expect(doc.agent).not.toHaveProperty("projectId");
    expect(doc.agent).not.toHaveProperty("isBuiltIn");
    expect(doc.agent).not.toHaveProperty("createdAt");
  });
});

describe("parseAgentImport (#82)", () => {
  it("round-trips an exported doc preserving all portable fields", () => {
    const doc = exportAgent(dto);
    const def = parseAgentImport(doc);
    expect(def.name).toBe(dto.name);
    expect(def.description).toBe(dto.description);
    expect(def.systemPrompt).toBe(dto.systemPrompt);
    expect(def.tools).toEqual(dto.tools);
    expect(def.model).toBe(dto.model);
    expect(def.reasoningEffort).toBe(dto.reasoningEffort);
  });

  it("accepts a raw definition without the wrapper", () => {
    const def = parseAgentImport({
      name: "Bare",
      description: "",
      systemPrompt: "do x",
      tools: [],
    });
    expect(def.name).toBe("Bare");
  });

  it("rejects unknown / dangerous fields (strict)", () => {
    expect(() =>
      parseAgentImport({
        schemaVersion: 1,
        agent: {
          name: "X",
          description: "",
          systemPrompt: "do",
          tools: [],
          __proto__: { polluted: true },
          fetchUrl: "http://169.254.169.254/latest/meta-data",
        } as never,
      }),
    ).toThrow(AgentImportError);
  });

  it("rejects a tools entry that looks like a remote URL (SSRF guard)", () => {
    expect(() =>
      parseAgentImport({
        name: "X",
        description: "",
        systemPrompt: "do",
        tools: ["https://evil.example.com/exfil"],
      }),
    ).toThrow(AgentImportError);
  });

  it("rejects a model field that is a URL (SSRF guard)", () => {
    expect(() =>
      parseAgentImport({
        name: "X",
        description: "",
        systemPrompt: "do",
        tools: [],
        model: "http://internal.svc/admin",
      }),
    ).toThrow(AgentImportError);
  });

  it("rejects wrong types", () => {
    expect(() =>
      parseAgentImport({ name: "X", description: "", systemPrompt: 42, tools: [] } as never),
    ).toThrow(AgentImportError);
  });

  it("rejects an unsupported schemaVersion", () => {
    expect(() =>
      parseAgentImport({
        schemaVersion: 99,
        agent: { name: "X", description: "", systemPrompt: "do", tools: [] },
      }),
    ).toThrow(AgentImportError);
  });

  it("rejects an invalid agent name", () => {
    expect(() =>
      parseAgentImport({ name: "1bad", description: "", systemPrompt: "do", tools: [] }),
    ).toThrow(AgentImportError);
  });

  it("rejects a non-object payload", () => {
    expect(() => parseAgentImport(null as never)).toThrow(AgentImportError);
    expect(() => parseAgentImport("nope" as never)).toThrow(AgentImportError);
  });
});
