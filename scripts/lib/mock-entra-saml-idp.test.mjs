/**
 * #1553 — the in-process Entra-profile SAML IdP checks the AuthnRequest as
 * Entra does and answers in Entra's shape, signed as the selected profile says.
 * (That METIS accepts and refuses what it sends is proven against the real
 * node-saml validator in server/tests/saml-entra-mock-idp-1553.sqlite.test.ts.)
 */
import { deflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  ENTRA_CLAIM,
  MAX_FORM_BYTES,
  escapeXml,
  readAuthnRequest,
  startMockEntraSamlIdp,
} from "./mock-entra-saml-idp.mjs";

const SP = "https://metis.test/api/auth/saml/metadata";
const ACS = "https://metis.test/api/auth/saml/acs";
const ADMINS = "6f1d0000-1553-4000-8000-0000000000ad";
const USER = {
  upn: "ada@contoso.example",
  objectId: "ada00000-1553-4000-8000-000000000001",
  displayName: "Ada <Admin>",
  groups: [ADMINS],
  roles: ["METIS.Admin"],
};

/** @type {Awaited<ReturnType<typeof startMockEntraSamlIdp>>} */
let idp;
beforeEach(async () => {
  idp = await startMockEntraSamlIdp({ spEntityId: SP, acsUrl: ACS, user: USER });
});
afterEach(async () => {
  await idp.close();
});

/** A deflated, base64 SP AuthnRequest, as node-saml sends on HTTP-Redirect. */
function authnRequest({ id = "_req1553", issuer = SP, acs = ACS } = {}) {
  const acsAttr = acs === null ? "" : ` AssertionConsumerServiceURL="${acs}"`;
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}" Version="2.0" IssueInstant="2026-10-29T00:00:00Z"${acsAttr} Destination="${idp.ssoUrl}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:AuthnRequest>`;
  return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

/** Sign in at the SAML endpoint and return the posted form's fields. */
async function signIn(query = { SAMLRequest: authnRequest(), RelayState: "rs-1" }) {
  const res = await fetch(`${idp.ssoUrl}?${new URLSearchParams(query)}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/^text\/html/);
  const html = await res.text();
  const samlResponse = /name="SAMLResponse" value="([^"]*)"/.exec(html)?.[1];
  return {
    html,
    action: /<form method="POST" name="hiddenform" action="([^"]*)"/.exec(html)?.[1],
    relayState: /name="RelayState" value="([^"]*)"/.exec(html)?.[1],
    encoded: /** @type {string} */ (samlResponse),
    xml: Buffer.from(/** @type {string} */ (samlResponse), "base64").toString("utf8"),
  };
}

const pem = () =>
  `-----BEGIN CERTIFICATE-----\n${idp.certificate.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;

/** Every enveloped signature in `xml`, in document order. */
function signatures(xml) {
  return [
    ...xml.matchAll(
      /<(ds:)?Signature xmlns(:ds)?="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">[\s\S]*?<\/(ds:)?Signature>/g,
    ),
  ].map((m) => m[0]);
}

/** Does `signature` verify over `xml` with the IdP's certificate? */
function verifies(xml, signature) {
  const check = new SignedXml({ publicCert: pem() });
  check.loadSignature(signature);
  return check.checkSignature(xml);
}

/** The values of one Attribute in a Response. */
function claim(xml, name) {
  const open = `<Attribute Name="${name}">`;
  const start = xml.indexOf(open);
  const body =
    start < 0 ? undefined : xml.slice(start + open.length, xml.indexOf("</Attribute>", start));
  return body === undefined
    ? undefined
    : [...body.matchAll(/<AttributeValue>([^<]*)<\/AttributeValue>/g)].map((m) => m[1]);
}

describe("mock Entra SAML IdP (#1553) — federation metadata", () => {
  it("serves signed, Entra-shaped metadata for its tenant", async () => {
    const res = await fetch(idp.metadataUrl);
    expect(res.status).toBe(200);
    const xml = await res.text();

    expect(idp.issuer).toBe(`https://sts.windows.net/${idp.tenantId}/`);
    expect(xml).toContain(`entityID="${idp.issuer}"`);
    expect(xml).toMatch(/^<\?xml[^>]*\?><EntityDescriptor[^>]*><ds:Signature /);
    const sts = xml.indexOf('xsi:type="fed:SecurityTokenServiceType"');
    const app = xml.indexOf('xsi:type="fed:ApplicationServiceType"');
    expect(sts).toBeGreaterThan(0);
    expect(app).toBeGreaterThan(sts);
    expect(xml.indexOf("<IDPSSODescriptor")).toBeGreaterThan(app);
    expect(xml).toContain(
      `<SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${idp.ssoUrl}"/>`,
    );
    expect(xml.split(`<X509Certificate>${idp.certificate}</X509Certificate>`)).toHaveLength(5);
    const [signature] = signatures(xml);
    expect(verifies(xml, signature)).toBe(true);
    expect(idp.calls.metadata).toBe(1);
  });
});

