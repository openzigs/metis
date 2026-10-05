/** #754 — the shared forwarding decorator behind every provider wrapper. */
import { describe, expect, it, vi } from "vitest";
import { decorateProvider } from "./provider-decorator.js";
import type { AIProvider, ChatResponse } from "./types.js";

const RESPONSE: ChatResponse = { content: "ok", model: "m", provider: "anthropic" } as ChatResponse;

class Adapter {
  readonly key = "anthropic";
  readonly model = "m";
  readonly offline = false;
  readonly capabilities = { responseFormat: true, nativeToolCalls: true };
  calls = 0;
  async chat(): Promise<ChatResponse> {
    this.calls += 1;
    return RESPONSE;
  }
  async *stream() {}
  async embed() {
    return { vectors: [], model: "e", dimensions: 0 };
  }
  async models() {
    return [this.model];
  }
  async ping() {
    return true;
  }
  servesRouterModel(id: string) {
    return id === this.model;
  }
  async chatTwice() {
    await this.chat();
    return this.chat();
  }
}

describe("decorateProvider", () => {
  it("answers overrides first, including symbol markers", async () => {
    const marker = Symbol("marker");
    const chat = vi.fn(async () => ({ ...RESPONSE, content: "wrapped" }));
    const wrapped = decorateProvider(new Adapter() as unknown as AIProvider, {
      chat,
      [marker]: true,
    });
    expect((await wrapped.chat([])).content).toBe("wrapped");
    expect((wrapped as unknown as Record<symbol, unknown>)[marker]).toBe(true);
    expect(marker in wrapped).toBe(true);
  });

  it("forwards every other member bound to the adapter", async () => {
    const inner = new Adapter();
    const chat = vi.fn(async () => RESPONSE);
    const wrapped = decorateProvider(inner as unknown as AIProvider, { chat });
    expect(wrapped.capabilities).toBe(inner.capabilities);
    expect(wrapped.servesRouterModel?.("m")).toBe(true);
    expect(await wrapped.models()).toEqual(["m"]);
    // An internal `this.chat()` reaches the adapter, not the override.
    await (wrapped as unknown as Adapter).chatTwice();
    expect(inner.calls).toBe(2);
    expect(chat).not.toHaveBeenCalled();
  });

  it("leaves an absent optional member absent", () => {
    const wrapped = decorateProvider(new Adapter() as unknown as AIProvider, {});
    expect(wrapped.capabilitiesFor).toBeUndefined();
    expect("capabilitiesFor" in wrapped).toBe(false);
  });
});
