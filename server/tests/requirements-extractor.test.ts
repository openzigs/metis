/**
 * Tests for RequirementsExtractor (Epic #597 / Issue #622).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { RequirementsExtractor } from "../src/lib/analysis/requirements-extractor.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";

function mockProvider(content: string): AIProvider {
  return {
    key: "test",
    model: "test-model",
    offline: true,
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "test-model",
      provider: "test",
    } as ChatResponse),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue(true),
  };
}

describe("RequirementsExtractor", () => {
  describe("extract", () => {
    it("returns empty result for empty input", async () => {
      const provider = mockProvider("{}");
      const extractor = new RequirementsExtractor({ provider });
      const result = await extractor.extract("");

      expect(result.requirements).toEqual([]);
      expect(result.totalAmbiguities).toBe(0);
      expect(result.totalEvidenceNeeds).toBe(0);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("returns empty result for whitespace-only input", async () => {
      const provider = mockProvider("{}");
      const extractor = new RequirementsExtractor({ provider });
      const result = await extractor.extract("   \n  \t  ");

      expect(result.requirements).toEqual([]);
    });

    it("extracts structured requirements from LLM response", async () => {
      const llmResponse = JSON.stringify({
        requirements: [
          {
            title: "User Authentication",
            description: "The system must support OAuth2 login",
            type: "functional",
            stakeholders: ["end-users", "admin"],
            priority: "must-have",
            ambiguities: [
              {
                field: "scope",
                description: "OAuth2 scopes not specified",
                suggestedQuestion: "Which OAuth2 scopes should be supported?",
              },
            ],
            evidenceNeeds: [
              {
                description: "OAuth2 best practices for web apps",
                domain: "security",
                searchHints: ["OAuth2", "web application", "security"],
              },
            ],
          },
        ],
      });

      const provider = mockProvider(llmResponse);
      const extractor = new RequirementsExtractor({ provider });
      const result = await extractor.extract("The system needs user authentication");

      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0]!.title).toBe("User Authentication");
      expect(result.requirements[0]!.type).toBe("functional");
      expect(result.requirements[0]!.priority).toBe("must-have");
      expect(result.requirements[0]!.stakeholders).toEqual(["end-users", "admin"]);
      expect(result.requirements[0]!.ambiguities).toHaveLength(1);
      expect(result.requirements[0]!.evidenceNeeds).toHaveLength(1);
      expect(result.totalAmbiguities).toBe(1);
      expect(result.totalEvidenceNeeds).toBe(1);
      expect(result.requirements[0]!.rawSource).toBe("The system needs user authentication");
    });

    it("passes model override to provider", async () => {
      const provider = mockProvider(JSON.stringify({ requirements: [] }));
      const extractor = new RequirementsExtractor({ provider, model: "custom-model" });
      await extractor.extract("test input");

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ model: "custom-model", disableTools: true }),
      );
    });

    it("passes abort signal to provider", async () => {
      const controller = new AbortController();
      const provider = mockProvider(JSON.stringify({ requirements: [] }));
      const extractor = new RequirementsExtractor({ provider });
      await extractor.extract("test input", controller.signal);

      expect(provider.chat).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ signal: controller.signal }),
      );
    });
  });

  describe("parseResponse", () => {
    let extractor: RequirementsExtractor;

    beforeEach(() => {
      extractor = new RequirementsExtractor({ provider: mockProvider("") });
    });

    it("handles invalid JSON gracefully", () => {
      const result = extractor.parseResponse("not json", "raw");
      expect(result.requirements).toEqual([]);
    });

    it("handles missing requirements array", () => {
      const result = extractor.parseResponse(JSON.stringify({ foo: "bar" }), "raw");
      expect(result.requirements).toEqual([]);
    });

    it("strips markdown fences from response", () => {
      const json = JSON.stringify({
        requirements: [
          { title: "Test", description: "Desc", type: "functional", priority: "must-have" },
        ],
      });
      const result = extractor.parseResponse("```json\n" + json + "\n```", "raw");
      expect(result.requirements).toHaveLength(1);
    });

    it("defaults type to functional for invalid types", () => {
      const json = JSON.stringify({
        requirements: [
          { title: "Test", description: "Desc", type: "invalid-type", priority: "must-have" },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.type).toBe("functional");
    });

    it("defaults priority to should-have for invalid priorities", () => {
      const json = JSON.stringify({
        requirements: [
          { title: "Test", description: "Desc", type: "functional", priority: "invalid" },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.priority).toBe("should-have");
    });

    it("filters out requirements without title and description", () => {
      const json = JSON.stringify({
        requirements: [
          { title: "", description: "" },
          { title: "Valid", description: "Has content" },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements).toHaveLength(1);
      expect(result.requirements[0]!.title).toBe("Valid");
    });

    it("handles non-array stakeholders gracefully", () => {
      const json = JSON.stringify({
        requirements: [{ title: "Test", description: "Desc", stakeholders: "not-array" }],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.stakeholders).toEqual([]);
    });

    it("filters non-string stakeholders", () => {
      const json = JSON.stringify({
        requirements: [{ title: "Test", description: "Desc", stakeholders: ["valid", 123, null] }],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.stakeholders).toEqual(["valid"]);
    });

    it("filters ambiguities without description or question", () => {
      const json = JSON.stringify({
        requirements: [
          {
            title: "Test",
            description: "Desc",
            ambiguities: [
              { field: "f1", description: "", suggestedQuestion: "" },
              { field: "f2", description: "has desc", suggestedQuestion: "" },
            ],
          },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.ambiguities).toHaveLength(1);
    });

    it("filters evidence needs without description", () => {
      const json = JSON.stringify({
        requirements: [
          {
            title: "Test",
            description: "Desc",
            evidenceNeeds: [
              { description: "", domain: "general" },
              { description: "valid need", domain: "security" },
            ],
          },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.evidenceNeeds).toHaveLength(1);
    });

    it("correctly counts totals across multiple requirements", () => {
      const json = JSON.stringify({
        requirements: [
          {
            title: "Req1",
            description: "Desc1",
            ambiguities: [{ field: "f1", description: "d1", suggestedQuestion: "q1" }],
            evidenceNeeds: [{ description: "e1", domain: "d" }],
          },
          {
            title: "Req2",
            description: "Desc2",
            ambiguities: [
              { field: "f2", description: "d2", suggestedQuestion: "q2" },
              { field: "f3", description: "d3", suggestedQuestion: "q3" },
            ],
            evidenceNeeds: [],
          },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.totalAmbiguities).toBe(3);
      expect(result.totalEvidenceNeeds).toBe(1);
    });

    it("assigns unique ids to each requirement", () => {
      const json = JSON.stringify({
        requirements: [
          { title: "A", description: "A desc" },
          { title: "B", description: "B desc" },
        ],
      });
      const result = extractor.parseResponse(json, "raw");
      expect(result.requirements[0]!.id).toBeTruthy();
      expect(result.requirements[1]!.id).toBeTruthy();
      expect(result.requirements[0]!.id).not.toBe(result.requirements[1]!.id);
    });

    it("handles all valid requirement types", () => {
      const types = ["functional", "non-functional", "constraint", "assumption", "dependency"];
      for (const type of types) {
        const json = JSON.stringify({
          requirements: [{ title: "T", description: "D", type }],
        });
        const result = extractor.parseResponse(json, "raw");
        expect(result.requirements[0]!.type).toBe(type);
      }
    });
  });
});
