/**
 * #482 — rotating a vault secret someone else owns needs an explicit confirm.
 *
 * A secret's owner may already have bound it to a destination they chose
 * (`secret-binding.ts`), so an admin who rotates a real value into it sends
 * that value to the owner's host. (Since #502 a confirmed rotation also moves
 * `createdById` to the admin; see below.)
 * So the route refuses with 409 {@link VAULT_ROTATE_FOREIGN_OWNER} unless the
 * request sets `confirmForeignOwner: true`, and the refusal names the owner and
 * every resource the secret is bound to so the admin can decide.
 *
 * "Someone else" is a user other than the caller. A secret with no owner
 * (`createdById` null: system-written, or its creator was deleted) belongs to
 * no user, so rotating it is not refused.
 *
 * Bindings are the live resources that reach the secret: DB and repo connectors
 * and import sources (`secretId`), Jira connections (`secretId` /
 * `tlsCaSecretId`), and MCP servers — through the `${vault:x}` references in
 * their `envJson` / `headers` (how the importer and `routes/mcp.ts` bind them),
 * matched with the same id-or-label rule the binding check uses (`reaches`),
 * or the `envSecretId` column — and (#609) test-management connections,
 * through the `${vault:x}` refs in their `authConfigJson` / `tlsConfigJson`
 * (the same columns `secret-retirement.ts` counts as a use), matched the same
 * way. Other embedded references (notification-channel refs, BYOK) are not
 * enumerated, and the refusal says so rather than claiming the secret is
 * unbound (PR #494 review).
 *
 * #502 — the confirm is tied to what the admin was shown. The request must
 * carry `confirmedBindings`, the `{type, id, destination}` of every binding
 * listed in the 409; if the live set differs (the owner re-pointed a binding at
 * a new destination under the same id, added one or removed one in between)
 * the route refuses with 409 {@link VAULT_ROTATE_BINDINGS_CHANGED} and the
 * fresh list, and the `vault.rotate` audit row records the bindings, with
 * their destinations, that were confirmed.
 * #557 — a destination string is only a display: `driver://host:port` has no
 * database name or driver options, `url ?? command` no args or env. So each
 * binding also carries `routing`, a server-issued digest over EVERY field that
 * decides where that resource sends the secret, and the confirm must echo it:
 * the same stdio command with new args, or the same host with a new database,
 * changes the digest and refuses the confirm. The digest is an HMAC keyed off
 * the server's signing secret, because those fields can hold plaintext (an MCP
 * env value, a header) that an unkeyed hash would let a caller test guesses
 * against.
 * A confirmed rotation also transfers ownership (`createdById`) to the admin,
 * so the previous owner can no longer bind the secret, now holding the
 * admin's value, to a new destination (rule 1 of `secret-binding.ts`); their
 * existing bindings keep working where they are (rule 2).
 */
import { createHmac, hkdfSync } from "node:crypto";
import { prisma } from "../prisma.js";
import { resolveJwtSecret } from "../auth/jwt.js";
import { dbDestinationOptions } from "../connectors/destination.js";
import { reaches, refBodiesIn } from "./secret-binding.js";

export const VAULT_ROTATE_FOREIGN_OWNER = "VAULT_ROTATE_FOREIGN_OWNER";
export const VAULT_ROTATE_BINDINGS_CHANGED = "VAULT_ROTATE_BINDINGS_CHANGED";
/** #552 — the owner is binding the secret somewhere right now. */
export const VAULT_ROTATE_BINDING_IN_PROGRESS = "VAULT_ROTATE_BINDING_IN_PROGRESS";

export interface SecretOwnerView {
  id: string;
  username: string | null;
  displayName: string | null;
}

export interface SecretBindingView {
  type:
    | "db_connector"
    | "repo_connector"
    | "import_source"
    | "mcp_server"
    | "jira_connection"
    | "test_management_connection";
  id: string;
  label: string;
  projectId: string | null;
  /** Where the resource sends the secret (host, base URL, command), when known. */
  destination: string | null;
  /** #557 — opaque digest of every field that routes the secret; see {@link routingDigest}. */
  routing: string;
}

type BindingType = SecretBindingView["type"];

