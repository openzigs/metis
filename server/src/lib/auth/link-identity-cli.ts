/**
 * #1395 — the administrator's way to let a second sign-in identity into an
 * existing account.
 *
 * A sign-in whose username already belongs to another provider's identity is
 * refused with `409 ACCOUNT_LINK_REQUIRED` (`login-identity.ts`), and the
 * refusal's audit event (`user.login.failed`, reason `identity_conflict:*`)
 * records the exact provider, issuer and subject that tried. A host operator
 * who has confirmed the two are the same person binds that identity here:
 *
 *   pnpm --filter @metis/server exec tsx src/lib/auth/link-identity-cli.ts \
 *     link --operator NAME --username alice --provider oidc \
 *     --issuer https://idp.example.com --subject 00u1abcd
 *
 *   pnpm --filter @metis/server exec tsx src/lib/auth/link-identity-cli.ts \
 *     list --username alice
 *
 * Host-operator only, like `role-reconciliation-cli.ts`: it needs the database,
 * not an API session, so no web request can reach it.
 */
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { getAuditService } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import { isLoginProviderKind, type ExternalIdentity } from "./login-identity.js";

const USAGE =
  "Usage: link --operator NAME --username USER --provider mock|ldap|oidc|saml --issuer ISSUER --subject SUBJECT\n" +
  "       list --username USER";

export interface IdentityRow {
  provider: string;
  issuer: string;
  subject: string;
  linkedBy: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
}

async function findUser(username: string) {
  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, deletedAt: true },
  });
  if (!user || user.deletedAt) throw new Error(`No active user named "${username}"`);
  return user;
}

export async function listIdentities(username: string): Promise<IdentityRow[]> {
  const user = await findUser(username);
  return prisma.userIdentity.findMany({
    where: { userId: user.id },
    select: {
      provider: true,
      issuer: true,
      subject: true,
      linkedBy: true,
      createdAt: true,
      lastLoginAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Bind `identity` to the user named `username`. Idempotent for the same user;
 * refuses an identity already bound to someone else — unlinking that account
 * is a separate, deliberate decision.
 */
export async function linkIdentity(input: {
  operator: string;
  username: string;
  identity: ExternalIdentity;
}): Promise<{ userId: string; created: boolean }> {
  const { operator, username, identity } = input;
  const user = await findUser(username);
  const bound = await prisma.userIdentity.findUnique({
    where: { provider_issuer_subject: identity },
    select: { userId: true },
  });
  if (bound) {
    if (bound.userId === user.id) return { userId: user.id, created: false };
    throw new Error(
      `That ${identity.provider} identity already signs in as another user (id ${bound.userId})`,
    );
  }
  await prisma.userIdentity.create({
    data: { ...identity, userId: user.id, linkedBy: operator },
  });
  // Awaited: the CLI disconnects right after, and a queued write would be lost.
  await getAuditService().recordAndFlush({
    actorId: null,
    action: "user.identity.linked",
    targetType: "user",
    targetId: user.id,
    metadata: { operator, username: user.username, ...identity },
  });
  return { userId: user.id, created: true };
}

export async function runLinkIdentityCli(args: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      operator: { type: "string" },
      username: { type: "string" },
      provider: { type: "string" },
      issuer: { type: "string" },
      subject: { type: "string" },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !values.username) throw new Error(USAGE);
  if (command === "list") return listIdentities(values.username);
  if (command !== "link") throw new Error(USAGE);
  const { operator, provider, issuer, subject } = values;
  if (!operator?.trim() || !provider || !issuer?.trim() || !subject?.trim()) {
    throw new Error(USAGE);
  }
  if (!isLoginProviderKind(provider)) throw new Error(`Unknown provider "${provider}"\n${USAGE}`);
  return linkIdentity({
    operator: operator.trim(),
    username: values.username,
    identity: { provider, issuer, subject },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runLinkIdentityCli(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Link failed"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
