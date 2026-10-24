/**
 * #1464 — evidence behind the scoped `GHSA-xcx6-jx8p-x3h5` waiver in
 * `.github/workflows/sast.yml`.
 *
 * @azure/msal-node `>=5.0.0-beta.0 <7.1.0`: the authorization-code flow may send
 * parameters to an attacker-controlled endpoint. The tree's one affected copy,
 * @azure/msal-node@5.3.0, comes from @azure/identity 4.13.1 (`^5.1.0`), which only
 * botframework-connector (Teams) pulls in. No parent accepts 7.x, so the copy is waived
 * rather than forced across two majors. The waiver rests on one claim: METIS never runs
 * MSAL's authorization-code flow — `acquireTokenByCode`, or `acquireTokenInteractive`,
 * which ends in it.
 *
 *   1. METIS's own code never imports @azure/identity or MSAL, nor names an auth-code API.
 *   2. Inside @azure/identity, only four credentials reach those APIs: the
 *      AuthorizationCode and InteractiveBrowser credentials (which METIS never builds; arm
 *      1) and the VisualStudioCode and Broker credentials of DefaultAzureCredential's chain
 *      (the one @azure/identity class botframework builds, and only for a
 *      `UserAssignedMsi` bot). Those two are inert without the @azure/identity-vscode /
 *      @azure/identity-broker plugins, which are not in the tree.
 *   3. The waived copy is still the one botframework's @azure/identity loads, and that
 *      chain is still its only route into the tree — a new consumer fails here first.
 *   4. Since #1466 a `UserAssignedMsi` installation really does build DefaultAzureCredential
 *      (before, a misspelt type fell through to app-password auth). The last test builds it
 *      through METIS's own factory and checks both auth-code credentials in the live chain
 *      are inert.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildCredentialsFactory } from "./bot-adapter.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const lockfile = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

const WAIVED_COPY = "@azure/msal-node@5.3.0";

/** MSAL entry points of the authorization-code flow, and the identity credentials over them. */
const AUTH_CODE_SURFACE =
  /\b(acquireTokenByCode|getAuthCodeUrl|acquireTokenInteractive|AuthorizationCodeCredential|InteractiveBrowserCredential|VisualStudioCodeCredential|getTokenByAuthorizationCode|getTokenByInteractiveRequest)\b/;
/** Importing either package directly would put METIS's own calls on the MSAL surface. */
const MSAL_IMPORT = /["'](@azure\/identity|@azure\/msal-node|@azure\/msal-common)(\/[^"']*)?["']/;

/** The directory of the installed package `name`, given any file resolved inside it. */
function packageRoot(resolvedFile: string, name: string): string {
  const marker = `${sep}node_modules${sep}${name.split("/").join(sep)}${sep}`;
  const at = resolvedFile.lastIndexOf(marker);
  expect(at, `${resolvedFile} is not inside ${name}`).toBeGreaterThan(-1);
  return resolvedFile.slice(0, at + marker.length - 1);
}

function versionOf(root: string): string {
  return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string })
    .version;
}

/** Follow botbuilder's own resolution, the way it loads these modules at runtime. */
const requireFromServer = createRequire(import.meta.url);
const requireFromBotbuilder = createRequire(requireFromServer.resolve("botbuilder"));
const requireFromConnector = createRequire(requireFromBotbuilder.resolve("botframework-connector"));
const identityEntry = requireFromConnector.resolve("@azure/identity");
const identityRoot = packageRoot(identityEntry, "@azure/identity");
const msalRoot = packageRoot(
  createRequire(identityEntry).resolve("@azure/msal-node"),
  "@azure/msal-node",
);

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isSource = (file: string) =>
  /\.(m|c)?[jt]sx?$/.test(file) &&
  !/\.(test|spec)\.[jt]sx?$/.test(file) &&
  !file.includes(`${sep}__tests__${sep}`);

/** METIS's shipped code: the API, the sidecar, the UI and the shared packages. */
const METIS_SOURCE_DIRS = ["server/src", "server/embeddings-svc/src", "ui", "packages"].map((d) =>
  join(REPO_ROOT, d),
);

/** Every lockfile key line that depends on `dep@version` (snapshot dependency lines). */
function dependentsOf(dep: string, version: string): string[] {
  const lines = lockfile.split("\n");
  const snapshots = lines.findIndex((l) => l === "snapshots:");
  expect(snapshots, "pnpm-lock.yaml has no snapshots section").toBeGreaterThan(-1);
  const parents = new Set<string>();
  let current = "";
  for (const line of lines.slice(snapshots + 1)) {
    if (/^ {2}\S/.test(line)) current = line.trim().replace(/:$/, "").replace(/^'|'$/g, "");
    else if (line.trim() === `'${dep}': ${version}` || line.trim() === `${dep}: ${version}`) {
      parents.add(current);
    }
  }
  return [...parents].sort();
}