/**
 * #557 — the fields that decide where each kind of resource sends the secret,
 * in a fixed order. Wider than the destination string on purpose: a change to
 * any of them is a new destination for the confirm, even one the binding check
 * would not count (a non-Oracle database name), since the admin was not shown it.
 */
export const routingFields = {
  db_connector: (d: {
    driver: string;
    host: string | null;
    port: number | null;
    databaseName: string | null;
    options: string | null;
  }): unknown[] => [d.driver, d.host, d.port, d.databaseName, dbDestinationOptions(d.options)],
  repo_connector: (r: { provider: string; apiBaseUrl: string | null }): unknown[] => [
    r.provider,
    r.apiBaseUrl,
  ],
  import_source: (i: {
    source: string;
    baseUrl: string | null;
    jiraConnectionId: string | null;
    filter: string;
  }): unknown[] => [i.source, i.baseUrl, i.jiraConnectionId, i.filter],
  mcp_server: (m: {
    transport: string;
    runtime: string | null;
    command: string | null;
    args: string | null;
    url: string | null;
    headers: string | null;
    envJson: string | null;
    envSecretId: string | null;
    egressAllowlist: string | null;
  }): unknown[] => [
    m.transport,
    m.runtime,
    m.command,
    m.args,
    m.url,
    m.headers,
    m.envJson,
    m.envSecretId,
    m.egressAllowlist,
  ],
  jira_connection: (j: {
    baseUrl: string;
    proxyUrl: string | null;
    tlsRejectUnauthorized: boolean;
    tlsCaSecretId: string | null;
  }): unknown[] => [j.baseUrl, j.proxyUrl, j.tlsRejectUnauthorized, j.tlsCaSecretId],
  // #609 — `kind` picks the auth scheme and API paths sent to `baseUrl`; the
  // proxy and TLS configs decide the hop and which server is trusted.
  test_management_connection: (t: {
    kind: string;
    baseUrl: string;
    proxyConfigJson: string | null;
    tlsConfigJson: string | null;
  }): unknown[] => [t.kind, t.baseUrl, t.proxyConfigJson, t.tlsConfigJson],
} satisfies Record<BindingType, (row: never) => unknown[]>;

/**
 * #557 — the key {@link routingDigest} signs under: derived (HKDF, own label)
 * from the server's signing secret, so it is stable across instances and
 * restarts. Derive it once per listing and pass it to each digest.
 */
export function routingKey(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", resolveJwtSecret().secret, "", "metis:vault-rotate-routing:v1", 32),
  );
}

/**
 * #557 — the digest a binding's `routing` carries: HMAC-SHA256 over its type,
 * id and routing fields, under {@link routingKey}. Always 64 lowercase hex
 * characters, which is exactly what the rotate route's schema accepts back.
 */
export function routingDigest(
  type: BindingType,
  id: string,
  fields: unknown[],
  key: Buffer = routingKey(),
): string {
  return createHmac("sha256", key)
    .update(JSON.stringify([type, id, ...fields]))
    .digest("hex");
}

export interface ForeignOwnerDetails {
  secretId: string;
  owner: SecretOwnerView;
  bindings: SecretBindingView[];
}

/**
 * The live secret's owner, or null for an unknown / deleted id. #552 — with
 * the binding-write stamp (`binding-write-mark.ts`), read BEFORE the bindings
 * are listed so the rotation can be made conditional on it.
 */
export async function secretOwnerOf(id: string): Promise<{
  id: string;
  name: string;
  createdById: string | null;
  bindingWriteUntil: Date | null;
} | null> {
  return prisma.secret.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, name: true, createdById: true, bindingWriteUntil: true },
  });
}

const VAULT_REF_MARKER = "${vault:";

/** The `${vault:x}` bodies in a JSON string-map column; malformed JSON holds none. */
function refBodiesInJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? refBodiesIn(parsed as Record<string, unknown>)
      : [];
  } catch {
    return [];
  }
}

