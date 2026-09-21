/**
 * Sandbox provider factory (Epic #395 #409).
 *
 * Reads `SANDBOX_PROVIDER` from the environment and returns the matching
 * adapter. `noop` is the default for offline dev / CI so call sites are
 * exercised without requiring an `E2B_API_KEY`. `daytona` is reserved
 * for a follow-up MVP — currently throws a structured error.
 */
import type { SandboxProvider, SandboxProviderKind } from "./types.js";
import { NoopSandboxProvider } from "./noop/noop-provider.js";
import { E2BSandboxProvider } from "./e2b/e2b-provider.js";
import { DaytonaSandboxProvider } from "./daytona/daytona-provider.js";
import { LocalDevSandboxProvider } from "./local-dev/local-dev-provider.js";

const VALID_KINDS: readonly SandboxProviderKind[] = [
  "noop",
  "e2b",
  "daytona",
  "local_dev",
  "self_hosted",
];

function readKindFromEnv(): SandboxProviderKind {
  const raw = (process.env.SANDBOX_PROVIDER ?? "").trim().toLowerCase();
  if (!raw) return "noop";
  if (VALID_KINDS.includes(raw as SandboxProviderKind)) {
    return raw as SandboxProviderKind;
  }
  throw new Error(
    `SANDBOX_PROVIDER='${raw}' is not a valid kind. Expected one of: ${VALID_KINDS.join(", ")}.`,
  );
}

export interface ResolveSandboxProviderOptions {
  /** Override the env-derived kind (tests). */
  kind?: SandboxProviderKind;
  /** Inject a pre-built provider for the resolved kind (tests). */
  provider?: SandboxProvider;
}

let singleton: SandboxProvider | null = null;

/** Build a provider for the given kind without caching. */
export function buildSandboxProvider(
  kind: SandboxProviderKind = readKindFromEnv(),
): SandboxProvider {
  switch (kind) {
    case "noop":
      return new NoopSandboxProvider();
    case "local_dev":
      return new LocalDevSandboxProvider();
    case "e2b":
      return new E2BSandboxProvider();
    case "daytona":
      return new DaytonaSandboxProvider();
    case "self_hosted":
      throw new Error(
        "SANDBOX_PROVIDER='self_hosted' adapter not yet implemented (tracked under epic #395 P3)",
      );
    default: {
      // Exhaustive check — a new kind in the union forces the compiler
      // here so we never silently fall through.
      const _exhaustive: never = kind;
      throw new Error(`unhandled SANDBOX_PROVIDER kind: ${String(_exhaustive)}`);
    }
  }
}

/** Return a process-singleton sandbox provider. */
export function getSandboxProvider(opts: ResolveSandboxProviderOptions = {}): SandboxProvider {
  if (opts.provider) return opts.provider;
  if (opts.kind) return buildSandboxProvider(opts.kind);
  if (!singleton) singleton = buildSandboxProvider();
  return singleton;
}

/** Test helper. */
export function __resetSandboxProviderSingleton(): void {
  singleton = null;
}
