/**
 * #2232 — the project describer behind Word-document image descriptions: it asks the model
 * only when the project's provider reports `vision`, resolves that provider once per
 * document and only on the first image, and degrades to "not read" (null) rather than
 * failing the ingest when no provider can be built.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../src/lib/ai/types.js";
import {
  buildImageDescriptionMessages,
  canDescribeImages,
  projectImageDescriber,
  providerImageDescriber,
} from "../src/lib/documents/image-description.js";
import type { DocxImage } from "../src/lib/documents/docx-to-markdown.js";

const IMAGE: DocxImage = {
  index: 1,
  name: "image1.png",
  contentType: "image/png",
  altText: "Login wireframe",
  data: Buffer.from("png-bytes"),
};

function fakeProvider(opts: { vision?: boolean; offline?: boolean; reply?: string } = {}) {
  const chat = vi.fn(async (_m: ChatMessage[], _o?: ChatOptions) => ({
    content: opts.reply ?? "a description",
  }));
  const provider = {
    key: "anthropic",
    model: "claude-sonnet-5-5",
    offline: opts.offline ?? false,
    capabilities: { responseFormat: false, nativeToolCalls: false },
    capabilitiesFor: (model: string) => ({
      responseFormat: false,
      nativeToolCalls: false,
      vision: model === "claude-sonnet-5-5" && (opts.vision ?? true),
    }),
    chat,
  } as unknown as AIProvider;
  return { provider, chat };
}

describe("buildImageDescriptionMessages", () => {
  it("sends the image as a base64 data URI with the alt text in the request", () => {
    const [system, user] = buildImageDescriptionMessages("image/png", "QUJD", "Login wireframe");
    expect(system.role).toBe("system");
    expect(user.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('alt text for it is: "Login wireframe"'),
      }),
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("says nothing about alt text when there is none", () => {
    const [, user] = buildImageDescriptionMessages("image/png", "QUJD");
    expect(JSON.stringify(user.content)).not.toContain("alt text");
  });
});

describe("providerImageDescriber", () => {
  it("asks a vision model, tools off, and returns its reply", async () => {
    const { provider, chat } = fakeProvider();
    expect(canDescribeImages(provider)).toBe(true);
    expect(await providerImageDescriber(provider)(IMAGE)).toBe("a description");
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = chat.mock.calls[0];
    expect(options).toEqual({ disableTools: true });
    expect(JSON.stringify(messages)).toContain(
      `data:image/png;base64,${IMAGE.data.toString("base64")}`,
    );
  });

  it("answers null without calling a model that reports no vision", async () => {
    const { provider, chat } = fakeProvider({ vision: false });
    expect(canDescribeImages(provider)).toBe(false);
    expect(await providerImageDescriber(provider)(IMAGE)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });

  it("answers null for the offline stub, whatever it reports", async () => {
    const { provider, chat } = fakeProvider({ offline: true });
    expect(await providerImageDescriber(provider)(IMAGE)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("projectImageDescriber", () => {
  it("resolves the project's provider once, on the first image, for every image after", async () => {
    const { provider, chat } = fakeProvider();
    const resolve = vi.fn(async () => provider);
    const describer = projectImageDescriber("p1", resolve);
    expect(resolve).not.toHaveBeenCalled();
    await describer(IMAGE);
    await describer({ ...IMAGE, index: 2 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("p1");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("answers null, once resolved, when the provider cannot be built", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("no credential");
    });
    const describer = projectImageDescriber("p1", resolve);
    expect(await describer(IMAGE)).toBeNull();
    expect(await describer(IMAGE)).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
