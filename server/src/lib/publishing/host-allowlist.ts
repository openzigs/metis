/**
 * Publishing host allow-list — Phase 9.
 *
 * Reuses the connector network-allowlist (`assertConnectorHostAllowed` /
 * `resolveAndAssertConnectorHost`) but exposes a publisher-shaped helper so
 * call sites do not have to know about the connector subsystem internals.
 *
 * The publisher accepts:
 *   - implicit `https://api.github.com` (always allowed)
 *   - any hostname listed in `REPO_ALLOWED_HOSTS` (Enterprise instances)
 *
 * SSRF defence is identical to the repo connector — RFC1918 / loopback /
 * link-local / ULA / CGNAT addresses are rejected unless the operator
 * explicitly lists the hostname.
 */
import { DEFAULT_GITHUB_API_BASE_URL } from "@metis/shared";
import {
  assertConnectorHostAllowed,
  resolveAndAssertConnectorHost,
} from "../connectors/network-allowlist.js";
import { PublishError, type ResolvedRepoTarget } from "./types.js";

/** Always allowed (public GitHub API). */
const PUBLIC_GITHUB_HOSTS = new Set(["api.github.com"]);

export interface ResolveTargetInput {
  owner: string;
  repo: string;
  /** Optional override (`https://github.example.com/api/v3`). */
  baseUrl?: string | null;
}

export async function resolvePublishTarget(input: ResolveTargetInput): Promise<ResolvedRepoTarget> {
  if (!input.owner || !/^[A-Za-z0-9][A-Za-z0-9-_.]{0,99}$/.test(input.owner)) {
    throw new PublishError(400, "INVALID_OWNER", `invalid GitHub owner: ${input.owner}`);
  }
  if (!input.repo || !/^[A-Za-z0-9._-]{1,100}$/.test(input.repo)) {
    throw new PublishError(400, "INVALID_REPO", `invalid GitHub repo: ${input.repo}`);
  }
  const baseUrl = (input.baseUrl ?? DEFAULT_GITHUB_API_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PublishError(400, "INVALID_BASE_URL", `not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:") {
    throw new PublishError(400, "INSECURE_BASE_URL", `base URL must be HTTPS: ${baseUrl}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (PUBLIC_GITHUB_HOSTS.has(hostname)) {
    // No DNS pinning for public github.com — the base URL is well-known and
    // operators do not get to allow-list it for SSRF gymnastics.
    return {
      owner: input.owner,
      repo: input.repo,
      baseUrl: stripTrailingSlash(baseUrl),
      hostname,
    };
  }
  // GHE / custom host — must be on the connector allow-list and we pin DNS.
  await assertConnectorHostAllowed(hostname, "repo");
  const pinned = await resolveAndAssertConnectorHost(hostname, "repo");
  return {
    owner: input.owner,
    repo: input.repo,
    baseUrl: stripTrailingSlash(baseUrl),
    hostname,
    pinnedAddress: pinned.address,
    pinnedFamily: pinned.family,
  };
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
