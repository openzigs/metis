import { beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), confirm: vi.fn(), disconnect: vi.fn() }));
vi.mock("../prisma.js", () => ({ prisma: { $disconnect: mocks.disconnect } }));
vi.mock("./role-reconciliation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./role-reconciliation.js")>()),
  inspectRoleState: mocks.inspect,
  confirmRoleState: mocks.confirm,
}));

// Keep the host wrapper AND the schemas real: CLI parsing must not bypass the
// operator validation or the exact confirmation phrase at the host boundary.
import { runRoleReconciliationCli } from "./role-reconciliation-cli.js";

const target = { targetId: "target-1", username: "alice" };
const actor = { kind: "host-operator", name: "Recovery operator" };
const input = {
  ...target,
  expectedFingerprint: "a".repeat(64),
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  decision: "provider-managed",
  reason: "Verified account ownership offline",
};
const common = [
  "--operator",
  actor.name,
  "--acknowledge-host-authority",
  "--target-id",
  target.targetId,
  "--username",
  target.username,
];
const confirmation = `${target.targetId}:${target.username}:${input.decision}`;
const confirmFlags = [
  "--expected-fingerprint",
  input.expectedFingerprint,
  "--request-id",
  input.requestId,
  "--decision",
  input.decision,
  "--reason",
  input.reason,
  "--confirm",
  confirmation,
];

function replaceFlag(args: string[], flag: string, value: string) {
  const result = [...args];
  const index = result.indexOf(flag);
  if (index < 0) throw new Error(`Fixture is missing ${flag}`);
  result[index + 1] = value;
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue({
    state: { id: target.targetId },
    fingerprint: input.expectedFingerprint,
  });
  mocks.confirm.mockResolvedValue({ requestId: input.requestId, replayed: false });
});

function expectNoDispatch() {
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.confirm).not.toHaveBeenCalled();
}

