import { describe, it, expect, vi } from "vitest";
import {
  REQUIRED_BINARIES,
  OPTIONAL_BINARIES,
  WRAPPERS,
  commandExists,
  wrapperTags,
  checkPrereqs,
} from "./bootstrap-prereqs.mjs";

describe("constants", () => {
  it("requires docker/node/pnpm and NOT openssl (Node crypto replaces it)", () => {
    expect(REQUIRED_BINARIES).toEqual(["docker", "node", "pnpm"]);
    expect(REQUIRED_BINARIES).not.toContain("openssl");
  });
  it("treats uv/graphify as optional", () => {
    expect(OPTIONAL_BINARIES).toContain("uv");
    expect(OPTIONAL_BINARIES).toContain("graphify");
  });
  it("lists all nine MCP wrappers", () => {
    expect(WRAPPERS).toHaveLength(9);
  });
});

describe("commandExists", () => {
  it("is true when the probe succeeds", () => {
    const run = vi.fn();
    expect(commandExists("docker", { run })).toBe(true);
    expect(run).toHaveBeenCalledWith("docker", ["--version"]);
  });
  it("is false when the probe throws (ENOENT)", () => {
    const run = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(commandExists("nope", { run })).toBe(false);
  });
});

describe("wrapperTags", () => {
  it("builds fully-qualified tags and trims the version", () => {
    const tags = wrapperTags("ghcr.io/metis-mcps", "  1.2.3\n");
    expect(tags).toHaveLength(WRAPPERS.length);
    expect(tags[0]).toBe("ghcr.io/metis-mcps/uvx-runner:1.2.3");
    expect(tags.every((t) => t.endsWith(":1.2.3"))).toBe(true);
  });
});

describe("checkPrereqs", () => {
  it("is ok when all required binaries exist", () => {
    const r = checkPrereqs({ exists: () => true });
    expect(r.ok).toBe(true);
    expect(r.missingRequired).toEqual([]);
    expect(r.missingOptional).toEqual([]);
  });

  it("reports missing required binaries", () => {
    const present = new Set(["node"]);
    const r = checkPrereqs({ exists: (b: string) => present.has(b) });
    expect(r.ok).toBe(false);
    expect(r.missingRequired).toEqual(["docker", "pnpm"]);
    expect(r.missingOptional).toEqual([...OPTIONAL_BINARIES]);
  });

  it("ok with only optional binaries missing", () => {
    const present = new Set(["docker", "node", "pnpm"]);
    const r = checkPrereqs({ exists: (b: string) => present.has(b) });
    expect(r.ok).toBe(true);
    expect(r.missingOptional).toEqual([...OPTIONAL_BINARIES]);
  });
});
