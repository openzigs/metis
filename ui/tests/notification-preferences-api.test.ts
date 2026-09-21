/**
 * Issue #613 (epic #608) — typed client for the self-service notification
 * preference endpoints (GET/PUT /api/users/me/notification-preferences).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/lib/api-client", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, apiFetch: apiFetchMock };
});

import { notificationPreferencesApi } from "@/lib/notification-preferences-api";

const PATH = "/users/me/notification-preferences";

const ROWS = [
  { channel: "email", event: "analysisCompleted", enabled: true, isDefault: true },
  { channel: "webhook", event: "mention", enabled: false, isDefault: true },
];

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe("notificationPreferencesApi", () => {
  it("get() fetches the resolved matrix and unwraps the preferences list", async () => {
    apiFetchMock.mockResolvedValueOnce({ preferences: ROWS });
    const result = await notificationPreferencesApi.get();
    expect(apiFetchMock).toHaveBeenCalledWith(PATH);
    expect(result).toEqual(ROWS);
  });

  it("put() sends the entries as a PUT body and unwraps the returned matrix", async () => {
    apiFetchMock.mockResolvedValueOnce({ preferences: ROWS });
    const entries = [{ channel: "webhook" as const, event: "mention" as const, enabled: true }];
    const result = await notificationPreferencesApi.put(entries);
    expect(apiFetchMock).toHaveBeenCalledWith(PATH, {
      method: "PUT",
      body: { preferences: entries },
    });
    expect(result).toEqual(ROWS);
  });

  it("propagates API errors unchanged (no swallowing)", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("boom"));
    await expect(notificationPreferencesApi.get()).rejects.toThrow("boom");
  });
});