describe("mock Entra SAML IdP (#1553) — sign-in", () => {
  it("answers an SP-initiated request with Entra's auto-posting form and an Entra-shaped Response", async () => {
    const posted = await signIn();

    expect(posted.action).toBe(ACS);
    expect(posted.relayState).toBe("rs-1");
    expect(posted.html).toContain("<script>document.forms[0].submit();</script>");
    expect(idp.lastResponse()).toBe(posted.encoded);
    expect(idp.calls.sso).toBe(1);

    const { xml } = posted;
    expect(xml).toMatch(/^<samlp:Response [^>]*InResponseTo="_req1553"/);
    expect(xml).toContain(`<Issuer>${idp.issuer}</Issuer>`);
    expect(xml).toContain(
      '<NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">ada@contoso.example</NameID>',
    );
    expect(xml).toContain(`<Audience>${SP}</Audience>`);
    expect(xml).toContain(`Recipient="${ACS}"`);
    expect(claim(xml, ENTRA_CLAIM.tenantId)).toEqual([idp.tenantId]);
    expect(claim(xml, ENTRA_CLAIM.objectId)).toEqual([USER.objectId]);
    expect(claim(xml, ENTRA_CLAIM.displayName)).toEqual(["Ada &lt;Admin&gt;"]);
    expect(claim(xml, ENTRA_CLAIM.emailAddress)).toEqual([USER.upn]);
    expect(claim(xml, ENTRA_CLAIM.name)).toEqual([USER.upn]);
    expect(claim(xml, ENTRA_CLAIM.groups)).toEqual([ADMINS]);
    expect(claim(xml, ENTRA_CLAIM.role)).toEqual(["METIS.Admin"]);
    expect(claim(xml, ENTRA_CLAIM.groupsLink)).toBeUndefined();
  });

  it("by default signs the assertion only (Entra's default), right after its Issuer, password-only", async () => {
    const { xml } = await signIn();

    expect(DEFAULT_PROFILE.signing).toBe("assertion");
    const sigs = signatures(xml);
    expect(sigs).toHaveLength(1);
    expect(xml).toMatch(/<Assertion [^>]*><Issuer>[^<]*<\/Issuer><Signature /);
    expect(sigs[0]).toMatch(/<Reference URI="#_[0-9a-f-]+">/);
    expect(verifies(xml, sigs[0])).toBe(true);
    expect(claim(xml, ENTRA_CLAIM.authnMethodsReferences)).toEqual([
      "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password",
    ]);
    expect(xml).toContain(
      "<AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</AuthnContextClassRef>",
    );
  });

  it('"Sign SAML response and assertion" signs both, each verifiable', async () => {
    idp.setProfile({ signing: "both" });
    const { xml } = await signIn();

    const sigs = signatures(xml);
    expect(sigs).toHaveLength(2);
    expect(xml).toMatch(/^<samlp:Response [^>]*><Issuer [^>]*>[^<]*<\/Issuer><Signature /);
    for (const sig of sigs) expect(verifies(xml, sig)).toBe(true);
  });

  it('"Sign SAML response" signs the envelope only', async () => {
    idp.setProfile({ signing: "response" });
    const { xml } = await signIn();

    expect(signatures(xml)).toHaveLength(1);
    expect(xml).toMatch(/^<samlp:Response [^>]*><Issuer [^>]*>[^<]*<\/Issuer><Signature /);
    expect(xml).not.toMatch(/<Assertion [^>]*><Issuer>[^<]*<\/Issuer><Signature /);
  });

  it("an MFA sign-in carries multipleauthn and the MobileTwoFactorContract class", async () => {
    idp.setProfile({ mfa: true });
    const { xml } = await signIn();

    expect(claim(xml, ENTRA_CLAIM.authnMethodsReferences)).toEqual([
      "http://schemas.microsoft.com/ws/2008/06/identity/authenticationmethod/password",
      "http://schemas.microsoft.com/claims/multipleauthn",
    ]);
    expect(xml).toContain("ac:classes:MobileTwoFactorContract</AuthnContextClassRef>");
  });

  it("a groups overage sends groups.link instead of groups", async () => {
    idp.setProfile({ groupOverage: true });
    const { xml } = await signIn();

    expect(claim(xml, ENTRA_CLAIM.groups)).toBeUndefined();
    expect(claim(xml, ENTRA_CLAIM.groupsLink)).toEqual([
      `https://graph.windows.net/${idp.tenantId}/users/${USER.objectId}/getMemberObjects`,
    ]);
  });

  it("an expired assertion's windows have closed; a wrong-audience one names another app", async () => {
    idp.setProfile({ expired: true, wrongAudience: true });
    const { xml } = await signIn();

    const notOnOrAfter = [...xml.matchAll(/NotOnOrAfter="([^"]+)"/g)].map((m) => Date.parse(m[1]));
    expect(notOnOrAfter).toHaveLength(2);
    for (const t of notOnOrAfter) expect(t).toBeLessThan(Date.now());
    expect(xml).not.toContain(`<Audience>${SP}</Audience>`);
    expect(xml).toContain("<Audience>https://another-application.example/sp</Audience>");
  });

  it("setProfile returns unnamed fields to Entra's defaults; setUser changes who signs in", async () => {
    idp.setProfile({ mfa: true, signing: "both" });
    idp.setProfile({ groupOverage: true });
    idp.setUser({ upn: "max@contoso.example", objectId: "m-1", displayName: "Max" });
    const { xml } = await signIn();

    expect(signatures(xml)).toHaveLength(1);
    expect(xml).toContain("ac:classes:Password</AuthnContextClassRef>");
    expect(claim(xml, ENTRA_CLAIM.emailAddress)).toEqual(["max@contoso.example"]);
    expect(claim(xml, ENTRA_CLAIM.role)).toBeUndefined();
  });

  it("accepts a request without an ACS URL and omits RelayState when none was sent", async () => {
    const posted = await signIn({ SAMLRequest: authnRequest({ acs: null }) });
    expect(posted.action).toBe(ACS);
    expect(posted.relayState).toBeUndefined();
  });
});

