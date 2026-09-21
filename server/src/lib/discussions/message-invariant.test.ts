/**
 * Epic #475 (Phase 1, #476) — DiscussionMessage author-invariant tests.
 *
 * The schema cannot express a portable partial CHECK across SQLite + Postgres,
 * so the human/ai author invariant is enforced in application code before every
 * insert. These tests pin the invariant contract:
 *   - authorKind = "human" ⇒ authorUserId SET, aiModel/aiProvider/aiSessionId NULL
 *   - authorKind = "ai"    ⇒ aiModel SET, authorUserId NULL
 */
import { describe, expect, it } from "vitest";
import {
  assertMessageInvariant,
  buildHumanMessageData,
  buildAiMessageData,
  DiscussionInvariantError,
} from "./message-invariant.js";

describe("assertMessageInvariant", () => {
  describe("human author", () => {
    it("accepts a well-formed human message", () => {
      expect(() =>
        assertMessageInvariant({ authorKind: "human", authorUserId: "u1", body: "hi" }),
      ).not.toThrow();
    });

    it("rejects a human message with no authorUserId", () => {
      expect(() =>
        assertMessageInvariant({ authorKind: "human", authorUserId: null, body: "hi" }),
      ).toThrow(DiscussionInvariantError);
    });

    it("rejects a human message that also carries aiModel", () => {
      expect(() =>
        assertMessageInvariant({
          authorKind: "human",
          authorUserId: "u1",
          aiModel: "gpt-4",
          body: "hi",
        }),
      ).toThrow(/human/i);
    });

    it("rejects a human message that also carries aiProvider", () => {
      expect(() =>
        assertMessageInvariant({
          authorKind: "human",
          authorUserId: "u1",
          aiProvider: "openai",
          body: "hi",
        }),
      ).toThrow(DiscussionInvariantError);
    });

    it("rejects a human message that also carries aiSessionId", () => {
      expect(() =>
        assertMessageInvariant({
          authorKind: "human",
          authorUserId: "u1",
          aiSessionId: "s1",
          body: "hi",
        }),
      ).toThrow(DiscussionInvariantError);
    });
  });

  describe("ai author", () => {
    it("accepts a well-formed ai message", () => {
      expect(() =>
        assertMessageInvariant({
          authorKind: "ai",
          aiModel: "gpt-4",
          aiProvider: "openai",
          body: "answer",
        }),
      ).not.toThrow();
    });

    it("rejects an ai message with no aiModel", () => {
      expect(() =>
        assertMessageInvariant({ authorKind: "ai", aiModel: null, body: "answer" }),
      ).toThrow(DiscussionInvariantError);
    });

    it("rejects an ai message that also carries authorUserId", () => {
      expect(() =>
        assertMessageInvariant({
          authorKind: "ai",
          aiModel: "gpt-4",
          authorUserId: "u1",
          body: "answer",
        }),
      ).toThrow(/ai/i);
    });
  });

  it("rejects an unknown authorKind", () => {
    expect(() =>
      assertMessageInvariant({
        authorKind: "robot" as unknown as "human",
        body: "x",
      }),
    ).toThrow(DiscussionInvariantError);
  });
});

describe("buildHumanMessageData", () => {
  it("produces invariant-valid data with ai columns nulled", () => {
    const data = buildHumanMessageData({ threadId: "t1", authorUserId: "u1", body: "hello" });
    expect(data).toMatchObject({
      threadId: "t1",
      authorKind: "human",
      authorUserId: "u1",
      aiProvider: null,
      aiModel: null,
      aiSessionId: null,
      body: "hello",
    });
    expect(() => assertMessageInvariant(data)).not.toThrow();
  });
});

describe("buildAiMessageData", () => {
  it("produces invariant-valid data with authorUserId nulled", () => {
    const data = buildAiMessageData({
      threadId: "t1",
      aiProvider: "openai",
      aiModel: "gpt-4",
      aiSessionId: "s1",
      body: "answer",
    });
    expect(data).toMatchObject({
      threadId: "t1",
      authorKind: "ai",
      authorUserId: null,
      aiProvider: "openai",
      aiModel: "gpt-4",
      aiSessionId: "s1",
      body: "answer",
    });
    expect(() => assertMessageInvariant(data)).not.toThrow();
  });

  it("allows a null aiSessionId (session link is optional)", () => {
    const data = buildAiMessageData({
      threadId: "t1",
      aiProvider: "openai",
      aiModel: "gpt-4",
      body: "answer",
    });
    expect(data.aiSessionId).toBeNull();
    expect(() => assertMessageInvariant(data)).not.toThrow();
  });
});
