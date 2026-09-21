/**
 * Unit tests for the plugin packaging module (#115).
 */
import { describe, expect, it } from "vitest";
import {
  PluginFormatError,
  pack,
  pluginFileName,
  repack,
  unpack,
} from "../src/lib/plugins/index.js";

describe("plugin packaging", () => {
  const stableTimestamp = "2026-04-25T00:00:00.000Z";

  it("produces a deterministic envelope (pack ∘ unpack ∘ pack idempotency)", () => {
    const buf1 = pack({
      manifest: { name: "demo", version: "1.0.0", description: "test" },
      skills: [
        {
          name: "scan",
          description: "",
          version: "0.1.0",
          instructions: "do stuff",
          tools: ["a", "b"],
          tags: ["x"],
        },
      ],
      agents: [
        {
          name: "BA",
          description: "",
          systemPrompt: "do",
          tools: [],
        },
      ],
      hooks: [
        {
          event: "preToolUse",
          handlerKind: "webhook",
          config: { url: "https://example.com/h" },
        },
      ],
      exportedAt: stableTimestamp,
    });
    const buf2 = repack(buf1);
    expect(buf1.toString()).toEqual(buf2.toString());
  });

  it("rejects an invalid slug in pluginFileName", () => {
    expect(() => pluginFileName("Bad Slug")).toThrowError(PluginFormatError);
    expect(() => pluginFileName("0bad")).toThrowError(PluginFormatError);
    expect(pluginFileName("ok-slug")).toBe("metis-plugin-ok-slug.json");
  });

  it("rejects a manifest name that is not a slug", () => {
    expect(() =>
      pack({
        manifest: { name: "Bad Name", version: "1.0.0", description: "" },
        exportedAt: stableTimestamp,
      }),
    ).toThrowError(PluginFormatError);
  });

  it("unpack rejects malformed JSON", () => {
    expect(() => unpack("not json")).toThrowError(PluginFormatError);
  });

  it("unpack rejects an envelope with a wrong format / version", () => {
    const bad = JSON.stringify({
      format: "wrong",
      version: "1.0",
      manifest: {},
      skills: [],
      agents: [],
      hooks: [],
    });
    expect(() => unpack(bad)).toThrowError(PluginFormatError);
  });

  it("round-trips a real envelope", () => {
    const buf = pack({
      manifest: { name: "demo", version: "1.0.0", description: "" },
      skills: [],
      agents: [],
      hooks: [],
      exportedAt: stableTimestamp,
    });
    const env = unpack(buf);
    expect(env.format).toBe("metis-plugin");
    expect(env.manifest.name).toBe("demo");
    expect(env.manifest.exportedAt).toBe(stableTimestamp);
  });

  it("validates hook event/kind enums", () => {
    const buf = JSON.stringify({
      format: "metis-plugin",
      version: "1.0",
      manifest: { name: "demo", version: "1.0.0", description: "", exportedAt: stableTimestamp },
      skills: [],
      agents: [],
      hooks: [{ event: "unknown", handlerKind: "webhook", config: {} }],
    });
    expect(() => unpack(buf)).toThrowError(PluginFormatError);
  });

  it("supports empty skills/agents/hooks lists", () => {
    const buf = pack({
      manifest: { name: "demo", version: "1.0.0", description: "" },
      exportedAt: stableTimestamp,
    });
    const env = unpack(buf);
    expect(env.skills).toEqual([]);
    expect(env.agents).toEqual([]);
    expect(env.hooks).toEqual([]);
  });
});