describe("METIS never runs the MSAL authorization-code flow (GHSA-xcx6-jx8p-x3h5, #1464)", () => {
  it("botframework's @azure/identity still loads exactly the waived msal-node copy", () => {
    // If this moves, the waiver's `packages` scope is stale: re-check the advisory, and
    // delete the waiver once a patched (>=7.1.0) copy is what loads.
    expect(`@azure/msal-node@${versionOf(msalRoot)}`).toBe(WAIVED_COPY);
  });

  it("the waived copy reaches the tree only through @azure/identity, and that only via botframework", () => {
    expect(dependentsOf("@azure/msal-node", "5.3.0")).toEqual([
      `@azure/identity@${versionOf(identityRoot)}`,
    ]);
    const identityParents = dependentsOf("@azure/identity", versionOf(identityRoot));
    expect(identityParents.length, "nothing depends on @azure/identity").toBeGreaterThan(0);
    for (const parent of identityParents) expect(parent).toMatch(/^botframework-connector@/);
  });

  it("METIS's own source never imports @azure/identity or MSAL, nor names an auth-code API", () => {
    const files = METIS_SOURCE_DIRS.flatMap((dir) => walk(dir, isSource));
    expect(files.length, "the source scan found nothing to scan").toBeGreaterThan(100);
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const hit = MSAL_IMPORT.exec(text)?.[0] ?? AUTH_CODE_SURFACE.exec(text)?.[0];
      return hit ? [`${relative(REPO_ROOT, file)}: ${hit}`] : [];
    });
    expect(offenders).toEqual([]);
  });

  it("inside @azure/identity, only the four known credentials reach the auth-code APIs", () => {
    const dist = join(identityRoot, "dist", "commonjs");
    const credentials = walk(join(dist, "credentials"), (f) => f.endsWith(".js"))
      .filter((f) =>
        /\b(getTokenByAuthorizationCode|getTokenByInteractiveRequest|getBrokeredToken|acquireTokenByCode|acquireTokenInteractive)\b/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map((f) => relative(dist, f).split(sep).join("/"))
      .sort();
    expect(credentials).toEqual([
      "credentials/authorizationCodeCredential.js",
      "credentials/brokerCredential.js",
      "credentials/interactiveBrowserCredential.js",
      "credentials/visualStudioCodeCredential.js",
    ]);
  });

  it("the plugins that arm DefaultAzureCredential's VS Code and broker credentials are absent", () => {
    // Without them the VS Code credential has no MSAL client and the broker credential is
    // unavailable, so DefaultAzureCredential's chain never reaches acquireTokenInteractive.
    for (const plugin of ["@azure/identity-vscode", "@azure/identity-broker"]) {
      expect(lockfile.includes(`${plugin}@`), `${plugin} entered the tree`).toBe(false);
    }
  });

  it("on the managed-identity path METIS now reaches (#1466), both auth-code credentials are inert", async () => {
    // Before #1466 METIS misspelt the type, so botbuilder never built a
    // DefaultAzureCredential. Build one the way a UserAssignedMsi bot now does and look
    // at the chain it actually runs. The default chain is the widest one: an operator
    // narrowing it with AZURE_TOKEN_CREDENTIALS can only remove credentials.
    const saved = process.env.AZURE_TOKEN_CREDENTIALS;
    delete process.env.AZURE_TOKEN_CREDENTIALS;
    try {
      const appId = "99999999-8888-7777-6666-555555555555";
      const credentials = (await buildCredentialsFactory({
        appId,
        appPassword: "",
        appType: "UserAssignedMsi",
        tenantId: "tenant-1",
      }).createCredentials(
        appId,
        "https://api.botframework.com",
        "https://login.microsoftonline.com/botframework.com",
        true,
      )) as unknown as { authenticator: { tokenProvider: { _sources: object[] } } };
      const identity = requireFromConnector("@azure/identity") as {
        DefaultAzureCredential: new (...args: never[]) => unknown;
        VisualStudioCodeCredential: new (...args: never[]) => unknown;
      };
      const provider = credentials.authenticator.tokenProvider;
      expect(provider).toBeInstanceOf(identity.DefaultAzureCredential);

      const chain = provider._sources.map((c) => c.constructor.name);
      // The broker credential's constructor throws without @azure/identity-broker, so the
      // chain holds a stand-in that only ever reports itself unavailable.
      expect(chain).not.toContain("BrokerCredential");
      expect(chain).toContain("UnavailableDefaultCredential");

      // The VS Code credential is built, but refuses before reaching MSAL: no plugin.
      const vscode = provider._sources.find(
        (c) => c instanceof identity.VisualStudioCodeCredential,
      ) as { getToken(scope: string): Promise<unknown> } | undefined;
      expect(vscode, "DefaultAzureCredential no longer builds a VS Code credential").toBeDefined();
      await expect(vscode!.getToken("https://api.botframework.com/.default")).rejects.toMatchObject(
        { name: "CredentialUnavailableError" },
      );
    } finally {
      if (saved === undefined) delete process.env.AZURE_TOKEN_CREDENTIALS;
      else process.env.AZURE_TOKEN_CREDENTIALS = saved;
    }
  });
});
