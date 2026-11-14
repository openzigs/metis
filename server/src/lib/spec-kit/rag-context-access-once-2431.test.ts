/**
 * #2431 — a Spec Kit build loads the shared code-access filter once: the fused
 * block's anchors, the callers and the localisation judge one snapshot of the
 * restrictions, not two loads that a restriction change between them could
 * make disagree.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const loadSharedCodeAccess = vi.fn();
vi.mock("../analysis/tools/code-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analysis/tools/code-access.js")>()),
  loadSharedCodeAccess: (...args: unknown[]) => loadSharedCodeAccess(...args),
}));

const { buildSpecKitRagContext } = await import("./rag-context.js");
const { codeAccessFilterOf } = await import("../analysis/tools/code-access.js");
const { __resetConfigSingleton } = await import("../config/config-service.js");

afterEach(() => {
  __resetConfigSingleton();
  loadSharedCodeAccess.mockReset();
});

const ENTRY = "internal/storage/entry.go";
const CALLER = "internal/ui/unread_mark_all_read.go";

describe("#2431 — the Spec Kit code-access load", () => {
  it("is shared by the fused anchors and the callers: one load per build", async () => {
    // Some other file is restricted: the anchor and its caller are shown.
    loadSharedCodeAccess.mockImplementation(async () =>
      codeAccessFilterOf([{ connectorId: "rc-1", path: "internal/billing/secret.go" }]),
    );
    const res = await buildSpecKitRagContext("p1", "mark all as read", {
      knowledgeService: { search: vi.fn(async () => ({ hits: [] })) },
      fusedCode: {
        searcher: {
          search: vi.fn(async () => [
            {
              symbolId: "s-mark",
              filePath: ENTRY,
              name: "MarkAllAsRead",
              kind: "function",
              score: 1,
              repoConnectionId: "rc-1",
            },
          ]),
        },
        lineLookup: {
          resolve: vi.fn(
            async () => new Map([["s-mark", { filePath: ENTRY, startLine: 506, endLine: 520 }]]),
          ),
        },
        // No hiddenSymbols: the default, built on the build's own load.
      },
      includeCode: true,
      callers: {
        lookup: {
          findCallers: vi.fn(async () => [
            {
              toSymbolId: "s-mark",
              toQualifiedName: null,
              filePath: CALLER,
              line: 17,
              callerName: "caller",
              repoConnectionId: "rc-1",
            },
          ]),
        },
      },
    });
    expect(loadSharedCodeAccess).toHaveBeenCalledTimes(1);
    expect(loadSharedCodeAccess).toHaveBeenCalledWith("p1");
    expect(res.context).toContain(`at ${CALLER}:17`);
  });
});
