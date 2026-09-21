/**
 * Unit tests for the schema-drift startup guard (#379, #380).
 */
import { describe, expect, it, vi } from "vitest";
import { ensureSchemaUpToDate } from "../src/lib/db/migration-guard.js";

function fakeSpawn(result: {
  status?: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}) {
  return vi.fn(() => ({
    pid: 1,
    output: [],
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 0,
    signal: null,
    ...(result.error ? { error: result.error } : {}),
  })) as unknown as typeof import("node:child_process").spawnSync;
}

describe("ensureSchemaUpToDate", () => {
  it("returns 'skipped' when METIS_SKIP_MIGRATE=1 is set", async () => {
    const spawn = fakeSpawn({ status: 0 });
    const out = await ensureSchemaUpToDate({
      spawn,
      env: { METIS_SKIP_MIGRATE: "1" } as NodeJS.ProcessEnv,
    });
    expect(out.status).toBe("skipped");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns 'applied' when prisma migrate deploy exits 0", async () => {
    const spawn = fakeSpawn({ status: 0, stdout: "No pending migrations to apply." });
    const out = await ensureSchemaUpToDate({
      spawn,
      env: {} as NodeJS.ProcessEnv,
      cwd: "/tmp/server",
    });
    expect(out.status).toBe("applied");
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = (spawn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string[], { cwd: string }];
    expect(cmd).toBe("pnpm");
    expect(args).toEqual(["exec", "prisma", "migrate", "deploy"]);
    expect(opts.cwd).toBe("/tmp/server");
  });

  it("throws when prisma migrate deploy exits non-zero (fail-loud)", async () => {
    const spawn = fakeSpawn({ status: 1, stderr: "P3009 schema drift detected" });
    await expect(ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /exited 1/,
    );
  });

  it("throws when the spawn itself errors (e.g. ENOENT)", async () => {
    const spawn = fakeSpawn({ error: new Error("ENOENT: pnpm not found") });
    await expect(ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /failed to spawn/,
    );
  });

  it("spawns through a shell on Windows so the pnpm.cmd shim resolves", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const spawn = fakeSpawn({ status: 0 });
      await ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv });
      const [, , opts] = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
        string,
        string[],
        { shell?: boolean },
      ];
      expect(opts.shell).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });

  it("does not spawn through a shell on POSIX", async () => {
    const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const spawn = fakeSpawn({ status: 0 });
      await ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv });
      const [, , opts] = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
        string,
        string[],
        { shell?: boolean },
      ];
      expect(opts.shell).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", orig);
    }
  });
});
