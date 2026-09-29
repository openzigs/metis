/**
 * #344 — does a connector write change WHERE its vault secret is sent?
 *
 * Used with `assertSecretBindingAllowed` (lib/vault/secret-binding.ts): a caller
 * without `vault.reveal` may not move a connector that holds a secret they did
 * not create. Only the fields a request actually names are compared, and an
 * unchanged value re-sent by a full-form save is not a change.
 */
import { isDeepStrictEqual } from "node:util";

/**
 * DB driver `options` keys that never choose the destination. `allowList` is
 * the #882 per-connector table/column allow-list, read by the SQL validator.
 * Every other key reaches the driver (mysql spreads `options` over host/port,
 * Oracle's `tnsAlias` becomes the whole connect string), so it counts.
 */
const DB_OPTION_KEYS_NOT_DESTINATION = new Set(["allowList"]);

/** The destination-bearing part of a DB `options` value (JSON string or object). */
export function dbDestinationOptions(options: unknown): unknown {
  let value = options;
  if (typeof value === "string") {
    if (value.trim() === "") return {};
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([k]) => !DB_OPTION_KEYS_NOT_DESTINATION.has(k),
    ),
  );
}

/** True when `options` carries any key that can redirect a driver. */
export function hasDbDestinationOptions(options: unknown): boolean {
  const d = dbDestinationOptions(options);
  if (d !== null && typeof d === "object" && !Array.isArray(d)) {
    return Object.keys(d).length > 0;
  }
  return true;
}

const blank = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
const portOf = (v: number | null | undefined) => (v ? v : null);

export function dbDestinationChanged(
  existing: { driver: string; host: string | null; port: number | null; options: string | null },
  patch: {
    driver?: string | null;
    host?: string | null;
    port?: number | null;
    options?: string | null;
  },
): boolean {
  if (patch.driver !== undefined && patch.driver !== existing.driver) return true;
  if (patch.host !== undefined && blank(patch.host) !== blank(existing.host)) return true;
  if (patch.port !== undefined && portOf(patch.port) !== portOf(existing.port)) return true;
  if (
    patch.options !== undefined &&
    !isDeepStrictEqual(dbDestinationOptions(patch.options), dbDestinationOptions(existing.options))
  ) {
    return true;
  }
  return false;
}

export function repoDestinationChanged(
  existing: { provider: string; apiBaseUrl: string | null },
  patch: { provider?: string | null; apiBaseUrl?: string | null },
): boolean {
  if (patch.provider !== undefined && patch.provider !== existing.provider) return true;
  if (patch.apiBaseUrl !== undefined && blank(patch.apiBaseUrl) !== blank(existing.apiBaseUrl)) {
    return true;
  }
  return false;
}
