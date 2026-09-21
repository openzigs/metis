import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ inspect: vi.fn(), confirm: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: {} }));
vi.mock("./role-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./role-reconciliation.js")>()),
  inspectRoleState: service.inspect,
  confirmRoleState: service.confirm,
}));

import { confirmRolesForHost, inspectRolesForHost } from "./role-reconciliation-host.js";
import type { ReconciliationInput } from "./role-reconciliation.js";

const target = { targetId: "target-1", username: "alice" };
const input: ReconciliationInput = {
  ...target,
  expectedFingerprint: "a".repeat(64),
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  decision: "provider-managed",
  reason: "Verified host recovery authorization",
};
const confirmation = "target-1:alice:provider-managed";

beforeEach(() => {
  vi.resetAllMocks();
  service.inspect.mockResolvedValue({ fingerprint: input.expectedFingerprint });
  service.confirm.mockResolvedValue({ requestId: input.requestId, replayed: false });
});

function expectNoDispatch() {
  expect(service.inspect).not.toHaveBeenCalled();
  expect(service.confirm).not.toHaveBeenCalled();
}

describe("host role reconciliation boundary", () => {
  it("normalizes a named operator and target before trusted inspection", async () => {
    const result = await inspectRolesForHost("  Recovery operator  ", {
      targetId: " target-1 ",
      username: " alice ",
    });
    expect(result).toEqual({ fingerprint: input.expectedFingerprint });
    expect(service.inspect).toHaveBeenCalledExactlyOnceWith(
      { kind: "host-operator", name: "Recovery operator" },
      target,
    );
    expect(service.confirm).not.toHaveBeenCalled();
  });

  it.each(["provider-managed", "keep-explicit", "revoked"] as const)(
    "confirms %s only after normalization and exact consent",
    async (decision) => {
      const result = await confirmRolesForHost(
        " operator ",
        {
          ...input,
          targetId: " target-1 ",
          username: " alice ",
          decision,
          reason: ` ${input.reason} `,
        },
        `target-1:alice:${decision}`,
      );
      expect(result).toEqual({ requestId: input.requestId, replayed: false });
      expect(service.confirm).toHaveBeenCalledExactlyOnceWith(
        { kind: "host-operator", name: "operator" },
        { ...input, decision },
      );
      expect(service.inspect).not.toHaveBeenCalled();
    },
  );

  it.each(["", "  ", "ab", "o".repeat(201)])(
    "rejects invalid operator %j for both operations",
    (operator) => {
      expect(() => inspectRolesForHost(operator, target)).toThrow();
      expect(() => confirmRolesForHost(operator, input, confirmation)).toThrow();
      expectNoDispatch();
    },
  );

  it.each(["abc", "o".repeat(200)])(
    "accepts an operator of valid boundary length (%s)",
    async (operator) => {
      await inspectRolesForHost(operator, target);
      expect(service.inspect).toHaveBeenCalledExactlyOnceWith(
        { kind: "host-operator", name: operator },
        target,
      );
    },
  );

  it.each([
    { targetId: "", username: "alice" },
    { targetId: "target-1", username: " " },
    { targetId: "t".repeat(201), username: "alice" },
    { targetId: "target-1", username: "u".repeat(201) },
    { ...target, actor: { kind: "admin", id: "someone" } },
  ])("rejects invalid or injected inspect fields %j", (invalid) => {
    expect(() => inspectRolesForHost("operator", invalid)).toThrow();
    expectNoDispatch();
  });

  it.each([
    { expectedFingerprint: "a".repeat(63) },
    { expectedFingerprint: "A".repeat(64) },
    { expectedFingerprint: "g".repeat(64) },
    { requestId: "invalid" },
    { reason: "short" },
    { reason: "r".repeat(1001) },
    { username: " " },
    { decision: "administrator" },
    { actor: { kind: "host-operator", name: "injected" } },
  ])("rejects malformed or injected confirmation fields %j", (patch) => {
    expect(() =>
      confirmRolesForHost("operator", { ...input, ...patch } as ReconciliationInput, confirmation),
    ).toThrow();
    expectNoDispatch();
  });

  it.each([
    "",
    "target-2:alice:provider-managed",
    "target-1:bob:provider-managed",
    "target-1:alice:revoked",
    "target-1:alice:PROVIDER-MANAGED",
    ` ${confirmation}`,
    `${confirmation} `,
  ])("rejects non-exact consent %j without dispatch", (phrase) => {
    expect(() => confirmRolesForHost("operator", input, phrase)).toThrow(
      "Confirmation must exactly match targetId:username:decision",
    );
    expectNoDispatch();
  });

  it("accepts minimum and maximum trimmed reason lengths", async () => {
    for (const reason of ["r".repeat(10), "r".repeat(1000)]) {
      await confirmRolesForHost("operator", { ...input, reason: ` ${reason} ` }, confirmation);
      expect(service.confirm).toHaveBeenLastCalledWith(
        { kind: "host-operator", name: "operator" },
        { ...input, reason },
      );
    }
  });

  it("passes service failures back without turning them into successful recovery", async () => {
    const failure = new Error("serialization conflict");
    service.inspect.mockRejectedValueOnce(failure);
    service.confirm.mockRejectedValueOnce(failure);
    await expect(inspectRolesForHost("operator", target)).rejects.toBe(failure);
    await expect(confirmRolesForHost("operator", input, confirmation)).rejects.toBe(failure);
    expect(service.inspect).toHaveBeenCalledOnce();
    expect(service.confirm).toHaveBeenCalledOnce();
  });
});
