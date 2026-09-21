/**
 * Tests for the bwrap argv builder (Epic #395 #417).
 */
import { describe, expect, it } from "vitest";
import { buildBwrapArgv } from "../../../../../src/lib/sandbox/local-dev/profiles/linux-bwrap.js";

describe("buildBwrapArgv", () => {
  it("emits the unshare-all + die-with-parent + ro-bind / / + tmpfs /tmp flags", () => {
    const { bin, args } = buildBwrapArgv({ cwd: "/tmp/sandbox", command: "echo hi" });
    expect(bin).toBe("bwrap");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--die-with-parent");
    // ro-bind / / appears as three consecutive args.
    const idx = args.indexOf("--ro-bind");
    expect(args[idx + 1]).toBe("/");
    expect(args[idx + 2]).toBe("/");
    const tmpfsIdx = args.indexOf("--tmpfs");
    expect(args[tmpfsIdx + 1]).toBe("/tmp");
  });

  it("binds the cwd read-write so writes inside the sandbox land on disk", () => {
    const { args } = buildBwrapArgv({ cwd: "/tmp/sb-1", command: "true" });
    const bindIdx = args.indexOf("--bind");
    expect(args[bindIdx + 1]).toBe("/tmp/sb-1");
    expect(args[bindIdx + 2]).toBe("/tmp/sb-1");
  });

  it("appends `/bin/sh -c <command>` as the final argv segment", () => {
    const { args } = buildBwrapArgv({ cwd: "/tmp/sb-1", command: "echo $X" });
    expect(args.slice(-3)).toEqual(["/bin/sh", "-c", "echo $X"]);
  });

  it("includes optional read-only binds when supplied", () => {
    const { args } = buildBwrapArgv({
      cwd: "/tmp/sb-1",
      command: "true",
      extraReadOnlyBinds: [["/host/data", "/data"]],
    });
    // ro-bind appears at least twice: once for / / and once for the extra.
    const indices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--ro-bind") acc.push(i);
      return acc;
    }, []);
    expect(indices.length).toBeGreaterThanOrEqual(2);
    const extraIdx = indices[indices.length - 1];
    expect(args[extraIdx + 1]).toBe("/host/data");
    expect(args[extraIdx + 2]).toBe("/data");
  });

  it("changes directory to the cwd inside the sandbox", () => {
    const { args } = buildBwrapArgv({ cwd: "/tmp/sb-1", command: "pwd" });
    const chdirIdx = args.indexOf("--chdir");
    expect(args[chdirIdx + 1]).toBe("/tmp/sb-1");
  });
});
