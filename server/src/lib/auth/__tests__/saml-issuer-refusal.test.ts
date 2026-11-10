/**
 * #1562 — the last SAML sign-in refused for its assertion Issuer, beside the
 * configured issuer, for the admin Authentication page. (The ACS writing the
 * row and the admin route reading it through a real database are covered in
 * server/tests/saml-entra-mock-idp-1553.sqlite.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("../../prisma.js", () => ({ prisma: { auditLog: { findMany } } }));

const {
  ISSUER_REFUSAL_WINDOW,
  MAX_RECORDED_ISSUER_LENGTH,
  SAML_ISSUER_REFUSAL_TARGET_TYPE,
  SAML_ISSUER_REFUSED_ACTION,
  issuerRefusalAuditMetadata,
  samlIssuerRefusalSummary,
} = await import("../saml-issuer-refusal.js");

const PROVIDER_ID = "saml-provider-1562";
const CONFIGURED = "https://sts.windows.net/aaaa0000-1562-4000-8000-000000000001/";
const ASSERTED = "https://sts.windows.net/bbbb0000-1562-4000-8000-000000000002/";
const AT = new Date("2026-11-10T09:00:00.000Z");
const EARLIER = new Date("2026-11-09T09:00:00.000Z");
const configured = (configuredIssuer: string) => ({ id: PROVIDER_ID, configuredIssuer });

/** An audit row as the ACS writes it. */
function row(metadata: unknown, ts = AT) {
  return { ts, metadata: typeof metadata === "string" ? metadata : JSON.stringify(metadata) };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("issuerRefusalAuditMetadata", () => {
  it("records both issuers", () => {
    expect(
      issuerRefusalAuditMetadata({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED }),
    ).toEqual({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED, mode: "saml" });
  });

  it("keeps a missing Issuer as null, and caps an oversized one", () => {
    expect(
      issuerRefusalAuditMetadata({ assertionIssuer: null, configuredIssuer: CONFIGURED })
        .assertionIssuer,
    ).toBeNull();
    const long = `https://idp.example/${"x".repeat(2 * MAX_RECORDED_ISSUER_LENGTH)}`;
    expect(
      issuerRefusalAuditMetadata({ assertionIssuer: long, configuredIssuer: CONFIGURED })
        .assertionIssuer,
    ).toHaveLength(MAX_RECORDED_ISSUER_LENGTH);
  });
});

describe("samlIssuerRefusalSummary", () => {
  it("#2204: reads the provider's newest refusals, filtered for the [targetType, targetId, action] index", async () => {
    findMany.mockResolvedValue([
      row({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED, mode: "saml" }),
    ]);
    expect(await samlIssuerRefusalSummary(configured(CONFIGURED))).toEqual({
      configuredIssuer: CONFIGURED,
      lastRefused: { assertionIssuer: ASSERTED, at: AT.toISOString() },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          targetType: SAML_ISSUER_REFUSAL_TARGET_TYPE,
          targetId: PROVIDER_ID,
          action: SAML_ISSUER_REFUSED_ACTION,
        },
        orderBy: { ts: "desc" },
        take: ISSUER_REFUSAL_WINDOW,
      }),
    );
  });

  it("#2204: issuer A refused, then B refused, then back to A reports A's newest refusal", async () => {
    findMany.mockResolvedValue([
      row({ assertionIssuer: CONFIGURED, configuredIssuer: ASSERTED }, AT),
      row({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED }, EARLIER),
      row({ assertionIssuer: "https://older.example/", configuredIssuer: CONFIGURED }, EARLIER),
    ]);
    expect((await samlIssuerRefusalSummary(configured(CONFIGURED))).lastRefused).toEqual({
      assertionIssuer: ASSERTED,
      at: EARLIER.toISOString(),
    });
  });

  it("reports an assertion that named no Issuer", async () => {
    findMany.mockResolvedValue([row({ assertionIssuer: null, configuredIssuer: CONFIGURED })]);
    expect((await samlIssuerRefusalSummary(configured(CONFIGURED))).lastRefused).toEqual({
      assertionIssuer: null,
      at: AT.toISOString(),
    });
  });

  it("a refusal against an issuer no longer configured is not reported: re-pasting the metadata clears it", async () => {
    findMany.mockResolvedValue([row({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED })]);
    expect(await samlIssuerRefusalSummary(configured(ASSERTED))).toEqual({
      configuredIssuer: ASSERTED,
      lastRefused: null,
    });
  });

  it.each([
    ["no refusal recorded", []],
    ["unparseable metadata", [row("{not json")]],
    ["no metadata", [{ ts: AT, metadata: null }]],
  ])("reports nothing for %s", async (_label, found) => {
    findMany.mockResolvedValue(found);
    expect((await samlIssuerRefusalSummary(configured(CONFIGURED))).lastRefused).toBeNull();
  });

  it("with no issuer configured there is nothing to compare, and no query", async () => {
    expect(await samlIssuerRefusalSummary(configured(""))).toEqual({
      configuredIssuer: "",
      lastRefused: null,
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
