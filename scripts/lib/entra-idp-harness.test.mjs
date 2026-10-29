/**
 * #1559 — the local Entra mock runner: its settings, the provider body it
 * seeds, the admin-API seed against a fake METIS, and a hand sign-in through
 * the account picker for each preset user. (That METIS maps those users to the
 * expected roles through its real routes is proven in
 * server/tests/saml-entra-local-harness-1559.sqlite.test.ts.)
 */
import { createServer } from "node:http";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENTRA_GROUPS,
  ENTRA_HARNESS_DEFAULTS,
  PRESET_ACCOUNTS,
  READY_LINE,
  buildEntraProviderBody,
  formatBanner,
  resolveHarnessConfig,
  runEntraHarness,
  seedEntraProvider,
  spEndpoints,
} from "./entra-idp-harness.mjs";
import { ENTRA_CLAIM } from "./mock-entra-saml-idp.mjs";

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/**
 * A fake METIS admin API on loopback that records what it was sent.
 * @param {{ login?: number, token?: unknown, put?: number, list?: number, enabled?: boolean }} [opts]
 */
async function fakeMetis(opts = {}) {
  /** @type {Array<{ method?: string, url?: string, auth?: string, body: any }>} */
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const json = (/** @type {number} */ status, /** @type {unknown} */ payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/auth/login") {
        return json(opts.login ?? 200, {
          data: { accessToken: "token" in opts ? opts.token : "tok-1559" },
        });
      }
      if (req.url === "/api/admin/auth/providers/saml") {
        return json(opts.put ?? 200, { data: { provider: { id: "p1" } } });
      }
      if (req.url === "/api/admin/auth/providers") {
        const put = seen.find((s) => s.method === "PUT")?.body;
        return json(opts.list ?? 200, {
          data: {
            providers: [{ mode: "saml", name: put?.name, enabled: opts.enabled ?? true }],
          },
        });
      }
      json(404, {});
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${port}/`, seen };
}

/** A config for tests: an ephemeral port and the fake METIS. */
function testConfig(metisApiUrl = "http://127.0.0.1:9", extra = {}) {
  return {
    ...resolveHarnessConfig({ METIS_API_URL: metisApiUrl, ENTRA_IDP_PORT: "0" }, []),
    ...extra,
  };
}

/** METIS's AuthnRequest for the seeded SP, deflated and base64. @param {string} api */
function authnRequest(api) {
  const sp = spEndpoints(api);
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_metis1559" Version="2.0" AssertionConsumerServiceURL="${sp.acsUrl}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${sp.entityId}</saml:Issuer></samlp:AuthnRequest>`;
  return deflateRawSync(Buffer.from(xml, "utf8")).toString("base64");
}

describe("resolveHarnessConfig (#1559)", () => {
  it("defaults to a fixed loopback port, the dev URLs and Sign SAML response and assertion", () => {
    expect(resolveHarnessConfig({}, [])).toEqual({
      host: "127.0.0.1",
      port: 4510,
      tenantId: ENTRA_HARNESS_DEFAULTS.tenantId,
      metisApiUrl: "http://localhost:4000",
      appUrl: "http://localhost:3000",
      signing: "both",
      providerName: "Microsoft Entra ID (mock)",
      adminUser: "admin",
      adminPassword: "password",
      seed: true,
    });
  });

  it("reads the environment, and an argument wins over it", () => {
    const config = resolveHarnessConfig(
      {
        ENTRA_SIGNING: "response",
        ENTRA_IDP_PORT: "4511",
        METIS_API_URL: "http://api.local:4100/",
        METIS_APP_URL: "http://ui.local:3100/",
        METIS_ADMIN_USER: "root",
        METIS_ADMIN_PASSWORD: "pw",
        ENTRA_PROVIDER_NAME: "Contoso",
        SKIP_SEED: "1",
      },
      ["--signing=assertion", "--port=0"],
    );
    expect(config).toMatchObject({
      port: 0,
      signing: "assertion",
      metisApiUrl: "http://api.local:4100",
      appUrl: "http://ui.local:3100",
      adminUser: "root",
      adminPassword: "pw",
      providerName: "Contoso",
      seed: false,
    });
    expect(resolveHarnessConfig({ ENTRA_IDP_PORT: "4511" }, []).port).toBe(4511);
    expect(resolveHarnessConfig({}, ["--no-seed"]).seed).toBe(false);
  });

  it.each([
    [{ ENTRA_SIGNING: "none" }, [], /unknown signing option 'none'/],
    [{}, ["--port=65536"], /invalid port '65536'/],
    [{ ENTRA_IDP_PORT: "45x" }, [], /invalid port '45x'/],
    [{}, ["--host=0.0.0.0"], /unknown argument '--host=0.0.0.0'/],
  ])("refuses %j %j", (env, argv, message) => {
    expect(() => resolveHarnessConfig(env, argv)).toThrow(message);
  });
});

