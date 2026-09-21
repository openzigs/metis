/**
 * Publish target resolver / host allow-list — Phase 9 (#67).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "github.example.com",
    address: "10.20.30.40",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

import {
  assertConnectorHostAllowed,
  resolveAndAssertConnectorHost,
} from "../src/lib/connectors/network-allowlist.js";
import { resolvePublishTarget } from "../src/lib/publishing/host-allowlist.js";
import { PublishError } from "../src/lib/publishing/types.js";

const assertHost = vi.mocked(assertConnectorHostAllowed);
const resolveHost = vi.mocked(resolveAndAssertConnectorHost);

afterEach(() => {
  assertHost.mockClear();
  resolveHost.mockClear();
  // Restore default success behavior for both mocks (in case a test overrode them).
  assertHost.mockResolvedValue(undefined);
  resolveHost.mockResolvedValue({
    hostname: "github.example.com",
    address: "10.20.30.40",
    family: 4 as const,
  });
});

describe("resolvePublishTarget", () => {
  it("accepts public github.com without DNS pinning", async () => {
    const t = await resolvePublishTarget({ owner: "acme", repo: "metis" });
    expect(t.hostname).toBe("api.github.com");
    expect(t.pinnedAddress).toBeUndefined();
    expect(assertHost).not.toHaveBeenCalled();
  });

  it("rejects invalid owner / repo names", async () => {
    await expect(
      resolvePublishTarget({ owner: "../etc/passwd", repo: "metis" }),
    ).rejects.toBeInstanceOf(PublishError);
    await expect(
      resolvePublishTarget({ owner: "acme", repo: "with space" }),
    ).rejects.toBeInstanceOf(PublishError);
  });

  it("rejects HTTP base URLs", async () => {
    await expect(
      resolvePublishTarget({ owner: "acme", repo: "metis", baseUrl: "http://github.example.com" }),
    ).rejects.toMatchObject({ code: "INSECURE_BASE_URL" });
  });

  it("rejects unparseable base URLs", async () => {
    await expect(
      resolvePublishTarget({ owner: "acme", repo: "metis", baseUrl: "not-a-url" }),
    ).rejects.toMatchObject({ code: "INVALID_BASE_URL" });
  });

  it("requires GHE hosts to pass the allow-list and DNS pin", async () => {
    const t = await resolvePublishTarget({
      owner: "acme",
      repo: "metis",
      baseUrl: "https://github.example.com/api/v3",
    });
    expect(t.pinnedAddress).toBe("10.20.30.40");
    expect(assertHost).toHaveBeenCalledWith("github.example.com", "repo");
    expect(resolveHost).toHaveBeenCalledWith("github.example.com", "repo");
  });

  it("propagates allow-list rejection", async () => {
    assertHost.mockRejectedValueOnce(new Error("HOST_NOT_ALLOWED"));
    await expect(
      resolvePublishTarget({
        owner: "acme",
        repo: "metis",
        baseUrl: "https://github.example.com/api/v3",
      }),
    ).rejects.toBeTruthy();
  });
});
