/**
 * #2232 — the Anthropic adapter sends an `image_url` part as an image block. It used to
 * flatten any message with a non-text part to its text, so "describe this image" reached
 * the model with no image and the description that came back was invented.
 *
 * The SDK is mocked (as in `anthropic-provider.test.ts`): the assertion is on the request
 * body handed to `messages.create`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createSpy = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: vi.fn() };
    models = { list: vi.fn() };
  }
  return { default: FakeAnthropic };
});

import { AnthropicProvider } from "./anthropic-provider.js";
import type { ChatMessage } from "../types.js";

function lastUserContent(): unknown {
  const body = createSpy.mock.calls.at(-1)?.[0] as { messages: Array<{ content: unknown }> };
  return body.messages.at(-1)?.content;
}

beforeEach(() => {
  createSpy.mockReset();
  createSpy.mockResolvedValue({
    content: [{ type: "text", text: "described" }],
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
});

describe("AnthropicProvider image parts (#2232)", () => {
  it("sends a data-URI image as a base64 image block beside its text", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ];
    await new AnthropicProvider({ apiKey: "k" }).chat(messages);
    expect(lastUserContent()).toEqual([
      { type: "text", text: "Describe this image." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
  });

  it("sends a remote image as a URL source, even when it is the only part", async () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://example.com/a.png" } }],
      },
    ];
    await new AnthropicProvider({ apiKey: "k" }).chat(messages);
    expect(lastUserContent()).toEqual([
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
    ]);
  });

  it("still sends a single text part as a plain string", async () => {
    await new AnthropicProvider({ apiKey: "k" }).chat([
      { role: "user", content: [{ type: "text", text: "just text" }] },
    ]);
    expect(lastUserContent()).toBe("just text");
  });
});
