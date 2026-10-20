/**
 * #1251 — a failed `job_scopes` read refuses a `subscribe:job` join (the job
 * is then unknown), but a re-judgement of a socket already in the room asks
 * for the error instead (`onStoreError: "throw"`), so a database blip is not
 * read as a revocation and the sweep can keep the room.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthPayload } from "@metis/shared";

const none = vi.hoisted(() => vi.fn(async () => null));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: { findFirst: none },
    generatedDocument: { findFirst: none },
    importRun: { findFirst: none },
    impactAnalysis: { findFirst: none },
  },
}));
const readJobScope = vi.hoisted(() => vi.fn());
vi.mock("./job-scope-store.js", () => ({ readJobScope }));

import { resolveJobRoomScope } from "./room-access.js";
import { _resetJobLifecycleMemory } from "./job-events.js";

const admin = { userId: "root", role: "admin" } as AuthPayload;

beforeEach(() => {
  readJobScope.mockReset();
  _resetJobLifecycleMemory();
});

describe("resolveJobRoomScope — a failed job_scopes read", () => {
  it("refuses the join by default", async () => {
    readJobScope.mockRejectedValue(new Error("db down"));
    await expect(resolveJobRoomScope(admin, "row-less-job")).resolves.toBeNull();
  });

  it("rethrows for a re-judgement", async () => {
    readJobScope.mockRejectedValue(new Error("db down"));
    await expect(
      resolveJobRoomScope(admin, "row-less-job", { onStoreError: "throw" }),
    ).rejects.toThrow("db down");
  });

  it("still answers a recorded scope either way", async () => {
    readJobScope.mockResolvedValue({ kind: "pr-review", projectId: null });
    await expect(
      resolveJobRoomScope(admin, "row-less-job", { onStoreError: "throw" }),
    ).resolves.toEqual({ kind: "pr-review", projectId: null });
  });
});
