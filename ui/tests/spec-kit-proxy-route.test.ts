// @vitest-environment node
/**
 * #1069 — the catch-all proxy sends Spec Kit commands, and only those, through
 * the long-timeout fetch; that fetch is built once from the env var; and a
 * decoded segment cannot rename the upstream route.
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

const request = (method: string, body?: string, signal?: AbortSignal): NextRequest => {
  // The request URL plays no part in routing here: the handler reads the
  // segments Next decoded for it, which `ctx` supplies.
  const req = new NextRequest(
    new Request("http://localhost/api/x", { method, body, ...(signal ? { signal } : {}) }),
  );
  req.cookies.set(ACCESS_COOKIE, "the-access-token");
  return req;
};
/** The catch-all's params exactly as Next passes them: one DECODED string per segment. */
const ctx = (...segments: string[]) => ({ params: Promise.resolve({ path: segments }) });
const COMMAND = ["projects", "p1", "spec-kit", "commands"] as const;

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
    const res = await POST(request("POST", '{"input":""}'), ctx(...COMMAND, "speckit.plan"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { message: "planned" } });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undici.fetch).toHaveBeenCalledTimes(1);
    expect(undici.agentOptions).toEqual([
      { headersTimeout: 900_000, bodyTimeout: 900_000, connections: 16 },
    ]);

    const [url, init] = undici.fetch.mock.calls[0] as [
      URL,
      { method: string; headers: Headers; dispatcher: unknown; duplex: string; body: unknown },
    ];
    expect(String(url)).toBe(`${UPSTREAM_API_BASE}/projects/p1/spec-kit/commands/speckit.plan`);
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer the-access-token");
    expect(init.duplex).toBe("half");
    expect(init.body).toBeTruthy();
    expect(init.dispatcher).toBeDefined();
  });

  it.each([
    ["GET", ["projects", "p1", "spec-kit", "files"]],
    ["GET", ["projects", "p1", "spec-kit", "commands", "speckit.plan"]],
    ["POST", ["projects", "p1", "spec-kit", "constitution"]],
    ["POST", ["projects", "p1", "analysis"]],
    ["POST", ["chat", "stream"]],
  ])("leaves %s %j on the default fetch", async (method, path) => {
    const handler = method === "GET" ? GET : POST;
    const res = await handler(request(method, method === "GET" ? undefined : "{}"), ctx(...path));

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
      { headersTimeout: 1_200_000, bodyTimeout: 1_200_000, connections: 16 },
      { headersTimeout: 300_000, bodyTimeout: 300_000, connections: 16 },
    ]);
  });

  it("builds one agent and reuses it for every command", async () => {
    await POST(request("POST", "{}"), ctx(...COMMAND, "speckit.tasks"));
    await POST(request("POST", "{}"), ctx(...COMMAND, "speckit.tasks"));
    expect(undici.fetch).toHaveBeenCalledTimes(2);
    expect(undici.agentOptions).toHaveLength(1);
    const dispatchers = undici.fetch.mock.calls.map(
      (c) => (c[1] as { dispatcher: unknown }).dispatcher,
    );
    expect(dispatchers[0]).toBe(dispatchers[1]);
  });
});

// Next decodes each catch-all segment, so `..%2F..%2Fchat%2Fstream` reaches the
// handler as ONE element holding slashes. These feed that decoded form
// directly — `"a/b".split("/")` can never produce it.
describe("a decoded segment cannot rename the upstream route", () => {
  it.each([
    ["walks up to another API route", [...COMMAND, "../../../../chat/stream"]],
    ["walks up to a sibling Spec Kit route", [...COMMAND, "x/../../constitution"]],
    ["walks up with backslashes", [...COMMAND, "..\\..\\constitution"]],
    ["starts a query string", [...COMMAND, "x?y=1"]],
    ["starts a fragment", [...COMMAND, "x#y"]],
    ["traverses from the project id", ["projects", "../../a", "spec-kit", "commands", "x"]],
    ["walks out of /api to /health", [...COMMAND, "../../../../../health"]],
    ["is a dot segment", [...COMMAND, ".."]],
    ["is a percent-encoded dot segment", [...COMMAND, "%2e%2E"]],
    ["hides a dot segment behind a tab", [...COMMAND, ".\t."]],
    ["holds a slash on an ordinary route", ["projects", "p1/../p2", "analysis"]],
  ])("refuses a segment that %s", async (_name, path) => {
    const res = await POST(request("POST", "{}"), ctx(...path));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "BAD_REQUEST", message: "Invalid request path" },
    });
    // Nothing is sent upstream — on either fetch, so no long timeout either.
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undici.agentOptions).toEqual([]);
  });

  it("refuses it for a GET too", async () => {
    const res = await GET(request("GET"), ctx("projects", "p1", "../../../health"));
    expect(res.status).toBe(400);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a space", ["projects", "p1", "documents", "my doc.md"], "projects/p1/documents/my%20doc.md"],
    [
      "a nested artifact key",
      [
        "projects",
        "p1",
        "spec-kit",
        "features",
        "f1",
        "artifacts",
        "contracts",
        "api.openapi.yaml",
      ],
      "projects/p1/spec-kit/features/f1/artifacts/contracts/api.openapi.yaml",
    ],
    [
      "dots in a name",
      ["projects", "p1", "files", "..hidden", "a..b"],
      "projects/p1/files/..hidden/a..b",
    ],
    ["a still-encoded slash", ["ai", "sessions", "a%2Fb"], "ai/sessions/a%2Fb"],
    ["other punctuation", ["admin", "config", "a:b@c+d,e;f=g&h"], "admin/config/a:b@c+d,e;f=g&h"],
  ])("still proxies a segment with %s", async (_name, path, upstream) => {
    const res = await GET(request("GET"), ctx(...path));

    expect(res.status).toBe(200);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(String(globalFetch.mock.calls[0]![0])).toBe(`${UPSTREAM_API_BASE}/${upstream}`);
  });

  it("gives a command whose name holds an encoded character the long timeout", async () => {
    const res = await POST(request("POST", "{}"), ctx(...COMMAND, "speckit plan"));
    expect(res.status).toBe(200);
    expect(String(undici.fetch.mock.calls[0]![0])).toBe(
      `${UPSTREAM_API_BASE}/projects/p1/spec-kit/commands/speckit%20plan`,
    );
  });

  it("still answers 404 for /auth, which has its own proxy", async () => {
    const res = await POST(request("POST", "{}"), ctx("auth", "login"));
    expect(res.status).toBe(404);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("a client that goes away", () => {
  it.each([
    ["a Spec Kit command", [...COMMAND, "speckit.plan"], undici.fetch],
    ["any other route", ["projects", "p1", "analysis"], globalFetch],
  ])("aborts the upstream request of %s", async (_name, path, sent) => {
    const client = new AbortController();
    await POST(request("POST", "{}", client.signal), ctx(...path));

    const init = sent.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
    client.abort();
    expect(init.signal!.aborted).toBe(true);
  });
});
