/**
 * #2222 — the wording **Re-check this requirement** checks. The route, the
 * scoping and the store are exercised end to end in
 * `tests/governing-recheck-2222.sqlite.test.ts`. #2281 — a re-check whose
 * signal aborts stores nothing and reports itself cancelled, not failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../ai/types.js";

const deps = vi.hoisted(() => ({
  findFirst: vi.fn(),
  auditCreate: vi.fn(),
  decide: vi.fn(),
  produce: vi.fn(),
  upsert: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    requirement: { findFirst: deps.findFirst },
    auditLog: { create: deps.auditCreate },
  },
}));
vi.mock("./applicability.js", () => ({
  governingApplicabilityHookFor: async () => ({ decide: deps.decide }),
}));
vi.mock("./findings-store.js", () => ({ produceGoverningFindingsForAnalysis: deps.produce }));
vi.mock("./applicability-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./applicability-store.js")>()),
  upsertGoverningRequirementApplicability: deps.upsert,
}));

const { recheckGoverningRequirement, requirementWording } = await import("./recheck.js");

describe("requirementWording", () => {
  it("is the title, the body and the acceptance criteria, as one text", () => {
    expect(
      requirementWording({
        title: "Minimum password length",
        body: " Passwords are at least 15 characters, or 8 with MFA. ",
        acceptanceCriteria: JSON.stringify([
          "A 14-character password is refused.",
          "MFA allows 8.",
        ]),
      }),
    ).toBe(
      "Minimum password length\n\nPasswords are at least 15 characters, or 8 with MFA.\n\nAcceptance criteria:\n- A 14-character password is refused.\n- MFA allows 8.",
    );
  });

  it("leaves out an empty body and absent criteria", () => {
    expect(requirementWording({ title: "Title", body: "  ", acceptanceCriteria: null })).toBe(
      "Title",
    );
    expect(requirementWording({ title: "Title", body: "Body", acceptanceCriteria: "[]" })).toBe(
      "Title\n\nBody",
    );
  });
});

describe("recheckGoverningRequirement — cancelled (#2281)", () => {
  const set = (error?: string) => ({
    requirementId: "r1",
    decisions: [],
    rulesScreened: 1,
    screenBatches: 1,
    candidates: 0,
    reasked: 0,
    screenReasked: 0,
    ...(error ? { error } : {}),
  });
  const input = (signal: AbortSignal) => ({
    analysisId: "ana-1",
    projectId: "p-1",
    requirementId: "r1",
    provider: {} as AIProvider,
    actorId: "u-1",
    signal,
  });

  beforeEach(() => {
    for (const fn of Object.values(deps)) fn.mockReset();
    deps.findFirst.mockResolvedValue({
      id: "r1",
      title: "T",
      body: "B",
      acceptanceCriteria: null,
      version: 2,
    });
  });

  it("a signal that aborts while applicability is decided: cancelled, no findings run, nothing stored", async () => {
    const ac = new AbortController();
    deps.decide.mockImplementation(async () => {
      ac.abort();
      return set("The request was aborted.");
    });
    expect(await recheckGoverningRequirement(input(ac.signal))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(deps.produce).not.toHaveBeenCalled();
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.auditCreate).not.toHaveBeenCalled();
  });

  it("#2311 — a signal that aborts during the requirement read: cancelled, no model call", async () => {
    const ac = new AbortController();
    deps.findFirst.mockImplementation(async () => {
      ac.abort();
      return { id: "r1", title: "T", body: "B", acceptanceCriteria: null, version: 2 };
    });
    expect(await recheckGoverningRequirement(input(ac.signal))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(deps.decide).not.toHaveBeenCalled();
    expect(deps.produce).not.toHaveBeenCalled();
  });

  it("a findings run that rejects on the abort: cancelled, nothing stored; any other rejection is thrown", async () => {
    const ac = new AbortController();
    deps.decide.mockResolvedValue(set());
    deps.produce.mockImplementation(async () => {
      ac.abort();
      throw new Error("aborted");
    });
    expect(await recheckGoverningRequirement(input(ac.signal))).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(deps.upsert).not.toHaveBeenCalled();

    deps.produce.mockRejectedValue(new Error("database is gone"));
    await expect(recheckGoverningRequirement(input(new AbortController().signal))).rejects.toThrow(
      "database is gone",
    );
    expect(deps.upsert).not.toHaveBeenCalled();
  });
});
