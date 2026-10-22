/**
 * #1377 — the browser's Socket.IO URL is a runtime setting, not a build-time one.
 *
 * The release image used to dial `http://localhost:4000` from every host, because
 * `NEXT_PUBLIC_SOCKET_URL` is inlined by `next build` and the image is built
 * without it. These pin the precedence (runtime override, then the build-time
 * value, then the `next dev` default, then the page's own origin) and the
 * `/runtime-config` body that carries the override.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_SOCKET_URL,
  RUNTIME_CONFIG_GLOBAL,
  browserSocketUrl,
  normalizeSocketUrl,
  readRuntimeConfig,
  resolveSocketUrl,
  runtimeConfigScript,
} from "@/lib/socket-url";
import { GET } from "@/app/runtime-config/route";

const ORIGIN = "https://metis.example.com";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL];
  vi.unstubAllEnvs();
});

describe("normalizeSocketUrl", () => {
  it.each([
    ["https://api.example.com", "https://api.example.com"],
    ["http://localhost:4000", "http://localhost:4000"],
    ["  wss://rt.example.com:8443  ", "wss://rt.example.com:8443"],
    ["ws://10.0.0.5:4000", "ws://10.0.0.5:4000"],
  ])("accepts %s as %s", (input, expected) => {
    expect(normalizeSocketUrl(input)).toBe(expected);
  });

  it("keeps only the origin: a path would be read as a Socket.IO namespace", () => {
    expect(normalizeSocketUrl("https://api.example.com/metis/socket?x=1#y")).toBe(
      "https://api.example.com",
    );
  });

  it.each([
    [undefined],
    [null],
    [42],
    [""],
    ["   "],
    ["/socket.io"],
    ["api.example.com"],
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    ["ftp://example.com"],
    ["https://user:secret@api.example.com"],
    ["http://"],
  ])("rejects %s", (input) => {
    expect(normalizeSocketUrl(input)).toBeNull();
  });
});

describe("resolveSocketUrl precedence", () => {
  it("a production build with no setting dials the page's own origin", () => {
    expect(resolveSocketUrl({ origin: ORIGIN })).toBe(ORIGIN);
  });

  it("`next dev` with no setting keeps the API's dev port", () => {
    expect(resolveSocketUrl({ devUrl: DEV_SOCKET_URL, origin: "http://localhost:3000" })).toBe(
      DEV_SOCKET_URL,
    );
  });

  it("a build-time NEXT_PUBLIC_SOCKET_URL still wins over the defaults", () => {
    expect(
      resolveSocketUrl({
        buildUrl: "http://127.0.0.1:4100",
        devUrl: DEV_SOCKET_URL,
        origin: ORIGIN,
      }),
    ).toBe("http://127.0.0.1:4100");
  });

  it("the runtime override wins over the build-time value", () => {
    expect(
      resolveSocketUrl({
        runtimeUrl: "https://rt.example.com",
        buildUrl: "http://localhost:4000",
        devUrl: DEV_SOCKET_URL,
        origin: ORIGIN,
      }),
    ).toBe("https://rt.example.com");
  });

  it("an invalid value falls through to the next source instead of breaking", () => {
    expect(
      resolveSocketUrl({
        runtimeUrl: "javascript:alert(1)",
        buildUrl: "not a url",
        origin: ORIGIN,
      }),
    ).toBe(ORIGIN);
  });
});

describe("browserSocketUrl (reads the page)", () => {
  it("defaults to window.location.origin when nothing is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", undefined);
    vi.stubEnv("NODE_ENV", "production");
    expect(browserSocketUrl()).toBe(window.location.origin);
  });

  it("never falls back to localhost:4000 outside `next dev`", () => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", undefined);
    for (const nodeEnv of ["production", "test"]) {
      vi.stubEnv("NODE_ENV", nodeEnv);
      expect(browserSocketUrl()).toBe(window.location.origin);
    }
  });

  it("dials the API's dev port under `next dev`", () => {
    vi.stubEnv("NEXT_PUBLIC_SOCKET_URL", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(browserSocketUrl()).toBe(DEV_SOCKET_URL);
  });

  it("uses the value /runtime-config assigned", () => {
    (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL] = {
      socketUrl: "https://rt.example.com",
    };
    expect(browserSocketUrl()).toBe("https://rt.example.com");
  });

  it("ignores a runtime-config global that is not an object", () => {
    (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL] = "https://x.example";
    expect(readRuntimeConfig()).toEqual({});
  });
});

describe("runtimeConfigScript / GET /runtime-config", () => {
  it("serves a null socketUrl when METIS_BROWSER_SOCKET_URL is unset", () => {
    expect(runtimeConfigScript({})).toBe(`window.${RUNTIME_CONFIG_GLOBAL}={"socketUrl":null};\n`);
  });

  it("serves the normalised origin of a valid override", () => {
    expect(runtimeConfigScript({ METIS_BROWSER_SOCKET_URL: "https://rt.example.com/x" })).toBe(
      `window.${RUNTIME_CONFIG_GLOBAL}={"socketUrl":"https://rt.example.com"};\n`,
    );
  });

  it("cannot be used to inject script: a hostile value is dropped, not quoted in", () => {
    const body = runtimeConfigScript({
      METIS_BROWSER_SOCKET_URL: 'https://x.example";alert(1);//</script><script>',
    });
    // WHATWG URL parsing accepts `"` and `;` in that host; the hostname check
    // refuses it, so nothing of the value reaches the script.
    expect(body).toBe(`window.${RUNTIME_CONFIG_GLOBAL}={"socketUrl":null};\n`);
  });

  it("accepts an IPv6 literal host", () => {
    expect(normalizeSocketUrl("http://[::1]:4000/x")).toBe("http://[::1]:4000");
  });

  it("the script assigns exactly what readRuntimeConfig reads back", () => {
    new Function(runtimeConfigScript({ METIS_BROWSER_SOCKET_URL: "wss://rt.example.com" }))();
    expect(readRuntimeConfig()).toEqual({ socketUrl: "wss://rt.example.com" });
  });

  it("the route reads the environment per request, uncached, as JavaScript", async () => {
    vi.stubEnv("METIS_BROWSER_SOCKET_URL", "https://first.example.com");
    const first = GET();
    expect(first.headers.get("content-type")).toMatch(/^application\/javascript/);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await first.text()).toContain("https://first.example.com");

    vi.stubEnv("METIS_BROWSER_SOCKET_URL", "https://second.example.com");
    expect(await GET().text()).toContain("https://second.example.com");
  });
});
