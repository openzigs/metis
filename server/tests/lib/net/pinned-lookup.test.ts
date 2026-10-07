/**
 * #750: one pinned-lookup implementation, shared by every pinned transport.
 *
 * `safe-fetch.ts` used to keep its own copy of the pinned `lookup`. #13's
 * `{ all: true }` fix landed in `makePinnedLookup` and never reached the copy,
 * so every default-dispatcher `safeFetch` broke on Node 22 (#716). These tests
 * fail if the copies drift apart again:
 *
 *   1. a source guard: no server module other than `net/pinned-lookup.ts`
 *      answers a `lookup` callback itself;
 *   2. a runtime check: `safeFetch`'s default dispatcher and the connector
 *      allow-list's `makePinnedDispatcher` both build their lookup through
 *      the shared `makePinnedLookup`, and the result reaches a real server
 *      through the built-in `fetch` with `autoSelectFamily` on.
 */
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const sharedSpy = vi.hoisted(() => ({ calls: [] as [string | undefined, unknown][] }));

vi.mock("../../../src/lib/net/pinned-lookup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/net/pinned-lookup.js")>();
  return {
    ...actual,
    makePinnedLookup: (address: string | undefined, family: 4 | 6 | undefined) => {
      sharedSpy.calls.push([address, family]);
      return actual.makePinnedLookup(address, family);
    },
  };
});

const { safeFetch } = await import("../../../src/lib/net/safe-fetch.js");
const { makePinnedDispatcher, makePinnedLookup } =
  await import("../../../src/lib/connectors/network-allowlist.js");
const shared = await import("../../../src/lib/net/pinned-lookup.js");

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src");
const SHARED_FILE = path.join("lib", "net", "pinned-lookup.ts");

/**
 * The two shapes a hand-rolled pinned lookup has to contain: the
 * single-address answer (`cb(null, address, family)`) and the `{ all: true }`
 * branch. Either one outside the shared module is a second implementation.
 */
const LOOKUP_ANSWER =
  /\b(?:cb|callback|done)\s*\(\s*null\s*,\s*[A-Za-z_.]*[aA]ddress\b|\.all\s*===\s*true/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const servers: http.Server[] = [];

afterEach(async () => {
  sharedSpy.calls.length = 0;
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function target(): Promise<{ port: number; hosts: (string | undefined)[] }> {
  const hosts: (string | undefined)[] = [];
  const server = http.createServer((req, res) => {
    hosts.push(req.headers.host);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, hosts };
}

describe("pinned lookup — exactly one implementation (#750)", () => {
  it("no server module other than net/pinned-lookup.ts answers a lookup callback", () => {
    const offenders = sourceFiles(SERVER_SRC)
      .filter((f) => path.relative(SERVER_SRC, f) !== SHARED_FILE)
      .filter((f) => LOOKUP_ANSWER.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(SERVER_SRC, f));
    expect(offenders, "use makePinnedLookup from lib/net/pinned-lookup.ts").toEqual([]);
  });

  it("the guard recognises a hand-rolled copy", () => {
    // Keeps the guard honest: both shapes of the old safe-fetch copy match.
    expect(LOOKUP_ANSWER.test("cb(null, pinned.address, fam);")).toBe(true);
    expect(LOOKUP_ANSWER.test("if ((options as { all?: unknown }).all === true) {")).toBe(true);
    expect(LOOKUP_ANSWER.test("cb(null, rows);")).toBe(false);
  });

  it("the connector allow-list re-exports the shared helper, not a copy", () => {
    expect(readFileSync(path.join(SERVER_SRC, SHARED_FILE), "utf8")).toMatch(
      /export function makePinnedLookup\(/,
    );
    expect(makePinnedLookup).toBe(shared.makePinnedLookup);
  });
});

describe("every pinned dispatcher builds its lookup through makePinnedLookup (#750)", () => {
  it("safeFetch's default dispatcher, through the real fetch with autoSelectFamily on", async () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    const t = await target();
    // A hostname, not an IP literal: Node skips `lookup` entirely for a
    // literal, which is how the drifted copy hid from the IP-literal tests.
    const res = await safeFetch(`http://safe.metis.invalid:${t.port}/`, {
      resolver: async () => [{ address: "127.0.0.1", family: 4 }],
      allowedHosts: new Set(["safe.metis.invalid"]),
    });
    expect(await res.text()).toBe("pinned-ok");
    expect(t.hosts).toEqual([`safe.metis.invalid:${t.port}`]);
    expect(sharedSpy.calls).toEqual([["127.0.0.1", 4]]);
  });

  it("the connector allow-list's makePinnedDispatcher, through the real fetch", async () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    const t = await target();
    const d = await makePinnedDispatcher({
      hostname: "repo.metis.invalid",
      address: "127.0.0.1",
      family: 4,
    });
    try {
      const res = await globalThis.fetch(`http://repo.metis.invalid:${t.port}/`, {
        dispatcher: d,
      } as RequestInit & { dispatcher?: unknown });
      expect(await res.text()).toBe("pinned-ok");
    } finally {
      await d.close?.();
    }
    expect(sharedSpy.calls).toEqual([["127.0.0.1", 4]]);
  });
});