/** The owner and live bindings of a secret, for the 409 body and the UI. */
export async function describeForeignOwner(secret: {
  id: string;
  name: string;
  createdById: string;
}): Promise<ForeignOwnerDetails> {
  const [user, dbs, repos, imports, mcps, jiras, testMgmts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: secret.createdById },
      select: { username: true, displayName: true },
    }),
    prisma.databaseConnection.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: {
        id: true,
        label: true,
        projectId: true,
        driver: true,
        host: true,
        port: true,
        databaseName: true,
        options: true,
      },
    }),
    prisma.repoConnection.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: { id: true, label: true, projectId: true, provider: true, apiBaseUrl: true },
    }),
    prisma.importSource.findMany({
      where: { secretId: secret.id, deletedAt: null },
      select: {
        id: true,
        label: true,
        projectId: true,
        source: true,
        baseUrl: true,
        jiraConnectionId: true,
        filter: true,
      },
    }),
    // Candidates only: servers pointing at the id, or holding any vault ref at
    // all; `reaches` then decides which refs resolve to this secret.
    prisma.mCPServer.findMany({
      where: {
        deletedAt: null,
        OR: [
          { envSecretId: secret.id },
          { envJson: { contains: VAULT_REF_MARKER } },
          { headers: { contains: VAULT_REF_MARKER } },
        ],
      },
      select: {
        id: true,
        label: true,
        projectId: true,
        transport: true,
        runtime: true,
        command: true,
        args: true,
        url: true,
        egressAllowlist: true,
        envSecretId: true,
        envJson: true,
        headers: true,
      },
    }),
    prisma.jiraConnection.findMany({
      where: {
        deletedAt: null,
        OR: [{ secretId: secret.id }, { tlsCaSecretId: secret.id }],
      },
      select: {
        id: true,
        label: true,
        projectId: true,
        baseUrl: true,
        proxyUrl: true,
        tlsRejectUnauthorized: true,
        tlsCaSecretId: true,
      },
    }),
    // #609 — candidates only, like MCP: any connection holding a vault ref;
    // `reaches` then decides which refs resolve to this secret.
    prisma.testManagementConnection.findMany({
      where: {
        deletedAt: null,
        OR: [
          { authConfigJson: { contains: VAULT_REF_MARKER } },
          { tlsConfigJson: { contains: VAULT_REF_MARKER } },
        ],
      },
      select: {
        id: true,
        label: true,
        projectId: true,
        kind: true,
        baseUrl: true,
        authConfigJson: true,
        proxyConfigJson: true,
        tlsConfigJson: true,
      },
    }),
  ]);

  const key = routingKey();
  const bindings: SecretBindingView[] = [
    ...dbs.map((d) => ({
      type: "db_connector" as const,
      id: d.id,
      label: d.label,
      projectId: d.projectId,
      destination: d.host ? `${d.driver}://${d.host}${d.port ? `:${d.port}` : ""}` : d.driver,
      routing: routingDigest("db_connector", d.id, routingFields.db_connector(d), key),
    })),
    ...repos.map((r) => ({
      type: "repo_connector" as const,
      id: r.id,
      label: r.label,
      projectId: r.projectId,
      destination: r.apiBaseUrl ?? r.provider,
      routing: routingDigest("repo_connector", r.id, routingFields.repo_connector(r), key),
    })),
    ...imports.map((i) => ({
      type: "import_source" as const,
      id: i.id,
      label: i.label,
      projectId: i.projectId,
      destination: i.baseUrl ?? i.source,
      routing: routingDigest("import_source", i.id, routingFields.import_source(i), key),
    })),
    ...mcps
      .filter(
        (m) =>
          m.envSecretId === secret.id ||
          [...refBodiesInJson(m.envJson), ...refBodiesInJson(m.headers)].some((ref) =>
            reaches(ref, secret),
          ),
      )
      .map((m) => ({
        type: "mcp_server" as const,
        id: m.id,
        label: m.label,
        projectId: m.projectId,
        destination: m.url ?? m.command,
        routing: routingDigest("mcp_server", m.id, routingFields.mcp_server(m), key),
      })),
    ...jiras.map((j) => ({
      type: "jira_connection" as const,
      id: j.id,
      label: j.label,
      projectId: j.projectId,
      destination: j.baseUrl,
      routing: routingDigest("jira_connection", j.id, routingFields.jira_connection(j), key),
    })),
    ...testMgmts
      .filter((t) =>
        [...refBodiesInJson(t.authConfigJson), ...refBodiesInJson(t.tlsConfigJson)].some((ref) =>
          reaches(ref, secret),
        ),
      )
      .map((t) => ({
        type: "test_management_connection" as const,
        id: t.id,
        label: t.label,
        projectId: t.projectId,
        destination: t.baseUrl,
        routing: routingDigest(
          "test_management_connection",
          t.id,
          routingFields.test_management_connection(t),
          key,
        ),
      })),
  ];

  return {
    secretId: secret.id,
    owner: {
      id: secret.createdById,
      username: user?.username ?? null,
      displayName: user?.displayName ?? null,
    },
    bindings,
  };
}

