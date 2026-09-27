/**
 * #236 review — POST /ai/sessions refuses a custom agent the session cannot
 * bind (404 AGENT_NOT_FOUND: the project neither owns nor enables it; 400
 * AGENT_REQUIRES_PROJECT: the project was stale and the session went
 * unscoped). The client retries ONCE with the default agent and reports the
 * agent it dropped, instead of leaving the user with no session.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const apiFetch = vi.fn();

vi.mock("./api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  streamFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

const { createSessionWithScope } = await import("./ai-client");
const { ApiError } = await import("./api-client");

const SESSION = { id: "sess_1", projectId: "p1" };

beforeEach(() => {
  apiFetch.mockReset();
});

describe("createSessionWithScope — an unbindable custom agent (#236)", () => {
  it.each([
    [404, "AGENT_NOT_FOUND"],
    [400, "AGENT_REQUIRES_PROJECT"],
  ])("retries once without the custom agent on %i %s", async (status, code) => {
    apiFetch
      .mockRejectedValueOnce(new ApiError(status, "refused", code))
      .mockResolvedValueOnce({ session: SESSION });
    const out = await createSessionWithScope({
      title: "New Chat",
      projectId: "p1",
      agentRef: "custom:ag-b",
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0]![1].body).toMatchObject({ agentRef: "custom:ag-b" });
    const retried = apiFetch.mock.calls[1]![1].body as Record<string, unknown>;
    expect(retried).not.toHaveProperty("agentRef");
    expect(retried).toMatchObject({ title: "New Chat", projectId: "p1" });
    expect(out.session).toEqual(SESSION);
    expect(out.droppedAgentRef).toBe("custom:ag-b");
  });

  it("retries only once — a second refusal surfaces", async () => {
    apiFetch.mockImplementation(async () => {
      throw new ApiError(404, "refused", "AGENT_NOT_FOUND");
    });
    await expect(
      createSessionWithScope({ projectId: "p1", agentRef: "custom:ag-b" }),
    ).rejects.toThrow("refused");
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry other refusals, or a library agent", async () => {
    apiFetch.mockImplementation(async () => {
      throw new ApiError(403, "forbidden", "FORBIDDEN");
    });
    await expect(
      createSessionWithScope({ projectId: "p1", agentRef: "custom:ag-b" }),
    ).rejects.toThrow("forbidden");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    apiFetch.mockReset();
    apiFetch.mockImplementation(async () => {
      throw new ApiError(404, "gone", "AGENT_NOT_FOUND");
    });
    await expect(createSessionWithScope({ agentRef: "library:lib-1" })).rejects.toThrow("gone");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("reports no dropped agent on success", async () => {
    apiFetch.mockResolvedValueOnce({ session: SESSION });
    const out = await createSessionWithScope({ projectId: "p1", agentRef: "custom:ag-a" });
    expect(out.droppedAgentRef).toBeUndefined();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
