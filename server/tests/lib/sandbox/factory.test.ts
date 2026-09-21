/**
 * Tests for the SandboxProvider factory (Epic #395 #409).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetSandboxProviderSingleton,
  buildSandboxProvider,
  getSandboxProvider,
} from "../../../src/lib/sandbox/factory.js";
import { NoopSandboxProvider } from "../../../src/lib/sandbox/noop/noop-provider.js";
import { E2BSandboxProvider } from "../../../src/lib/sandbox/e2b/e2b-provider.js";
import { DaytonaSandboxProvider } from "../../../src/lib/sandbox/daytona/daytona-provider.js";
import {
  LocalDevSandboxProvider,
  LocalDevSandboxUnavailableError,
} from "../../../src/lib/sandbox/local-dev/local-dev-provider.js";

const ORIGINAL_KIND = process.env.SANDBOX_PROVIDER;

afterEach(() => {
  if (ORIGINAL_KIND === undefined) delete process.env.SANDBOX_PROVIDER;
  else process.env.SANDBOX_PROVIDER = ORIGINAL_KIND;
  __resetSandboxProviderSingleton();
});

describe("sandbox factory", () => {
  beforeEach(() => {
    delete process.env.SANDBOX_PROVIDER;
    __resetSandboxProviderSingleton();
  });

  it("returns NoopSandboxProvider when SANDBOX_PROVIDER is unset (offline-dev default)", () => {
    const p = getSandboxProvider();
    expect(p).toBeInstanceOf(NoopSandboxProvider);
    expect(p.kind).toBe("noop");
  });

  it("returns NoopSandboxProvider when SANDBOX_PROVIDER=noop", () => {
    process.env.SANDBOX_PROVIDER = "noop";
    expect(buildSandboxProvider()).toBeInstanceOf(NoopSandboxProvider);
  });

  it("returns LocalDevSandboxProvider when SANDBOX_PROVIDER=local_dev (or throws if tooling missing)", () => {
    process.env.SANDBOX_PROVIDER = "local_dev";
    try {
      const p = buildSandboxProvider();
      expect(p).toBeInstanceOf(LocalDevSandboxProvider);
      expect(p.kind).toBe("local_dev");
    } catch (err) {
      // CI runners without bwrap/sandbox-exec — accept the structured error.
      expect(err).toBeInstanceOf(LocalDevSandboxUnavailableError);
    }
  });

  it("returns E2BSandboxProvider when SANDBOX_PROVIDER=e2b", () => {
    process.env.SANDBOX_PROVIDER = "e2b";
    expect(buildSandboxProvider()).toBeInstanceOf(E2BSandboxProvider);
  });

  it("returns DaytonaSandboxProvider when SANDBOX_PROVIDER=daytona", () => {
    process.env.SANDBOX_PROVIDER = "daytona";
    expect(buildSandboxProvider()).toBeInstanceOf(DaytonaSandboxProvider);
  });

  it("throws on unknown SANDBOX_PROVIDER value", () => {
    process.env.SANDBOX_PROVIDER = "not-a-real-thing";
    expect(() => buildSandboxProvider()).toThrow(/not a valid kind/i);
  });

  it("throws structured error for self_hosted (not yet implemented)", () => {
    expect(() => buildSandboxProvider("self_hosted")).toThrow(/not yet implemented/);
  });

  it("memoizes across calls (singleton)", () => {
    const a = getSandboxProvider();
    const b = getSandboxProvider();
    expect(a).toBe(b);
  });

  it("inject override bypasses singleton + factory", () => {
    const stub = new NoopSandboxProvider();
    expect(getSandboxProvider({ provider: stub })).toBe(stub);
  });

  it("kind override builds without consulting env", () => {
    process.env.SANDBOX_PROVIDER = "e2b";
    const p = getSandboxProvider({ kind: "noop" });
    expect(p).toBeInstanceOf(NoopSandboxProvider);
  });
});
