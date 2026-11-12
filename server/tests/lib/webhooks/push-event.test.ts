/**
 * #2335 — every push field the receiver acts on matches a strict pattern.
 */
import { describe, expect, it } from "vitest";
import { parsePushEvent } from "../../../src/lib/webhooks/push-event.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "a".repeat(64);

function push(over: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    before: "f".repeat(40),
    after: SHA,
    commits: [],
    pusher: { name: "dev" },
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
    ...over,
  };
}

describe("parsePushEvent (#2335)", () => {
  it("reads a branch push", () => {
    expect(parsePushEvent(push())).toEqual({
      kind: "branch",
      branch: "main",
      commitSha: SHA,
      repoFullName: "acme/app",
      repoHtmlUrl: "https://github.com/acme/app",
    });
  });

  it("accepts nested branch names and SHA-256 object ids", () => {
    expect(parsePushEvent(push({ ref: "refs/heads/release/2.x", after: SHA256 }))).toMatchObject({
      kind: "branch",
      branch: "release/2.x",
      commitSha: SHA256,
    });
  });

  it("has no html_url when the payload carries none", () => {
    expect(parsePushEvent(push({ repository: { full_name: "acme/app" } }))).toMatchObject({
      repoHtmlUrl: null,
    });
  });

  it("ignores a tag push", () => {
    expect(parsePushEvent(push({ ref: "refs/tags/v1.0.0" }))).toEqual({
      kind: "ignored",
      reason: "TAG_PUSH",
    });
  });

  it.each([
    ["deleted: true", { deleted: true, after: SHA }],
    ["an all-zero after", { after: "0".repeat(40) }],
    ["a deleted tag", { ref: "refs/tags/v1", after: "0".repeat(40) }],
  ])("ignores a deletion (%s)", (_label, over) => {
    expect(parsePushEvent(push(over))).toEqual({ kind: "ignored", reason: "REF_DELETED" });
  });

  it.each([
    "refs/heads/main;rm -rf /",
    "refs/heads/$(id)",
    "refs/heads/a..b",
    "refs/heads/a//b",
    "refs/heads/-upload-pack=x",
    "refs/heads/.hidden",
    "refs/heads/x.lock",
    "refs/heads/x/",
    "refs/heads/x.",
    "refs/heads/",
    "refs/pull/1/head",
    "main",
    "refs/heads/a b",
    `refs/heads/${"a".repeat(241)}`,
  ])("refuses the ref %j", (ref) => {
    expect(parsePushEvent(push({ ref }))).toEqual({ kind: "ignored", reason: "INVALID_REF" });
  });

  it("refuses a non-string ref", () => {
    expect(parsePushEvent(push({ ref: 42 }))).toEqual({ kind: "ignored", reason: "INVALID_REF" });
  });

  it.each(["abc", SHA.toUpperCase(), `${SHA}0`, "g".repeat(40), "", 7])(
    "refuses the commit %j",
    (after) => {
      expect(parsePushEvent(push({ after }))).toEqual({
        kind: "ignored",
        reason: "INVALID_COMMIT_SHA",
      });
    },
  );

  it.each([
    "acme",
    "acme/app/extra",
    "acme/app;id",
    "../etc/passwd",
    "acme/ app",
    `${"a".repeat(101)}/app`,
  ])("refuses the repository %j", (full_name) => {
    expect(parsePushEvent(push({ repository: { full_name } }))).toEqual({
      kind: "ignored",
      reason: "INVALID_REPOSITORY",
    });
  });

  it("refuses a body that is not an object", () => {
    expect(parsePushEvent(null)).toEqual({ kind: "ignored", reason: "INVALID_REPOSITORY" });
    expect(parsePushEvent(push({ repository: "acme/app" }))).toEqual({
      kind: "ignored",
      reason: "INVALID_REPOSITORY",
    });
  });
});