describe("the seeded provider (#1559)", () => {
  it("names METIS's SP endpoints under /api/auth/saml", () => {
    expect(spEndpoints("http://localhost:4000/")).toEqual({
      entityId: "http://localhost:4000/api/auth/saml/metadata",
      acsUrl: "http://localhost:4000/api/auth/saml/acs",
      loginUrl: "http://localhost:4000/api/auth/saml/login",
    });
  });

  it("maps the admin group to admin and the member group to developer, with the secure defaults", () => {
    const body = buildEntraProviderBody({
      metadataXml: "<X509Certificate>c</X509Certificate>",
      metisApiUrl: "http://localhost:4000",
      providerName: "P",
    });
    expect(body).toEqual({
      name: "P",
      enabled: true,
      entityId: "http://localhost:4000/api/auth/saml/metadata",
      acsUrl: "http://localhost:4000/api/auth/saml/acs",
      idpMetadataXml: "<X509Certificate>c</X509Certificate>",
      signRequests: false,
      requireSignedResponse: true,
      groupMappings: [
        { claimValue: ENTRA_GROUPS.admins, role: "admin" },
        { claimValue: ENTRA_GROUPS.members, role: "developer" },
      ],
      defaultRole: "reader",
    });
  });

  it("refuses metadata without a signing certificate", () => {
    expect(() =>
      buildEntraProviderBody({ metadataXml: "<x/>", metisApiUrl: "http://m", providerName: "P" }),
    ).toThrow(/no signing certificate/);
  });

  it("the presets cover an MFA admin, a password-only member and a group overage, each with a fixed identity", () => {
    expect(PRESET_ACCOUNTS.map((a) => [a.expectedRole, a.profile])).toEqual([
      ["admin", { mfa: true }],
      ["developer", { mfa: false }],
      ["reader", { mfa: true, groupOverage: true }],
    ]);
    expect(new Set(PRESET_ACCOUNTS.map((a) => a.user.objectId)).size).toBe(3);
  });
});

describe("seedEntraProvider (#1559)", () => {
  const body = { name: "Mock Entra" };

  it("logs in as the mock admin, PUTs the provider with the token, and reads it back", async () => {
    const metis = await fakeMetis();
    const result = await seedEntraProvider({
      fetchImpl: fetch,
      metisApiUrl: metis.url,
      adminUser: "admin",
      adminPassword: "password",
      body,
    });
    expect(result).toEqual({ name: "Mock Entra" });
    expect(metis.seen.map((s) => [s.method, s.url])).toEqual([
      ["POST", "/api/auth/login"],
      ["PUT", "/api/admin/auth/providers/saml"],
      ["GET", "/api/admin/auth/providers"],
    ]);
    expect(metis.seen[0].body).toEqual({ username: "admin", password: "password" });
    expect(metis.seen[1].auth).toBe("Bearer tok-1559");
    expect(metis.seen[1].body).toEqual(body);
    expect(metis.seen[2].auth).toBe("Bearer tok-1559");
  });

  it("says METIS is unreachable when nothing answers", async () => {
    await expect(
      seedEntraProvider({
        fetchImpl: () => Promise.reject(new Error("fetch failed")),
        metisApiUrl: "http://127.0.0.1:1",
        adminUser: "admin",
        adminPassword: "password",
        body,
      }),
    ).rejects.toThrow(
      "could not reach METIS at http://127.0.0.1:1 (fetch failed). Start the dev server first",
    );
  });

  it.each([
    [{ login: 401 }, /admin login .* failed \(401\)/],
    [{ token: null }, /no accessToken/],
    [{ put: 400 }, /PUT failed \(400\)/],
    [{ list: 500 }, /read the providers back \(500\)/],
    [{ enabled: false }, /not enabled/],
  ])("fails loudly on %j", async (opts, message) => {
    const metis = await fakeMetis(opts);
    await expect(
      seedEntraProvider({
        fetchImpl: fetch,
        metisApiUrl: metis.url,
        adminUser: "admin",
        adminPassword: "password",
        body,
      }),
    ).rejects.toThrow(message);
  });
});

