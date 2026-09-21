/**
 * Epic #396 / Issue #431 — MCP transport dispatcher.
 *
 * Translates MCP `tools/call` invocations into HTTPS POSTs against the
 * existing namespaced Spec Kit REST surface
 * (`POST /api/projects/:projectId/spec-kit/commands/:cmd`). Reuses the
 * MVP-7 `assertApiBaseUrlAllowed` allow-list so an attacker who controls
 * `METIS_API_BASE_URL` cannot exfiltrate the bearer token to an unknown
 * origin.
 */
import { assertApiBaseUrlAllowed } from "../../lib/net/api-base-url.js";

export interface SpecKitMcpConfig {
  apiBaseUrl: string;
  projectId: string;
  token: string;
}

export class SpecKitMcpHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "SpecKitMcpHttpError";
  }
}

export interface DispatchInput {
  /** Canonical command name (e.g. `speckit.specify`). */
  command: string;
  /** Free-form text input (mapped to body `input`). */
  input?: string;
  /** Optional structured fields merged into the JSON body. */
  body?: Record<string, unknown>;
  /** Optional `X-Speckit-Force` header override. */
  force?: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

/**
 * Validate the configured `METIS_API_BASE_URL` via the same allow-list the
 * filesystem installer uses. Throws on a disallowed origin so the MCP
 * server fails closed at boot.
 */
export function assertConfig(cfg: SpecKitMcpConfig): void {
  if (!cfg.apiBaseUrl) throw new Error("METIS_API_BASE_URL is required");
  if (!cfg.projectId) throw new Error("METIS_PROJECT_ID is required");
  if (!cfg.token) throw new Error("METIS_SERVICE_TOKEN is required");
  assertApiBaseUrlAllowed(cfg.apiBaseUrl);
}

/**
 * Dispatch a single MCP tool call to the Spec Kit HTTP surface. The shape
 * of `data` varies per command — the MCP layer simply forwards it.
 */
export async function dispatchToHttp(
  cfg: SpecKitMcpConfig,
  call: DispatchInput,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const url = `${cfg.apiBaseUrl.replace(/\/$/, "")}/api/projects/${encodeURIComponent(
    cfg.projectId,
  )}/spec-kit/commands/${encodeURIComponent(call.command)}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.token}`,
  };
  if (call.force) headers["x-speckit-force"] = "true";
  const body = JSON.stringify({ input: call.input ?? "", ...(call.body ?? {}) });
  const res = await fetchImpl(url, { method: "POST", headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON body — pass through as raw text.
    }
  }
  if (!res.ok) {
    throw new SpecKitMcpHttpError(
      `METIS Spec Kit ${call.command} failed (${res.status})`,
      res.status,
      parsed,
    );
  }
  return parsed;
}
