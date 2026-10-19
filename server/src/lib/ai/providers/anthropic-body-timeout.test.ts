/**
 * #1209 — the Anthropic adapter wraps every SDK failure as
 * `anthropic <op> failed (<name>): <message>` with no cause, so undici's body
 * timeout (`TypeError: terminated` over a `BodyTimeoutError`) read exactly like
 * a dropped connection and docs-gen retried it as one. The adapter now keeps
 * the body timeout itself as the mapped error's cause, and only that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const streamSpy = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: vi.fn(), stream: streamSpy };
    models = { list: vi.fn() };
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "./anthropic-provider.js";
import { isBodyTimeout } from "../../docs-gen/generation-failure-message.js";

/** An SDK stream handle that sends one delta, then fails with `err`. */
function failingWith(err: Error) {
  return {
    controller: { abort: vi.fn() },
    finalMessage: vi.fn(),
    async *[Symbol.asyncIterator]() {
      yield { type: "content_block_delta", delta: { type: "text_delta", text: "Section" } };
      throw err;
    },
  };
}

async function streamError(err: Error): Promise<unknown> {
  streamSpy.mockReturnValueOnce(failingWith(err));
  try {
    for await (const _ of new AnthropicProvider({ apiKey: "k" }).stream([
      { role: "user", content: "q" },
    ])) {
      /* drain */
    }
  } catch (e) {
    return e;
  }
  throw new Error("expected the stream to fail");
}

beforeEach(() => streamSpy.mockReset());

describe("AnthropicProvider — #1209 a body timeout stays recognisable once wrapped", () => {
  it("keeps undici's BodyTimeoutError as the cause of the mapped error", async () => {
    const timeout = Object.assign(new Error("Body Timeout Error"), {
      name: "BodyTimeoutError",
      code: "UND_ERR_BODY_TIMEOUT",
    });
    const err = await streamError(new TypeError("terminated", { cause: timeout }));
    expect((err as Error).message).toBe("anthropic stream failed (TypeError): terminated");
    expect(isBodyTimeout(err)).toBe(true);
    expect((err as { cause?: unknown }).cause).toBe(timeout);
  });

  it("attaches no cause to a real drop", async () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const err = await streamError(new TypeError("terminated", { cause: socket }));
    expect(isBodyTimeout(err)).toBe(false);
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});
