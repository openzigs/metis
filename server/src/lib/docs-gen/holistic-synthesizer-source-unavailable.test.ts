/**
 * Issue #330 — doc-gen must NOT silently produce empty, 0%-grounded facts when a
 * module's source files cannot be read (clone/extract dir missing or purged, or
 * a cache-key rebuild ran against files no longer on disk). `extractModuleFacts`
 * now flags such a module `sourceUnavailable` so the caller raises a LOUD
 * `source-unavailable` document warning, and it skips the fact-cache write so the
 * empty facts don't poison future runs.
 *
 * Fully deterministic: prisma + node:fs/promises are mocked; the provider is an
 * offline stub (no network). `readFile` behaviour is switched per test so we can
 * simulate readable vs unreadable source.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";

const readFileMock = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const findUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../prisma.js", () => ({
  prisma: {
    finding: { findMany: vi.fn().mockResolvedValue([]) },
    docsGenFactCache: {
      findUnique: findUniqueMock,
      update: vi.fn().mockResolvedValue({}),
      upsert: upsertMock,
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: readFileMock,
  readdir: vi.fn().mockResolvedValue([]),
}));

import { extractModuleFacts, type ModuleGroup } from "./holistic-synthesizer.js";
import type { AIProvider } from "../ai/types.js";

/** Offline provider so we DON'T need a network stub, but the cache path IS
 * exercised (offline skips the cache write/read entirely, so for the cache
 * assertions we use a non-offline stub below). */
function offlineProvider(): AIProvider {
  return {
    key: "offline-stub",
    model: "mock",
    offline: true,
    chat: vi.fn(),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

/** Non-offline stub whose stream yields a small facts blob, so the cache-write
 * branch is reachable and we can assert it is (not) taken. */
function onlineProvider(): AIProvider {
  return {
    key: "online-stub",
    model: "mock-sonnet",
    offline: false,
    chat: vi.fn(),
    stream: vi.fn().mockImplementation(async function* () {
      yield { type: "delta", content: "PURPOSE\nstub facts\n" };
      yield {
        type: "usage",
        usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 0 },
      };
    }),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock-sonnet"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

/** A TypeScript module with one method symbol, so a source READ is expected. */
function tsModule(): ModuleGroup {
  return {
    dir: "src/svc",
    syms: [
      {
        id: "t1",
        codeGraphId: "graph-a",
        qualifiedName: "svc.ts::handler",
        kind: "function",
        language: "ts",
        filePath: "src/svc/svc.ts",
        startLine: 1,
        endLine: 20,
      },
    ],
  };
}

/** A virtual SQL-only module: NO method/class symbols → no source read expected. */
function sqlOnlyModule(): ModuleGroup {
  return { dir: "db/migrations", syms: [] };
}

describe("extractModuleFacts — #330 source-unavailable guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
  });

  it.each(["/gone", null])(
    "flags sourceUnavailable for unavailable root %s without cwd fallback",
    async (root) => {
      if (root === null) {
        // Even readable cwd source must not substitute for an unavailable root.
        readFileMock.mockResolvedValue("export function handler() { return 1; }\n");
      } else {
        readFileMock.mockRejectedValue(
          Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }),
        );
      }
      const facts = await extractModuleFacts(tsModule(), offlineProvider(), false, "p1", root);
      expect(facts).not.toBeNull();
      expect(facts!.sourceUnavailable).toBe(true);
      if (root === null) expect(readFileMock).not.toHaveBeenCalled();
    },
  );

  it("does NOT flag sourceUnavailable when source reads succeed", async () => {
    readFileMock.mockResolvedValue("export function handler() { if (x > 0) return 1; }\n");
    const facts = await extractModuleFacts(tsModule(), offlineProvider(), false, "p1", "/clone");
    expect(facts!.sourceUnavailable).toBeFalsy();
  });

  it("does NOT flag a code-less (virtual SQL-only) module as sourceUnavailable", async () => {
    // No method symbols → no read expected → a zero-read is normal, not a defect.
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    const facts = await extractModuleFacts(
      sqlOnlyModule(),
      offlineProvider(),
      false,
      "p1",
      "/clone",
    );
    expect(facts!.sourceUnavailable).toBeFalsy();
  });

  it("skips the fact-cache write when source is unavailable (no cache poisoning)", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    await extractModuleFacts(tsModule(), onlineProvider(), false, "p1", "/gone");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("DOES write the fact cache when source reads succeed", async () => {
    readFileMock.mockResolvedValue("export function handler() { return 1; }\n");
    await extractModuleFacts(tsModule(), onlineProvider(), false, "p1", "/clone");
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
