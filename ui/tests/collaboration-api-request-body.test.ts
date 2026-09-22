/**
 * #14 — requirement edits, comments, replies, comment edits and assignments
 * all returned 500 because `collaboration-api` passed `JSON.stringify(x)` to
 * `apiFetch`, which JSON-encodes the body again. The server received a JSON
 * *string* (`"{\"reviewStatus\":…}"`) and its strict parser rejected it.
 *
 * The existing collaboration tests mock `apiFetch` itself, so they could never
 * see the bytes on the wire. These run the REAL `apiFetch` and stub only
 * `fetch`, then decode the body exactly as the server's `express.json()`
 * (strict) would: it must be a JSON object, not a JSON string.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetAuthRetryState } from "@/lib/api-client";
import { assignmentApi, commentApi, requirementUpdateApi } from "@/lib/collaboration-api";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({ success: true, data: {} }),
  }));
  _resetAuthRetryState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The body of the single request sent, decoded once — as the server does. */
function sentBody(): unknown {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(typeof init.body).toBe("string");
  return JSON.parse(init.body as string);
}

describe("collaboration-api sends JSON objects, not JSON strings (#14)", () => {
  it("requirementUpdateApi.update — the approve-requirement path", async () => {
    await requirementUpdateApi.update("req-1", { reviewStatus: "approved", version: 3 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/requirements/req-1");
    expect(init.method).toBe("PUT");
    expect(sentBody()).toEqual({ reviewStatus: "approved", version: 3 });
  });

  it("commentApi.createForRequirement", async () => {
    await commentApi.createForRequirement("req-1", { title: "t", body: "hello" });
    expect(sentBody()).toEqual({ title: "t", body: "hello" });
  });

  it("commentApi.createForArtifact", async () => {
    await commentApi.createForArtifact("p1", "spec.md", { body: "note" });
    expect(sentBody()).toEqual({ body: "note" });
  });

  it("commentApi.reply", async () => {
    await commentApi.reply("thread-1", "a reply");
    expect(sentBody()).toEqual({ body: "a reply" });
  });

  it("commentApi.edit", async () => {
    await commentApi.edit("comment-1", "edited");
    expect(sentBody()).toEqual({ body: "edited" });
  });

  it("assignmentApi.assign", async () => {
    await assignmentApi.assign("req-1", { assigneeId: "u2", slaDeadline: null });
    expect(sentBody()).toEqual({ assigneeId: "u2", slaDeadline: null });
  });
});
