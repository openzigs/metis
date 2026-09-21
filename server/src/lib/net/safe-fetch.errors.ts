/**
 * Issue #302 — typed errors thrown by the canonical `safeFetch`.
 *
 * Each error class carries enough structured data for the caller to map it
 * to the right HTTP status / log fields without having to substring-match
 * the message.
 */

import type { PrivateIpClass } from "@metis/shared";

/**
 * Classification carried by {@link SafeFetchPrivateIpError}. Aliased to the
 * shared `PrivateIpClass` so the private-range label table lives in exactly
 * one place (`@metis/shared/net`) — see issue #683 / #302.
 */
export type SafeFetchPrivateClass = PrivateIpClass;

export class SafeFetchSchemeError extends Error {
  readonly scheme: string;
  constructor(scheme: string, raw: string) {
    super(`safeFetch: scheme '${scheme}' is not supported (only http: / https:): ${raw}`);
    this.name = "SafeFetchSchemeError";
    this.scheme = scheme;
  }
}

export class SafeFetchPrivateIpError extends Error {
  readonly host: string;
  readonly address: string;
  readonly classification: SafeFetchPrivateClass;
  constructor(host: string, address: string, classification: SafeFetchPrivateClass) {
    super(
      `safeFetch: ${host} resolves to ${address} which is in non-routable range (${classification})`,
    );
    this.name = "SafeFetchPrivateIpError";
    this.host = host;
    this.address = address;
    this.classification = classification;
  }
}

export class SafeFetchRedirectError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string, message?: string) {
    super(message ?? `safeFetch: redirect from ${from} to ${to} blocked by policy`);
    this.name = "SafeFetchRedirectError";
    this.from = from;
    this.to = to;
  }
}

export class SafeFetchDnsError extends Error {
  readonly host: string;
  constructor(host: string, cause: string) {
    super(`safeFetch: DNS lookup failed for ${host}: ${cause}`);
    this.name = "SafeFetchDnsError";
    this.host = host;
  }
}

export class SafeFetchUrlError extends Error {
  constructor(raw: string) {
    super(`safeFetch: not a valid URL: ${raw}`);
    this.name = "SafeFetchUrlError";
  }
}
