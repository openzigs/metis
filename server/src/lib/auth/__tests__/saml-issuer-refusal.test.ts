/**
 * #1562 — the last SAML sign-in refused for its assertion Issuer, beside the
 * configured issuer, for the admin Authentication page. (The ACS writing the
 * row and the admin route reading it through a real database are covered in
 * server/tests/saml-entra-mock-idp-1553.sqlite.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
vi.mock("../../prisma.js", () => ({ prisma: { auditLog: { findFirst } } }));

const {
  MAX_RECORDED_ISSUER_LENGTH,
  SAML_ISSUER_REFUSED_ACTION,
  issuerRefusalAuditMetadata,
  samlIssuerRefusalSummary,
} = await import("../saml-issuer-refusal.js");

const CONFIGURED = "https://sts.windows.net/aaaa0000-1562-4000-8000-000000000001/";
const ASSERTED = "https://sts.windows.net/bbbb0000-1562-4000-8000-000000000002/";
const AT = new Date("2026-11-10T09:00:00.000Z");

/** An audit row as the ACS writes it. */
function row(metadata: unknown) {
  return { ts: AT, metadata: typeof metadata === "string" ? metadata : JSON.stringify(metadata) };
}

beforeEach(() => {
  findFirst.mockReset();
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
  it("reads the newest refusal of the action", async () => {
    findFirst.mockResolvedValue(
      row({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED, mode: "saml" }),
    );
    expect(await samlIssuerRefusalSummary(CONFIGURED)).toEqual({
      configuredIssuer: CONFIGURED,
      lastRefused: { assertionIssuer: ASSERTED, at: AT.toISOString() },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: SAML_ISSUER_REFUSED_ACTION },
        orderBy: { ts: "desc" },
      }),
    );
  });

  it("reports an assertion that named no Issuer", async () => {
    findFirst.mockResolvedValue(row({ assertionIssuer: null, configuredIssuer: CONFIGURED }));
    expect((await samlIssuerRefusalSummary(CONFIGURED)).lastRefused).toEqual({
      assertionIssuer: null,
      at: AT.toISOString(),
    });
  });

  it("a refusal against an issuer no longer configured is not reported: re-pasting the metadata clears it", async () => {
    findFirst.mockResolvedValue(row({ assertionIssuer: ASSERTED, configuredIssuer: CONFIGURED }));
    expect(await samlIssuerRefusalSummary(ASSERTED)).toEqual({
      configuredIssuer: ASSERTED,
      lastRefused: null,
    });
  });

  it.each([
    ["no refusal recorded", null],
    ["unparseable metadata", row("{not json")],
    ["no metadata", { ts: AT, metadata: null }],
  ])("reports nothing for %s", async (_label, found) => {
    findFirst.mockResolvedValue(found);
    expect((await samlIssuerRefusalSummary(CONFIGURED)).lastRefused).toBeNull();
  });

  it("with no issuer configured there is nothing to compare, and no query", async () => {
    expect(await samlIssuerRefusalSummary("")).toEqual({ configuredIssuer: "", lastRefused: null });
    expect(findFirst).not.toHaveBeenCalled();
  });
});
