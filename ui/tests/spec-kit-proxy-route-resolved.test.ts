// @vitest-environment node
/**
 * #1069 — the proxy's second rule, with its first one switched off.
 *
 * The route refuses a hostile segment before it builds a URL
 * (spec-kit-proxy-route.test.ts). Here that check is mocked away, so what is
 * left is the rule that must hold on its own: the timeout, the `/auth`
 * exclusion and the "stay under the base" refusal are decided from the
 * RESOLVED upstream path, never from the raw segments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const undici = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", () => ({ Agent: class {}, fetch: undici.fetch }));
vi.mock("@/lib/proxy-upstream", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/proxy-upstream")>()),
  isUnsafeProxySegment: () => false,
}));

import { POST } from "@/app/api/[...path]/route";
import { UPSTREAM_API_BASE } from "@/lib/config";
import { _resetSpecKitCommandFetch } from "@/lib/spec-kit-proxy-timeout";

const globalFetch = vi.fn();
const post = (...segments: string[]) =>
  POST(new NextRequest(new Request("http://localhost/api/x", { method: "POST", body: "{}" })), {
    params: Promise.resolve({ path: segments }),
  });
const COMMAND = ["projects", "p1", "spec-kit", "commands"] as const;

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockReset().mockImplementation(async () => new Response("{}"));
  undici.fetch.mockReset().mockImplementation(async () => new Response("{}"));
  _resetSpecKitCommandFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("with the segment check off, the resolved path still decides", () => {
  // Five raw segments that spell a Spec Kit command and resolve to another route.
  it.each([
    [[...COMMAND, "../../../../chat/stream"], "chat/stream"],
    [[...COMMAND, "x/../../constitution"], "projects/p1/spec-kit/constitution"],
    [[...COMMAND, "..\\..\\constitution"], "projects/p1/constitution"],
    [["projects", "x/../../chat", "spec-kit", "commands", "x"], "chat/spec-kit/commands/x"],
  ])("%j gets the default timeout: it is really %s", async (path, route) => {
    const res = await post(...path);

    expect(res.status).toBe(200);
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String(globalFetch.mock.calls[0]![0])).toBe(`${UPSTREAM_API_BASE}/${route}`);
  });

  it("a real command still gets the long timeout", async () => {
    await post(...COMMAND, "speckit.plan");
    expect(undici.fetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([
    [[...COMMAND, "../../../../../health"]],
    [["projects", "../../a", "spec-kit", "commands", "x"]],
    [["..", "health"]],
    [["%2e%2e", "health"]],
    [[".\t.", "health"]],
  ])("refuses %j, which resolves outside the upstream base", async (path) => {
    const res = await post(...path);

    expect(res.status).toBe(400);
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("answers 404 for a path that resolves to /auth", async () => {
    const res = await post("projects", "../auth/login");
    expect(res.status).toBe(404);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
