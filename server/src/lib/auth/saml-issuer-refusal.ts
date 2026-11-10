/**
 * #1562 — the last SAML sign-in METIS refused for its assertion Issuer (#1555),
 * beside the configured IdP issuer, for the admin Authentication page.
 *
 * Since #1555 an assertion whose Issuer is not byte-for-byte the configured
 * issuer (the metadata `entityID` `parseIdPMetadata` read) is refused. A
 * deployment upgrading with a stored issuer its IdP does not assert would
 * refuse every SAML sign-in, so the ACS records each Issuer refusal as an
 * audit event against the SAML provider (durable and shared by every replica)
 * and this reads the newest back, so an admin sees both values without reading
 * server logs.
 *
 * Only a refusal against the issuer configured now is reported: re-pasting the
 * IdP metadata, which changes the configured issuer, clears the warning.
 */
import { prisma } from "../prisma.js";

/** The audit action the SAML ACS records when it refuses an assertion's Issuer. */
export const SAML_ISSUER_REFUSED_ACTION = "sso.saml.issuer_refused";

/**
 * The longest asserted Issuer kept in the audit row. A real one is a URL or URN
 * well under 100 characters; the signed assertion it came from is otherwise
 * unbounded.
 */
export const MAX_RECORDED_ISSUER_LENGTH = 512;

/** The audit target type the ACS records a refusal against, with the provider id. */
export const SAML_ISSUER_REFUSAL_TARGET_TYPE = "sso-provider";

/**
 * How many of the provider's newest refusals are read to find one against the
 * configured issuer (#2204): refusals against an issuer configured in between
 * (A, then B, then A again) must not hide the newest one against A.
 */
export const ISSUER_REFUSAL_WINDOW = 20;

export interface SamlIssuerRefusal {
  /** The issuer METIS compares assertions with; empty when none is configured. */
  configuredIssuer: string;
  /** The newest refusal against that issuer, or null. */
  lastRefused: { assertionIssuer: string | null; at: string } | null;
}

/** The audit metadata the ACS records for an Issuer refusal. */
export function issuerRefusalAuditMetadata(refusal: {
  assertionIssuer: string | null;
  configuredIssuer: string;
}): { assertionIssuer: string | null; configuredIssuer: string; mode: "saml" } {
  return {
    assertionIssuer: refusal.assertionIssuer?.slice(0, MAX_RECORDED_ISSUER_LENGTH) ?? null,
    configuredIssuer: refusal.configuredIssuer,
    mode: "saml",
  };
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function samlIssuerRefusalSummary(provider: {
  /** The SAML provider's id: the ACS records each refusal against it. */
  id: string;
  configuredIssuer: string;
}): Promise<SamlIssuerRefusal> {
  const { configuredIssuer } = provider;
  // With no issuer configured, #1555's check does not run and nothing is refused.
  if (!configuredIssuer) return { configuredIssuer, lastRefused: null };
  // Filtered on the provider as well as the action, so the read uses the
  // `[targetType, targetId, action]` index instead of walking the audit table.
  const rows = await prisma.auditLog.findMany({
    where: {
      targetType: SAML_ISSUER_REFUSAL_TARGET_TYPE,
      targetId: provider.id,
      action: SAML_ISSUER_REFUSED_ACTION,
    },
    orderBy: { ts: "desc" },
    take: ISSUER_REFUSAL_WINDOW,
    select: { ts: true, metadata: true },
  });
  for (const row of rows) {
    const meta = parseMetadata(row.metadata);
    if (meta?.configuredIssuer !== configuredIssuer) continue;
    return {
      configuredIssuer,
      lastRefused: {
        assertionIssuer: typeof meta.assertionIssuer === "string" ? meta.assertionIssuer : null,
        at: row.ts.toISOString(),
      },
    };
  }
  return { configuredIssuer, lastRefused: null };
}
