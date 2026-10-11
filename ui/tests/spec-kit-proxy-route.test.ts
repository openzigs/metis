// @vitest-environment node
/**
 * #1069 — the catch-all proxy sends Spec Kit commands, and only those, through
 * the long-timeout fetch; and that fetch is built once from the env var.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const undici = vi.hoisted(() => ({
  agentOptions: [] as unknown[],
  fetch: vi.fn(),
}));

vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      undici.agentOptions.push(options);
    }
  },
  fetch: undici.fetch,
}));

import { GET, POST } from "@/app/api/[...path]/route";
import { ACCESS_COOKIE, UPSTREAM_API_BASE } from "@/lib/config";
import {
  SPEC_KIT_PROXY_TIMEOUT_ENV,
  _resetSpecKitCommandFetch,
  specKitCommandFetch,
} from "@/lib/spec-kit-proxy-timeout";

const globalFetch = vi.fn();
const ok = (): Response =>
  new Response('{"success":true,"data":{"message":"planned"}}', {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const request = (method: string, path: string, body?: string): NextRequest => {
  const req = new NextRequest(new Request(`http://localhost/api/${path}`, { method, body }));
  req.cookies.set(ACCESS_COOKIE, "the-access-token");
  return req;
};
const ctx = (path: string) => ({ params: Promise.resolve({ path: path.split("/") }) });

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
  globalFetch.mockReset().mockImplementation(async () => ok());
  undici.fetch.mockReset().mockImplementation(async () => ok());
  undici.agentOptions.length = 0;
  _resetSpecKitCommandFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the proxy's upstream timeout", () => {
  it("sends a Spec Kit command through the long-timeout agent", async () => {
    const path = "projects/p1/spec-kit/commands/speckit.plan";
    const res = await POST(request("POST", path, '{"input":""}'), ctx(path));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { message: "planned" } });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undici.fetch).toHaveBeenCalledTimes(1);
    expect(undici.agentOptions).toEqual([{ headersTimeout: 900_000, bodyTimeout: 900_000 }]);

    const [url, init] = undici.fetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers; dispatcher: unknown; duplex: string; body: unknown },
    ];
    expect(String(url)).toBe(`${UPSTREAM_API_BASE}/${path}`);
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer the-access-token");
    expect(init.duplex).toBe("half");
    expect(init.body).toBeTruthy();
    expect(init.dispatcher).toBeDefined();
  });

  it.each([
    ["GET", "projects/p1/spec-kit/files"],
    ["GET", "projects/p1/spec-kit/commands/speckit.plan"],
    ["POST", "projects/p1/spec-kit/constitution"],
    ["POST", "projects/p1/analysis"],
    ["POST", "chat/stream"],
  ])("leaves %s %s on the default fetch", async (method, path) => {
    const handler = method === "GET" ? GET : POST;
    const res = await handler(
      request(method, path, method === "GET" ? undefined : "{}"),
      ctx(path),
    );

    expect(res.status).toBe(200);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(undici.agentOptions).toEqual([]);
    const init = globalFetch.mock.calls[0]![1] as Record<string, unknown>;
    expect("dispatcher" in init).toBe(false);
  });

  it("reads the timeout from the env var, bounded", async () => {
    vi.stubEnv(SPEC_KIT_PROXY_TIMEOUT_ENV, "1200000");
    specKitCommandFetch();
    _resetSpecKitCommandFetch();
    vi.stubEnv(SPEC_KIT_PROXY_TIMEOUT_ENV, "1");
    specKitCommandFetch();
    expect(undici.agentOptions).toEqual([
      { headersTimeout: 1_200_000, bodyTimeout: 1_200_000 },
      { headersTimeout: 300_000, bodyTimeout: 300_000 },
    ]);
  });

  it("builds one agent and reuses it for every command", async () => {
    const path = "projects/p1/spec-kit/commands/speckit.tasks";
    await POST(request("POST", path, "{}"), ctx(path));
    await POST(request("POST", path, "{}"), ctx(path));
    expect(undici.fetch).toHaveBeenCalledTimes(2);
    expect(undici.agentOptions).toHaveLength(1);
    const dispatchers = undici.fetch.mock.calls.map(
      (c) => (c[1] as { dispatcher: unknown }).dispatcher,
    );
    expect(dispatchers[0]).toBe(dispatchers[1]);
  });
});
