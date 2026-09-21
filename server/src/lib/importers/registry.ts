/**
 * Importer factory — issue #777.
 *
 * Builds the right {@link Importer} for a source given resolved credentials,
 * wiring the SSRF host guard and an injectable `fetch`/backoff for testing.
 */
import type { ImportSourceKind } from "@metis/shared";
import {
  resolveAndAssertConnectorHost,
  makePinnedLookup,
} from "../connectors/network-allowlist.js";
import { GithubImporter } from "./github-importer.js";
import { AzureDevopsImporter } from "./azure-devops-importer.js";
import { LinearImporter } from "./linear-importer.js";
import { JiraImporter, type JiraSearchClient } from "./jira-importer.js";
import type { AssertHostAllowed, BackoffTuning, FetchFn, Importer } from "./types.js";

export type ResolvedCredentials =
  | {
      source: "github" | "azure-devops" | "linear";
      token: string;
      baseUrl?: string | null;
    }
  | {
      source: "jira";
      client: JiraSearchClient;
      baseUrl: string;
      customFieldMap?: Record<string, string>;
    };

export interface ImporterDeps {
  fetchFn?: FetchFn;
  /** Override the SSRF guard (tests pass a no-op). */
  assertHostAllowed?: AssertHostAllowed;
  /**
   * Override the DNS-pinning factory (tests omit this; production registry
   * wires it to `resolveAndAssertConnectorHost` + undici Agent). When set,
   * takes priority over `assertHostAllowed`.
   */
  pinnedDispatcherFor?: (hostname: string) => Promise<unknown>;
  backoff?: BackoffTuning;
}

/**
 * Build a `pinnedDispatcherFor` factory for the given connector kind.
 * Resolves the hostname to ALL DNS addresses, asserts none are private, then
 * creates an undici Agent whose `connect.lookup` is pinned to the first
 * resolved IP — eliminating the DNS-rebind TOCTOU window between validation
 * and TCP connect (M1 — SSRF).
 */
async function buildPinnedDispatcher(hostname: string): Promise<unknown> {
  const pinned = await resolveAndAssertConnectorHost(hostname, "repo");
  const lookup = makePinnedLookup(pinned.address, pinned.family);
  if (!lookup) {
    throw new Error(`makePinnedLookup returned undefined for ${hostname}`);
  }
  const { Agent } = (await import("undici")) as unknown as {
    Agent: new (opts: { connect: { lookup: typeof lookup } }) => unknown;
  };
  return new Agent({ connect: { lookup } });
}

function guardConfig(deps: ImporterDeps): {
  assertHostAllowed?: AssertHostAllowed;
  pinnedDispatcherFor?: (hostname: string) => Promise<unknown>;
} {
  // Explicit test override: use the injected assertHostAllowed, no pinning.
  if (deps.assertHostAllowed !== undefined) {
    return { assertHostAllowed: deps.assertHostAllowed };
  }
  // Explicit dispatcher override (e.g. tests that want to verify pinning).
  if (deps.pinnedDispatcherFor !== undefined) {
    return { pinnedDispatcherFor: deps.pinnedDispatcherFor };
  }
  // Production default: full DNS-resolution + pinning.
  return { pinnedDispatcherFor: buildPinnedDispatcher };
}

export function createImporter(creds: ResolvedCredentials, deps: ImporterDeps = {}): Importer {
  const gc = guardConfig(deps);
  switch (creds.source) {
    case "github":
      return new GithubImporter({
        token: creds.token,
        baseUrl: creds.baseUrl,
        fetchFn: deps.fetchFn,
        ...gc,
        backoff: deps.backoff,
      });
    case "azure-devops":
      return new AzureDevopsImporter({
        token: creds.token,
        baseUrl: creds.baseUrl,
        fetchFn: deps.fetchFn,
        ...gc,
        backoff: deps.backoff,
      });
    case "linear":
      return new LinearImporter({
        token: creds.token,
        baseUrl: creds.baseUrl,
        fetchFn: deps.fetchFn,
        ...gc,
        backoff: deps.backoff,
      });
    case "jira":
      return new JiraImporter({
        client: creds.client,
        baseUrl: creds.baseUrl,
        customFieldMap: creds.customFieldMap,
      });
    default: {
      const exhaustive: never = creds;
      throw new Error(`Unknown import source: ${String(exhaustive)}`);
    }
  }
}

/** True when a source requires a stored API token (vs. a reused connection). */
export function sourceUsesToken(source: ImportSourceKind): boolean {
  return source !== "jira";
}
