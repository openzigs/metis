/**
 * Epic #396 / Issue #431 — server wiring tests.
 *
 * The high-level `McpServer` from the SDK is exercised in-process: we
 * register the tools, then invoke them by reaching into the registry the
 * same way the underlying transport would. This keeps the test hermetic
 * (no stdio pipe required) while still proving the wiring.
 */
import { describe, expect, it, vi } from "vitest";
import { createSpecKitMcpServer } from "./server.js";
import type { FetchLike } from "./dispatcher.js";

const ENV = process.env;

function withAllowlist<T>(value: string | undefined, fn: () => T): T {
  const prevHosts = ENV.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
  const prevPub = ENV.METIS_PUBLIC_URL;
  if (value === undefined) delete ENV.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
  else ENV.SPECKIT_INSTALL_ALLOWED_API_HOSTS = value;
  delete ENV.METIS_PUBLIC_URL;
  try {
    return fn();
  } finally {
    if (prevHosts === undefined) delete ENV.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
    else ENV.SPECKIT_INSTALL_ALLOWED_API_HOSTS = prevHosts;
    if (prevPub === undefined) delete ENV.METIS_PUBLIC_URL;
    else ENV.METIS_PUBLIC_URL = prevPub;
  }
}

describe("createSpecKitMcpServer", () => {
  it("registers the nine speckit_* tools", () => {
    withAllowlist("https://metis.local", () => {
      const fetchImpl: FetchLike = vi.fn();
      const server = createSpecKitMcpServer({
        config: {
          apiBaseUrl: "https://metis.local",
          projectId: "p1",
          token: "tok",
        },
        fetchImpl,
      });
      // The SDK exposes a private `_registeredTools` map keyed by name.
      const registry = (server as unknown as { _registeredTools: Record<string, unknown> })
        ._registeredTools;
      expect(Object.keys(registry).sort()).toEqual(
        [
          "speckit_analyze",
          "speckit_checklist",
          "speckit_clarify",
          "speckit_constitution",
          "speckit_implement",
          "speckit_plan",
          "speckit_specify",
          "speckit_tasks",
          "speckit_taskstoissues",
        ].sort(),
      );
    });
  });

  it("dispatches a tool invocation through fetch and returns text content", async () => {
    await withAllowlist("https://metis.local", async () => {
      const fetchImpl = vi.fn(async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({ success: true, data: { artifact: { name: "spec.md" } } }),
      }));
      const server = createSpecKitMcpServer({
        config: {
          apiBaseUrl: "https://metis.local",
          projectId: "p1",
          token: "tok",
        },
        fetchImpl: fetchImpl as unknown as FetchLike,
      });
      const tool = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }> }
          >;
        }
      )._registeredTools["speckit_specify"];
      const result = await tool.handler({ prompt: "Add OAuth" }, {});
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toContain("/spec-kit/commands/speckit.specify");
      expect(result.content[0]!.text).toContain("spec.md");
    });
  });

  it("returns isError=true on dispatch failure", async () => {
    await withAllowlist("https://metis.local", async () => {
      const fetchImpl: FetchLike = async () => ({
        status: 412,
        ok: false,
        text: async () => JSON.stringify({ error: "SPECKIT_GATE_UNMET" }),
      });
      const server = createSpecKitMcpServer({
        config: {
          apiBaseUrl: "https://metis.local",
          projectId: "p1",
          token: "tok",
        },
        fetchImpl,
      });
      const tool = (
        server as unknown as {
          _registeredTools: Record<
            string,
            {
              handler: (
                args: unknown,
                extra: unknown,
              ) => Promise<{ isError?: boolean; content: { text: string }[] }>;
            }
          >;
        }
      )._registeredTools["speckit_plan"];
      const result = await tool.handler({ featureSlug: "001-x" }, {});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/speckit\.plan failed/);
    });
  });

  it("throws at boot when the apiBaseUrl is not on the allow-list", () => {
    withAllowlist("https://other.example", () => {
      expect(() =>
        createSpecKitMcpServer({
          config: {
            apiBaseUrl: "https://metis.local",
            projectId: "p1",
            token: "tok",
          },
        }),
      ).toThrow(/not on the .* allowlist/);
    });
  });
});

describe("readConfigFromEnv (boot helper)", () => {
  it("falls back to empty strings when env vars are unset", async () => {
    const { __readConfigFromEnvForTests } = await import("./server.js");
    const cfg = __readConfigFromEnvForTests({} as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ apiBaseUrl: "", projectId: "", token: "" });
  });

  it("reads METIS_* env vars when present", async () => {
    const { __readConfigFromEnvForTests } = await import("./server.js");
    const cfg = __readConfigFromEnvForTests({
      METIS_API_BASE_URL: "https://x.example.com",
      METIS_PROJECT_ID: "p1",
      METIS_SERVICE_TOKEN: "tok",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      apiBaseUrl: "https://x.example.com",
      projectId: "p1",
      token: "tok",
    });
  });
});

describe("main() boot helper", () => {
  it("connects an McpServer to a stdio transport", async () => {
    const prevHosts = process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
    const prevPub = process.env.METIS_PUBLIC_URL;
    const prevBase = process.env.METIS_API_BASE_URL;
    const prevProj = process.env.METIS_PROJECT_ID;
    const prevTok = process.env.METIS_SERVICE_TOKEN;
    process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = "https://metis.local";
    delete process.env.METIS_PUBLIC_URL;
    process.env.METIS_API_BASE_URL = "https://metis.local";
    process.env.METIS_PROJECT_ID = "p1";
    process.env.METIS_SERVICE_TOKEN = "tok";
    try {
      // StdioServerTransport defaults to wrapping process.stdin/stdout. We don't
      // intercept those — `connect()` only opens listeners, it doesn't block.
      const { main } = await import("./server.js");
      await main();
    } finally {
      if (prevHosts === undefined) delete process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
      else process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = prevHosts;
      if (prevPub === undefined) delete process.env.METIS_PUBLIC_URL;
      else process.env.METIS_PUBLIC_URL = prevPub;
      if (prevBase === undefined) delete process.env.METIS_API_BASE_URL;
      else process.env.METIS_API_BASE_URL = prevBase;
      if (prevProj === undefined) delete process.env.METIS_PROJECT_ID;
      else process.env.METIS_PROJECT_ID = prevProj;
      if (prevTok === undefined) delete process.env.METIS_SERVICE_TOKEN;
      else process.env.METIS_SERVICE_TOKEN = prevTok;
    }
  });
});

describe("createSpecKitMcpServer default fetch", () => {
  it("falls back to global fetch when fetchImpl is not provided", async () => {
    const prevHosts = process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
    const prevPub = process.env.METIS_PUBLIC_URL;
    process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = "https://metis.local";
    delete process.env.METIS_PUBLIC_URL;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ success: true, data: {} }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const { createSpecKitMcpServer } = await import("./server.js");
      const server = createSpecKitMcpServer({
        config: {
          apiBaseUrl: "https://metis.local",
          projectId: "p1",
          token: "tok",
        },
      });
      const tool = (
        server as unknown as {
          _registeredTools: Record<string, { handler: (args: unknown) => Promise<unknown> }>;
        }
      )._registeredTools["speckit_tasks"];
      const result = (await tool.handler({})) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (prevHosts === undefined) delete process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS;
      else process.env.SPECKIT_INSTALL_ALLOWED_API_HOSTS = prevHosts;
      if (prevPub === undefined) delete process.env.METIS_PUBLIC_URL;
      else process.env.METIS_PUBLIC_URL = prevPub;
    }
  });
});
