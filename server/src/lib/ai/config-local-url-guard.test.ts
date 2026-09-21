/**
 * URL-guard tests for the local-gemma provider (issue #332).
 *
 * `validateLocalProviderUrl` is the SSRF boundary that keeps document content
 * on-prem: it accepts loopback + RFC-1918 / private endpoints (the canonical
 * local-serving targets — Ollama on the Mac, vLLM on the PC, reached either on
 * the box or over the private LAN / an SSH tunnel) and REJECTS public hosts so a
 * misconfiguration can never egress prompts to a hosted model.
 *
 * #332 expects NO behavior change to config.ts — these tests pin the existing
 * contract for the exact URL shapes the local-serving runbook recommends.
 */
import { describe, it, expect } from "vitest";
import { validateLocalProviderUrl } from "./config.js";
import type { AIEnv } from "./config.js";
import { AIConfigError } from "./errors.js";

// The validator ignores its env argument (signature parity with the Bedrock
// guard), so a bare cast is sufficient for these cases.
const env = {} as AIEnv;

describe("validateLocalProviderUrl — loopback endpoints (accepted)", () => {
  it.each([
    "http://localhost:11434/v1", // Mac Ollama (the canonical default)
    "http://127.0.0.1:8000/v1", // PC vLLM on the box
    "http://127.0.0.1:11434/v1",
    "http://[::1]:8000/v1", // IPv6 loopback
    "https://localhost:11434/v1", // https loopback is fine too
  ])("accepts %s", (url) => {
    expect(() => validateLocalProviderUrl(url, env)).not.toThrow();
  });
});

describe("validateLocalProviderUrl — RFC-1918 / private endpoints (accepted)", () => {
  it.each([
    "http://192.168.1.50:8000/v1", // cross-machine: PC vLLM over the LAN
    "http://192.168.0.10:11434/v1", // cross-machine: Mac Ollama over the LAN
    "http://10.0.0.12:11434/v1", // 10/8 private
    "http://172.16.4.5:8000/v1", // 172.16/12 private
  ])("accepts %s", (url) => {
    expect(() => validateLocalProviderUrl(url, env)).not.toThrow();
  });
});

describe("validateLocalProviderUrl — public hosts (rejected)", () => {
  it("rejects a generic public hostname", () => {
    expect(() => validateLocalProviderUrl("http://example.com/v1", env)).toThrow(AIConfigError);
    expect(() => validateLocalProviderUrl("http://example.com/v1", env)).toThrow(
      /loopback or private/i,
    );
  });

  it("rejects a public IP literal", () => {
    expect(() => validateLocalProviderUrl("http://8.8.8.8/v1", env)).toThrow(AIConfigError);
  });

  it("rejects known public LLM hosts with a credential-egress message", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://my-resource.openai.azure.com/v1",
      "https://api.anthropic.com/v1",
    ]) {
      expect(() => validateLocalProviderUrl(url, env)).toThrow(/public LLM provider/i);
    }
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => validateLocalProviderUrl("ftp://localhost/v1", env)).toThrow(/http or https/i);
  });

  it("rejects a malformed URL", () => {
    expect(() => validateLocalProviderUrl("not a url", env)).toThrow(/not a valid URL/i);
  });
});
