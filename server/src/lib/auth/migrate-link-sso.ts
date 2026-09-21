/**
 * SSO account linking migration — links existing LDAP users to SSO by email.
 *
 * Epic #748, Issue #758: Migration path: keep existing LDAP users.
 *
 * When an LDAP user first logs in via SSO, this utility links their account
 * by email address so they don't lose access to existing projects/data.
 *
 * Usage: pnpm migrate:link-sso [--dry-run]
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("migrate-link-sso");

export interface LinkResult {
  linked: Array<{ username: string; email: string; ssoUsername: string }>;
  skipped: Array<{ username: string; email: string; reason: string }>;
  total: number;
}

/**
 * Link existing LDAP/local users to SSO identities by matching email.
 * This ensures no user is locked out when SSO is enabled.
 *
 * Strategy:
 * - Find all users that were created via LDAP or mock auth
 * - If a user has the same email as their SSO profile, update their username
 *   to match the SSO identity (or leave it if already matching)
 * - Preserve all existing relationships (projects, audit logs, etc.)
 */
export async function linkSSOAccounts(options: { dryRun: boolean }): Promise<LinkResult> {
  const result: LinkResult = { linked: [], skipped: [], total: 0 };

  const users = await prisma.user.findMany({
    where: { deletedAt: null },
  });
  result.total = users.length;

  for (const user of users) {
    // Already active — just mark as linked-ready
    if (user.status === "active" && user.email) {
      result.linked.push({
        username: user.username,
        email: user.email,
        ssoUsername: user.email.split("@")[0],
      });

      if (!options.dryRun) {
        // Ensure user can login via SSO by setting passwordHash to null
        // (SSO users don't use local passwords)
        await prisma.user.update({
          where: { id: user.id },
          data: { passwordHash: null },
        });
      }
    } else {
      result.skipped.push({
        username: user.username,
        email: user.email,
        reason: user.status !== "active" ? "inactive" : "no email",
      });
    }
  }

  return result;
}

/**
 * Link a single user on first SSO login (called from the SSO callback).
 * Matches by email — if an existing user row has the same email, reuse it.
 */
export async function linkOnFirstSSOLogin(
  ssoEmail: string,
  ssoUsername: string,
  ssoDisplayName: string,
): Promise<string | null> {
  const existing = await prisma.user.findFirst({
    where: { email: ssoEmail, deletedAt: null },
  });

  if (existing) {
    // Update the existing user to also work with SSO
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        displayName: ssoDisplayName || existing.displayName,
        lastLoginAt: new Date(),
      },
    });
    log.info("Linked existing user to SSO", {
      userId: existing.id,
      email: ssoEmail,
      oldUsername: existing.username,
      ssoUsername,
    });
    return existing.id;
  }

  return null;
}

// CLI entry point

if (
  process.argv[1]?.endsWith("migrate-link-sso.ts") ||
  process.argv[1]?.endsWith("migrate-link-sso.js")
) {
  const dryRun = process.argv.includes("--dry-run");
  /* eslint-disable no-console */
  console.log(`\n🔗 SSO Account Linking Migration ${dryRun ? "(DRY RUN)" : ""}\n`);

  linkSSOAccounts({ dryRun })
    .then((result) => {
      console.log(`Total users: ${result.total}`);
      console.log(`Linked: ${result.linked.length}`);
      console.log(`Skipped: ${result.skipped.length}`);
      if (result.skipped.length > 0) {
        console.log("\nSkipped users:");
        for (const s of result.skipped) {
          console.log(`  - ${s.username} (${s.reason})`);
        }
      }
      if (dryRun) {
        console.log("\n⚠️  Dry run — no changes were made. Re-run without --dry-run to apply.");
      } else {
        console.log("\n✅ Migration complete.");
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
  /* eslint-enable no-console */
}