describe("mock Entra SAML IdP (#1553) — refusals", () => {
  it.each([
    ["no SAMLRequest", {}, /AADSTS750054/],
    ["a request that is not deflated XML", { SAMLRequest: "bm90LWRlZmxhdGVk" }, /AADSTS7500529/],
    [
      "an unknown application identifier",
      { issuer: "https://other.example/sp" },
      /AADSTS700016: .*other\.example/,
    ],
    [
      "a reply URL that is not registered",
      { acs: "https://evil.example/acs" },
      /AADSTS50011: .*evil\.example/,
    ],
  ])("refuses %s", async (_label, spec, message) => {
    const query =
      "SAMLRequest" in spec || Object.keys(spec).length === 0
        ? spec
        : { SAMLRequest: authnRequest(spec) };
    const res = await fetch(`${idp.ssoUrl}?${new URLSearchParams(query)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(message);
    expect(idp.lastResponse()).toBeUndefined();
  });

  it("answers 404 off its two endpoints", async () => {
    expect((await fetch(`${idp.ssoUrl.replace(/saml2$/, "nope")}`)).status).toBe(404);
  });
});

describe("helpers", () => {
  it("escapeXml escapes markup and quotes", () => {
    expect(escapeXml(`a&b<c>"d"`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;");
  });

  it("readAuthnRequest refuses XML that is not an AuthnRequest", () => {
    const notRequest = deflateRawSync(Buffer.from("<LogoutRequest ID='x'/>")).toString("base64");
    expect(() => readAuthnRequest(notRequest)).toThrow(/not an AuthnRequest/);
  });
});

describe("mock Entra SAML IdP (#1559) — account picker", () => {
  const ACCOUNTS = [
    { user: USER, profile: { mfa: true }, note: "admins <MFA>" },
    {
      user: { upn: "max@contoso.example", objectId: "m-1", displayName: "Max", groups: ["g-m"] },
      profile: { groupOverage: true },
    },
  ];
  /** @type {Awaited<ReturnType<typeof startMockEntraSamlIdp>>} */
  let picker;
  beforeEach(async () => {
    picker = await startMockEntraSamlIdp({
      spEntityId: SP,
      acsUrl: ACS,
      user: USER,
      accounts: ACCOUNTS,
      profile: { signing: "both" },
    });
  });
  afterEach(async () => {
    await picker.close();
  });

  /** A deflated AuthnRequest addressed to the picker IdP. */
  function pickerRequest({ issuer = SP } = {}) {
    const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_pick1559" Version="2.0" AssertionConsumerServiceURL="${ACS}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${issuer}</saml:Issuer></samlp:AuthnRequest>`;
    return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
  }

  /** POST the picker's form. @param {Record<string, string>} fields */
  function post(fields) {
    return fetch(picker.ssoUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  /** The Response the picker IdP last posted, as XML. */
  const lastXml = () =>
    Buffer.from(/** @type {string} */ (picker.lastResponse()), "base64").toString("utf8");

  it("shows the accounts, escaped, with the request and the default signing option, and signs no one in", async () => {
    const samlRequest = pickerRequest();
    const res = await fetch(
      `${picker.ssoUrl}?${new URLSearchParams({ SAMLRequest: samlRequest, RelayState: 'r"1' })}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(`<form method="POST" action="${picker.ssoUrl}">`);
    expect(html).toContain(`name="SAMLRequest" value="${escapeXml(samlRequest)}"`);
    expect(html).toContain('name="RelayState" value="r&quot;1"');
    expect(html).toContain('<option value="both" selected>Sign SAML response and assertion');
    expect(html).toContain('<option value="assertion">');
    expect(html).toContain(
      '<button type="submit" name="account" value="0"><strong>Ada &lt;Admin&gt;</strong> &lt;ada@contoso.example&gt; <small>admins &lt;MFA&gt;</small></button>',
    );
    expect(html).toContain('value="1"><strong>Max</strong> &lt;max@contoso.example&gt;</button>');
    expect(html).not.toContain("SAMLResponse");
    expect(picker.lastResponse()).toBeUndefined();
  });

  it("checks the request before showing the picker", async () => {
    const query = new URLSearchParams({
      SAMLRequest: pickerRequest({ issuer: "https://other.example/sp" }),
    });
    const res = await fetch(`${picker.ssoUrl}?${query}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/AADSTS700016/);
  });

  it("signs the picked account in under its profile and the picked signing option", async () => {
    const res = await post({
      SAMLRequest: pickerRequest(),
      RelayState: "rs-9",
      account: "0",
      signing: "both",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="${ACS}"`);
    expect(/name="RelayState" value="([^"]*)"/.exec(html)?.[1]).toBe("rs-9");
    const xml = lastXml();
    expect(xml).toMatch(/InResponseTo="_pick1559"/);
    expect(claim(xml, ENTRA_CLAIM.emailAddress)).toEqual([USER.upn]);
    expect(claim(xml, ENTRA_CLAIM.authnMethodsReferences)).toContain(
      "http://schemas.microsoft.com/claims/multipleauthn",
    );
    expect(signatures(xml)).toHaveLength(2);
  });

  it("the second account sends groups.link, and Entra's default signs the assertion only", async () => {
    const res = await post({ SAMLRequest: pickerRequest(), account: "1", signing: "assertion" });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('name="RelayState"');
    const xml = lastXml();
    expect(claim(xml, ENTRA_CLAIM.emailAddress)).toEqual(["max@contoso.example"]);
    expect(claim(xml, ENTRA_CLAIM.groups)).toBeUndefined();
    expect(claim(xml, ENTRA_CLAIM.groupsLink)).toHaveLength(1);
    expect(signatures(xml)).toHaveLength(1);
    expect(xml).toContain("ac:classes:Password</AuthnContextClassRef>");
  });

  it.each([
    ["an account past the list", { account: "2", signing: "both" }, /Unknown account/],
    ["an account that is not an index", { account: "0x0", signing: "both" }, /Unknown account/],
    ["no account", { signing: "both" }, /Unknown account/],
    ["an unknown signing option", { account: "0", signing: "none" }, /Unknown signing option/],
    [
      "a request for another application",
      { account: "0", signing: "both", issuer: "x" },
      /AADSTS700016/,
    ],
    ["no request", { account: "0", signing: "both", omit: "1" }, /AADSTS750054/],
  ])("refuses %s", async (_label, spec, message) => {
    const { issuer, omit, ...fields } = /** @type {Record<string, string>} */ (spec);
    const res = await post({
      ...(omit ? {} : { SAMLRequest: pickerRequest(issuer ? { issuer } : {}) }),
      ...fields,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(message);
    expect(picker.lastResponse()).toBeUndefined();
  });

  it("refuses a form past its size limit", async () => {
    const res = await post({
      SAMLRequest: pickerRequest(),
      account: "0",
      signing: "both",
      pad: "x".repeat(MAX_FORM_BYTES),
    });
    expect(res.status).toBe(413);
    expect(picker.lastResponse()).toBeUndefined();
  });

  it("without accounts there is no picker to post to", async () => {
    const res = await fetch(idp.ssoUrl, { method: "POST", body: "account=0" });
    expect(res.status).toBe(404);
  });

  it("listens on the port it is given, and fails to start on a port in use", async () => {
    const port = Number(new URL(picker.ssoUrl).port);
    await expect(
      startMockEntraSamlIdp({ spEntityId: SP, acsUrl: ACS, user: USER, port }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
