/**
 * Unit tests for the schema-drift startup guard (#379, #380).
 */
import { existsSync } from "node:fs";
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
      resolvePrismaCli: () => "/tmp/server/node_modules/prisma/build/index.js",
    });
    expect(out.status).toBe("applied");
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = (spawn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [string, string[], { cwd: string }];
    // #39 — the running node executes the Prisma CLI directly. The production image
    // ships no pnpm (or npm/npx), so `pnpm exec prisma` failed with ENOENT and the
    // server refused to start.
    expect(cmd).toBe(process.execPath);
    expect(args).toEqual(["/tmp/server/node_modules/prisma/build/index.js", "migrate", "deploy"]);
    expect(opts.cwd).toBe("/tmp/server");
  });

  it("resolves the real Prisma CLI entry point by default", async () => {
    const spawn = fakeSpawn({ status: 0 });
    await ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv });
    const [, args] = (spawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      string,
      string[],
    ];
    expect(args[0]).toMatch(/[\\/]prisma[\\/]build[\\/]index\.js$/);
    expect(existsSync(args[0])).toBe(true);
  });

  it("throws a fail-loud error when the Prisma CLI is not installed", async () => {
    const spawn = fakeSpawn({ status: 0 });
    await expect(
      ensureSchemaUpToDate({
        spawn,
        env: {} as NodeJS.ProcessEnv,
        resolvePrismaCli: () => {
          throw new Error("Cannot find module 'prisma/build/index.js'");
        },
      }),
    ).rejects.toThrow(/Prisma CLI is not installed.*Cannot find module/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("throws when prisma migrate deploy exits non-zero (fail-loud)", async () => {
    const spawn = fakeSpawn({ status: 1, stderr: "P3009 schema drift detected" });
    await expect(ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /exited 1/,
    );
  });

  it("throws when the spawn itself errors (e.g. ENOENT)", async () => {
    const spawn = fakeSpawn({ error: new Error("ENOENT: node not found") });
    await expect(ensureSchemaUpToDate({ spawn, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /failed to spawn/,
    );
  });

  it("does not spawn through a shell on Windows either", async () => {
    // #39 — the command is `node <cli.js>`, not the `pnpm.cmd` shim that once
    // needed a shell to resolve, so no platform gets one.
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
      expect(opts.shell).toBe(false);
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