describe("runEntraHarness (#1559)", () => {
  it("starts the mock, seeds METIS from its metadata, and prints the login URL and the users", async () => {
    const metis = await fakeMetis();
    /** @type {string[]} */
    const logged = [];
    const { idp, banner } = await runEntraHarness({
      config: testConfig(metis.url),
      log: (line) => logged.push(line),
    });
    cleanups.push(() => idp.close());

    expect(idp.tenantId).toBe(ENTRA_HARNESS_DEFAULTS.tenantId);
    expect(new URL(idp.ssoUrl).hostname).toBe("127.0.0.1");
    const put = metis.seen.find((s) => s.method === "PUT")?.body;
    // The Federation Metadata the mock served: its tenant, its endpoint, its key.
    expect(idp.calls.metadata).toBe(1);
    expect(put.idpMetadataXml).toContain(`entityID="${idp.issuer}"`);
    expect(put.idpMetadataXml).toContain(`Location="${idp.ssoUrl}"`);
    expect(put.idpMetadataXml).toContain(`<X509Certificate>${idp.certificate}</X509Certificate>`);
    expect(put.entityId).toBe(`${metis.url}api/auth/saml/metadata`);
    expect(logged.join("\n")).toMatch(/seeding the METIS SAML provider/);

    expect(banner).toContain(
      "Sign in:   http://localhost:3000/login, button 'Microsoft Entra ID (mock)'",
    );
    expect(banner).toContain(`${metis.url}api/auth/saml/login`);
    for (const a of PRESET_ACCOUNTS) expect(banner).toContain(a.user.upn);
    expect(banner).toContain("Sign SAML response and assertion by default");
    expect(banner).toContain(idp.metadataUrl);
    expect(banner.trimEnd().endsWith(READY_LINE)).toBe(true);
  });

  it("signs each preset in by hand through the picker, under the signing option picked", async () => {
    const metis = await fakeMetis();
    const config = testConfig(metis.url);
    const { idp } = await runEntraHarness({ config });
    cleanups.push(() => idp.close());
    const samlRequest = authnRequest(config.metisApiUrl);

    const page = await (
      await fetch(`${idp.ssoUrl}?${new URLSearchParams({ SAMLRequest: samlRequest })}`)
    ).text();
    for (const a of PRESET_ACCOUNTS) expect(page).toContain(a.user.upn);

    /** @param {number} account @param {string} signing */
    const signIn = async (account, signing) => {
      const res = await fetch(idp.ssoUrl, {
        method: "POST",
        body: new URLSearchParams({ SAMLRequest: samlRequest, account: String(account), signing }),
      });
      expect(res.status).toBe(200);
      return Buffer.from(/** @type {string} */ (idp.lastResponse()), "base64").toString("utf8");
    };
    const ada = await signIn(0, "both");
    expect(ada).toContain(`<AttributeValue>${ENTRA_GROUPS.admins}</AttributeValue>`);
    expect(ada).toContain("multipleauthn");
    const max = await signIn(1, "both");
    expect(max).toContain(`<AttributeValue>${ENTRA_GROUPS.members}</AttributeValue>`);
    expect(max).not.toContain("multipleauthn");
    const olga = await signIn(2, "assertion");
    expect(olga).toContain(ENTRA_CLAIM.groupsLink);
    expect(olga).not.toContain(`Name="${ENTRA_CLAIM.groups}"`);
  });

  it("without a seed, says so and how to configure METIS by hand", async () => {
    const { idp, banner } = await runEntraHarness({
      config: testConfig(undefined, { seed: false, signing: "assertion" }),
    });
    cleanups.push(() => idp.close());
    expect(banner).toContain("METIS SAML provider: not seeded");
    expect(banner).toContain("Sign SAML assertion (Entra's default) by default");
  });

  it("closes the mock when the seed fails, freeing its port", async () => {
    const metis = await fakeMetis({ login: 503 });
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", () => resolve(undefined)));
    const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
    await new Promise((resolve) => probe.close(resolve));

    await expect(runEntraHarness({ config: testConfig(metis.url, { port }) })).rejects.toThrow(
      /admin login .* failed \(503\)/,
    );
    const again = await runEntraHarness({ config: testConfig(undefined, { port, seed: false }) });
    cleanups.push(() => again.idp.close());
    expect(new URL(again.idp.ssoUrl).port).toBe(String(port));
  });

  it("names make entra-down when its port is already in use", async () => {
    const first = await runEntraHarness({ config: testConfig(undefined, { seed: false }) });
    cleanups.push(() => first.idp.close());
    const port = Number(new URL(first.idp.ssoUrl).port);
    await expect(
      runEntraHarness({ config: testConfig(undefined, { port, seed: false }) }),
    ).rejects.toThrow(`port ${port} is in use; is the mock already up? Run make entra-down`);
  });
});

describe("formatBanner (#1559)", () => {
  it("lists each user with the role METIS gives them", () => {
    const banner = formatBanner({
      config: resolveHarnessConfig({}, []),
      metadataUrl: "http://127.0.0.1:4510/t/federationmetadata/2007-06/federationmetadata.xml",
      seeded: true,
    });
    expect(banner).toMatch(/Ada Admin\s+ada\.admin@contoso\.example\s+-> admin\s/);
    expect(banner).toMatch(/Max Member\s+max\.member@contoso\.example\s+-> developer\s/);
    expect(banner).toMatch(/Olga Overage\s+olga\.overage@contoso\.example\s+-> reader\s/);
    expect(banner).toContain("Stop:      Ctrl-C, or make entra-down");
  });
});
