/**
 * #1584 — the Teams installation read, through the real `apiFetch`.
 *
 * "Not connected" is `200 { data: null }` now, not a 404 the browser logs to
 * the console on every visit to Settings → Integrations → Teams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamsIntegrationApi } from "@/lib/teams-integration-api";

function respond(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Error",
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("teamsIntegrationApi.getInstallation (#1584)", () => {
  it("reads 'not connected' as null from a 200 with null data", async () => {
    fetchMock.mockReturnValue(respond({ success: true, data: null }));
    await expect(teamsIntegrationApi.getInstallation("ws 1")).resolves.toBeNull();
    expect(String(fetchMock.mock.calls[0]![0])).toMatch(
      /\/integrations\/teams\/workspaces\/ws%201\/installation$/,
    );
  });

  it("returns the summary when installed", async () => {
    fetchMock.mockReturnValue(respond({ success: true, data: { appId: "app-1" } }));
    await expect(teamsIntegrationApi.getInstallation("ws-1")).resolves.toEqual({
      appId: "app-1",
    });
  });

  // #2197 — the two tests above passed against the pre-#1584 client too, which
  // caught a 404 and returned null. Not connected is a 200 now, so a 404 is a
  // real failure (a wrong route, a workspace gone) and must not read as one.
  it("throws on a 404 rather than reading it as not connected", async () => {
    fetchMock.mockReturnValue(
      respond({ success: false, error: { code: "NOT_FOUND", message: "Not found" } }, 404),
    );
    await expect(teamsIntegrationApi.getInstallation("ws-1")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("still fails on an error, rather than reading it as not connected", async () => {
    fetchMock.mockReturnValue(
      respond({ success: false, error: { code: "FORBIDDEN", message: "no" } }, 403),
    );
    await expect(teamsIntegrationApi.getInstallation("ws-1")).rejects.toMatchObject({
      status: 403,
    });
  });
});
