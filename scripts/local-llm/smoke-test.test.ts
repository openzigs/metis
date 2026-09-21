import { describe, it, expect } from "vitest";
import { parseArgs, resolveOptions, chatCompletionsUrl } from "./smoke-test.mjs";

describe("parseArgs", () => {
  it("parses --flag value pairs", () => {
    expect(parseArgs(["--base", "http://x/v1", "--model", "qwen2.5:14b"])).toEqual({
      base: "http://x/v1",
      model: "qwen2.5:14b",
    });
  });

  it("treats a flag followed by another flag as a boolean", () => {
    expect(parseArgs(["--verbose", "--model", "m"])).toEqual({ verbose: true, model: "m" });
  });

  it("treats a trailing flag with no value as boolean true", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ "dry-run": true });
  });

  it("ignores non-flag positional tokens", () => {
    expect(parseArgs(["junk", "--model", "m", "more"])).toEqual({ model: "m" });
  });

  it("returns an empty object for empty argv", () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe("resolveOptions", () => {
  it("prefers argv over env", () => {
    const opts = resolveOptions(["--base", "http://argv/v1", "--model", "argv-model"], {
      LOCAL_GEMMA_BASE_URL: "http://env/v1",
      LOCAL_GEMMA_MODEL: "env-model",
    });
    expect(opts.base).toBe("http://argv/v1");
    expect(opts.model).toBe("argv-model");
  });

  it("falls back to env vars when no argv flags are given", () => {
    const opts = resolveOptions([], {
      LOCAL_GEMMA_BASE_URL: "http://localhost:11434/v1",
      LOCAL_GEMMA_MODEL: "qwen2.5:14b",
      LOCAL_GEMMA_API_KEY: "secret",
    });
    expect(opts.base).toBe("http://localhost:11434/v1");
    expect(opts.model).toBe("qwen2.5:14b");
    expect(opts.apiKey).toBe("secret");
  });

  it("applies defaults for model, api-key, prompt, max-tokens and timeout", () => {
    const opts = resolveOptions([], {});
    expect(opts.base).toBeUndefined();
    expect(opts.model).toBe("gemma4:12b");
    expect(opts.apiKey).toBe("ollama");
    expect(opts.prompt).toMatch(/METIS/);
    expect(opts.maxTokens).toBe(256);
    expect(opts.timeoutMs).toBe(30000);
  });

  it("parses numeric --max-tokens and --timeout from argv", () => {
    const opts = resolveOptions(["--max-tokens", "512", "--timeout", "5000"], {});
    expect(opts.maxTokens).toBe(512);
    expect(opts.timeoutMs).toBe(5000);
  });

  it("falls back to defaults when numeric flags are non-positive or non-numeric", () => {
    const opts = resolveOptions(["--max-tokens", "0", "--timeout", "abc"], {});
    expect(opts.maxTokens).toBe(256);
    expect(opts.timeoutMs).toBe(30000);
  });

  it("ignores blank/whitespace env values", () => {
    const opts = resolveOptions([], { LOCAL_GEMMA_BASE_URL: "   ", LOCAL_GEMMA_MODEL: "" });
    expect(opts.base).toBeUndefined();
    expect(opts.model).toBe("gemma4:12b");
  });
});

describe("chatCompletionsUrl", () => {
  it("appends /chat/completions to a /v1 base", () => {
    expect(chatCompletionsUrl("http://localhost:11434/v1")).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(chatCompletionsUrl("http://localhost:8000/v1/")).toBe(
      "http://localhost:8000/v1/chat/completions",
    );
  });
});