describe("runRoleReconciliationCli", () => {
  it("inspects using the acknowledged host identity and returns the service result", async () => {
    const result = await runRoleReconciliationCli(["inspect", ...common]);
    expect(result).toEqual({
      state: { id: target.targetId },
      fingerprint: input.expectedFingerprint,
    });
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(actor, target);
    expect(mocks.confirm).not.toHaveBeenCalled();
    // Importing/calling the reusable runner must not run the standalone main.
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it("accepts equals-form flags and normalizes identities through the real schemas", async () => {
    await runRoleReconciliationCli([
      "--operator= Recovery operator ",
      "--username= alice ",
      "inspect",
      "--target-id= target-1 ",
      "--acknowledge-host-authority",
    ]);
    expect(mocks.inspect).toHaveBeenCalledExactlyOnceWith(actor, target);
  });

  it.each(["provider-managed", "keep-explicit", "revoked"])(
    "confirms the %s decision with every validated field",
    async (decision) => {
      let flags = replaceFlag(confirmFlags, "--decision", decision);
      flags = replaceFlag(flags, "--confirm", `${target.targetId}:${target.username}:${decision}`);
      const result = await runRoleReconciliationCli(["confirm", ...common, ...flags]);
      expect(result).toEqual({ requestId: input.requestId, replayed: false });
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(actor, { ...input, decision });
      expect(mocks.inspect).not.toHaveBeenCalled();
      expect(mocks.disconnect).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      [],
      ["inspect"],
      ["delete", ...common],
      ["inspect", "confirm", ...common],
      common,
      ["inspect", ...common.filter((value) => value !== "--acknowledge-host-authority")],
      ["inspect", ...common.slice(2)],
      ["inspect", ...replaceFlag(common, "--operator", "")],
    ].map((args) => ({ args })),
  )(
    "requires a single supported command and explicit operator acknowledgment: $args",
    async ({ args }) => {
      await expect(runRoleReconciliationCli(args)).rejects.toThrow(/Usage: inspect\|confirm/);
      expectNoDispatch();
    },
  );

  it.each(
    [
      ["--unknown-option", "anything"],
      ["--acknowledge-host-authority=false"],
      ["--target-id"],
      ["--confirm"],
    ].map((extra) => ({ extra })),
  )(
    "rejects unknown flags, invalid boolean values and missing flag values: $extra",
    async ({ extra }) => {
      await expect(runRoleReconciliationCli(["inspect", ...common, ...extra])).rejects.toThrow();
      expectNoDispatch();
    },
  );

  it.each(["--target-id", "--username"])("requires %s even for inspect", async (flag) => {
    const args = [...common];
    args.splice(args.indexOf(flag), 2);
    await expect(runRoleReconciliationCli(["inspect", ...args])).rejects.toThrow();
    expectNoDispatch();
  });

  it.each([
    ["--operator", "  "],
    ["--operator", "ab"],
    ["--operator", "o".repeat(201)],
    ["--target-id", " "],
    ["--target-id", "t".repeat(201)],
    ["--username", " "],
    ["--username", "u".repeat(201)],
  ])("rejects invalid %s before inspecting (%s)", async (flag, value) => {
    await expect(
      runRoleReconciliationCli(["inspect", ...replaceFlag(common, flag, value)]),
    ).rejects.toThrow();
    expectNoDispatch();
  });

  it.each(["--expected-fingerprint", "--request-id", "--decision", "--reason"])(
    "requires confirmation flag %s",
    async (flag) => {
      const flags = [...confirmFlags];
      flags.splice(flags.indexOf(flag), 2);
      await expect(runRoleReconciliationCli(["confirm", ...common, ...flags])).rejects.toThrow();
      expectNoDispatch();
    },
  );

  it.each([
    ["--expected-fingerprint", "a".repeat(63)],
    ["--expected-fingerprint", "A".repeat(64)],
    ["--expected-fingerprint", "g".repeat(64)],
    ["--request-id", "not-a-uuid"],
    ["--decision", "admin"],
    ["--reason", "too short"],
    ["--reason", "r".repeat(1001)],
  ])("rejects invalid confirmation field %s (%s)", async (flag, value) => {
    await expect(
      runRoleReconciliationCli(["confirm", ...common, ...replaceFlag(confirmFlags, flag, value)]),
    ).rejects.toThrow();
    expectNoDispatch();
  });

  it.each([
    "",
    "target-2:alice:provider-managed",
    "target-1:bob:provider-managed",
    "target-1:alice:revoked",
    `${confirmation} `,
  ])("refuses a nonmatching confirmation phrase %j", async (phrase) => {
    await expect(
      runRoleReconciliationCli([
        "confirm",
        ...common,
        ...replaceFlag(confirmFlags, "--confirm", phrase),
      ]),
    ).rejects.toThrow("Confirmation must exactly match targetId:username:decision");
    expectNoDispatch();
  });

  it("does not implicitly approve when --confirm is missing", async () => {
    await expect(
      runRoleReconciliationCli(["confirm", ...common, ...confirmFlags.slice(0, -2)]),
    ).rejects.toThrow("Confirmation must exactly match targetId:username:decision");
    expectNoDispatch();
  });

  it.each(["inspect", "confirm"])(
    "propagates %s service failures without hiding or retrying them",
    async (command) => {
      const failure = new Error("database unavailable");
      const service = command === "inspect" ? mocks.inspect : mocks.confirm;
      service.mockRejectedValueOnce(failure);
      await expect(
        runRoleReconciliationCli([
          command,
          ...common,
          ...(command === "confirm" ? confirmFlags : []),
        ]),
      ).rejects.toBe(failure);
      expect(service).toHaveBeenCalledOnce();
      expect(mocks.disconnect).not.toHaveBeenCalled();
    },
  );
});

describe("standalone role reconciliation CLI", () => {
  it.each([
    { command: "inspect", failure: undefined },
    { command: "confirm", failure: undefined },
    { command: "inspect", failure: new Error("database unavailable") },
    { command: "confirm", failure: "unstructured database failure" },
  ])(
    "prints the result or error and disconnects: $command / $failure",
    async ({ command, failure }) => {
      const originalArgv = process.argv;
      const originalExitCode = process.exitCode;
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        process.argv = [
          process.execPath,
          fileURLToPath(new URL("./role-reconciliation-cli.ts", import.meta.url)),
          command,
          ...common,
          ...(command === "confirm" ? confirmFlags : []),
        ];
        process.exitCode = 0;
        const service = command === "inspect" ? mocks.inspect : mocks.confirm;
        if (failure !== undefined) service.mockRejectedValueOnce(failure);

        vi.resetModules();
        await import("./role-reconciliation-cli.js");

        expect(service).toHaveBeenCalledExactlyOnceWith(
          actor,
          command === "inspect" ? target : input,
        );
        expect(mocks.disconnect).toHaveBeenCalledOnce();
        expect(service.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.disconnect.mock.invocationCallOrder[0],
        );
        if (failure === undefined) {
          const result =
            command === "inspect"
              ? { state: { id: target.targetId }, fingerprint: input.expectedFingerprint }
              : { requestId: input.requestId, replayed: false };
          expect(stdout).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify(result, null, 2)}\n`);
          expect(stderr).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(0);
        } else {
          expect(stderr).toHaveBeenCalledExactlyOnceWith(
            failure instanceof Error ? `${failure.message}\n` : "Reconciliation failed\n",
          );
          expect(stdout).not.toHaveBeenCalled();
          expect(process.exitCode).toBe(1);
        }
      } finally {
        process.argv = originalArgv;
        process.exitCode = originalExitCode;
        stdout.mockRestore();
        stderr.mockRestore();
        vi.resetModules();
      }
    },
  );
});
