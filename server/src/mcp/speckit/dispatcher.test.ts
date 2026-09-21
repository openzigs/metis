/**
 * Epic #396 / Issue #431 — dispatcher unit tests.
 */
import { describe, expect, it, vi } from "vitest";
import {
  SpecKitMcpHttpError,
  assertConfig,
  dispatchToHttp,
  type FetchLike,
  type SpecKitMcpConfig,
} from "./dispatcher.js";

const ENV = process.env;

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = ENV[k];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete ENV[k];
    else ENV[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete ENV[k];
      else ENV[k] = v;
    }
  }
}

const goodCfg: SpecKitMcpConfig = {
  apiBaseUrl: "https://metis.local",
  projectId: "proj-1",
  token: "secret-token",
};

describe("assertConfig", () => {
  it("rejects missing required fields", () => {
    expect(() => assertConfig({ apiBaseUrl: "", projectId: "p", token: "t" })).toThrow(
      /METIS_API_BASE_URL/,
    );
    expect(() =>
      assertConfig({ apiBaseUrl: "https://metis.local", projectId: "", token: "t" }),
    ).toThrow(/METIS_PROJECT_ID/);
    expect(() =>
      assertConfig({ apiBaseUrl: "https://metis.local", projectId: "p", token: "" }),
    ).toThrow(/METIS_SERVICE_TOKEN/);
  });

  it("rejects an apiBaseUrl that is not on the allow-list", () => {
    withEnv(
      { METIS_PUBLIC_URL: undefined, SPECKIT_INSTALL_ALLOWED_API_HOSTS: "https://allowed.example" },
      () => {
        expect(() =>
          assertConfig({ apiBaseUrl: "https://evil.example", projectId: "p", token: "t" }),
        ).toThrow(/not on the .* allowlist/);
      },
    );
  });

  it("accepts an apiBaseUrl whose origin matches the allow-list", () => {
    withEnv(
      {
        METIS_PUBLIC_URL: undefined,
        SPECKIT_INSTALL_ALLOWED_API_HOSTS: "https://metis.local",
      },
      () => {
        expect(() => assertConfig(goodCfg)).not.toThrow();
      },
    );
  });
});

describe("dispatchToHttp", () => {
  function fetchOk(body: unknown, status = 200): FetchLike {
    return vi.fn(async () => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(body),
    }));
  }

  function fetchErr(body: unknown, status = 412): FetchLike {
    return vi.fn(async () => ({
      status,
      ok: false,
      text: async () => JSON.stringify(body),
    }));
  }

  it("POSTs to the namespaced spec-kit commands endpoint with JSON body + bearer auth", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    }));
    await dispatchToHttp(
      goodCfg,
      { command: "speckit.specify", input: "Build me a thing", body: { featureSlug: "001-thing" } },
      fetchImpl as unknown as FetchLike,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://metis.local/api/projects/proj-1/spec-kit/commands/speckit.specify");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBe("Bearer secret-token");
    expect(init.headers["x-speckit-force"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      input: "Build me a thing",
      featureSlug: "001-thing",
    });
  });

  it("strips trailing slashes from apiBaseUrl when building the URL", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => "{}",
    }));
    await dispatchToHttp(
      { ...goodCfg, apiBaseUrl: "https://metis.local/" },
      { command: "speckit.tasks" },
      fetchImpl as unknown as FetchLike,
    );
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://metis.local/api/projects/proj-1/spec-kit/commands/speckit.tasks");
  });

  it("forwards the X-Speckit-Force header when force=true", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => "{}",
    }));
    await dispatchToHttp(
      goodCfg,
      { command: "speckit.plan", body: { featureSlug: "x" }, force: true },
      fetchImpl as unknown as FetchLike,
    );
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init.headers["x-speckit-force"]).toBe("true");
  });

  it("returns parsed JSON on success", async () => {
    const result = await dispatchToHttp(
      goodCfg,
      { command: "speckit.tasks" },
      fetchOk({ success: true, data: { count: 2 } }),
    );
    expect(result).toEqual({ success: true, data: { count: 2 } });
  });

  it("falls back to raw text when the body is not JSON", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      ok: true,
      text: async () => "ok",
    });
    const r = await dispatchToHttp(goodCfg, { command: "speckit.implement" }, fetchImpl);
    expect(r).toBe("ok");
  });

  it("throws SpecKitMcpHttpError with status + body on non-2xx", async () => {
    const errBody = { error: "SPECKIT_GATE_UNMET", required: "specGate" };
    await expect(
      dispatchToHttp(
        goodCfg,
        { command: "speckit.plan", body: { featureSlug: "x" } },
        fetchErr(errBody, 412),
      ),
    ).rejects.toMatchObject({
      name: "SpecKitMcpHttpError",
      status: 412,
      body: errBody,
    });
  });

  it("encodes projectId and command for the URL", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      text: async () => "{}",
    }));
    await dispatchToHttp(
      { ...goodCfg, projectId: "proj id/with weird" },
      { command: "speckit.specify", input: "" },
      fetchImpl as unknown as FetchLike,
    );
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/projects/proj%20id%2Fwith%20weird/spec-kit/commands/speckit.specify");
  });

  it("preserves the SpecKitMcpHttpError class for instanceof checks", () => {
    const err = new SpecKitMcpHttpError("boom", 500, null);
    expect(err).toBeInstanceOf(SpecKitMcpHttpError);
    expect(err).toBeInstanceOf(Error);
  });
});