/**
 * What an empty binding list means — only the kinds enumerated above were
 * checked, so it must not claim the secret is bound nowhere (PR #494 review).
 */
export const UNBOUND_NOTE =
  "No DB or repo connector, import source, MCP server, Jira or test-management connection " +
  "uses it; other references (notification channels, BYOK) were not checked.";

function whoOwns(details: ForeignOwnerDetails): string {
  return details.owner.displayName ?? details.owner.username ?? `user ${details.owner.id}`;
}

function whereBound(details: ForeignOwnerDetails): string {
  return details.bindings.length === 0
    ? UNBOUND_NOTE
    : `It is bound to ${details.bindings
        .map((b) => `${b.label}${b.destination ? ` (${b.destination})` : ""}`)
        .join(", ")}.`;
}

const TO_CONFIRM =
  "To rotate it anyway, set confirmForeignOwner and send the type, id, destination and routing of " +
  "every binding listed here as confirmedBindings; the secret then becomes yours, so they can no longer " +
  "bind it anywhere new.";

/** A one-line, human-readable refusal naming the owner and where the secret is bound. */
export function foreignOwnerMessage(details: ForeignOwnerDetails): string {
  return (
    `This secret belongs to ${whoOwns(details)}. ${whereBound(details)} Rotating it sends ` +
    `your value wherever they have bound it. ${TO_CONFIRM}`
  );
}

/** #502 — the refusal when the live bindings differ from the confirmed ids. */
export function bindingsChangedMessage(details: ForeignOwnerDetails): string {
  return (
    `The bindings of this secret, owned by ${whoOwns(details)}, changed since you confirmed. ` +
    `${whereBound(details)} Review them and confirm again. ${TO_CONFIRM}`
  );
}

/** #552 — the refusal while a binding write on the secret may still be landing. */
export function bindingInProgressMessage(details: ForeignOwnerDetails): string {
  return (
    `${whoOwns(details)} is changing where this secret is bound, so its bindings cannot be ` +
    `confirmed yet. Retry in a minute and review the bindings again. If this keeps ` +
    `happening, the owner is still binding it: disable their account first, then rotate ` +
    `once their current session has expired.`
  );
}

/**
 * #502 — one binding as the admin confirmed it: what it is and where it sends.
 * #557 — with the `routing` digest, which covers what `destination` does not show.
 */
export type ConfirmedBinding = Pick<SecretBindingView, "type" | "id" | "destination" | "routing">;

function bindingKey(b: ConfirmedBinding): string {
  return JSON.stringify([b.type, b.id, b.destination, b.routing]);
}

/** #502 — the confirmed bindings, deduplicated and in a stable order, for the audit row. */
export function canonicalBindings(bindings: ConfirmedBinding[]): ConfirmedBinding[] {
  const byKey = new Map(
    bindings.map((b) => [
      bindingKey(b),
      { type: b.type, id: b.id, destination: b.destination, routing: b.routing },
    ]),
  );
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

/**
 * #502 — do the live bindings differ from the ones the admin confirmed? A
 * binding matches only on type, id, destination AND (#557) routing digest, so
 * one re-pointed under the same id counts as changed — at a new host, and
 * equally at new args, env or database behind the same displayed destination.
 */
export function bindingsDiffer(
  details: ForeignOwnerDetails,
  confirmed: ConfirmedBinding[],
): boolean {
  const live = new Set(details.bindings.map(bindingKey));
  const shown = new Set(confirmed.map(bindingKey));
  return live.size !== shown.size || [...live].some((k) => !shown.has(k));
}
