/**
 * Minimal seed for local development.
 *  - 4 default roles + permission set
 *  - 1 admin user (mock; real auth lands in Phase 2)
 *  - 1 sample project owned by admin
 *
 * Idempotent — safe to run multiple times.
 *
 * Issue #1385 — this file had not executed since the Prisma 7 upgrade, because
 * `pnpm db:seed` never reached it (the seed command was declared in the Prisma 6
 * location and Prisma 7 printed "No seed command configured" and exited 0). Once
 * it DID run, the bare `new PrismaClient()` here threw at construction:
 * Prisma 7 requires a driver adapter and rejects empty options outright.
 *
 * The adapter comes from `selectPrismaAdapter`, the same scheme-dispatch the
 * server itself uses (#539), so the seed targets whichever arm `DATABASE_URL`
 * names — postgres as well as the SQLite default — instead of hard-wiring one.
 * A locally-constructed client rather than the module singleton: the singleton is
 * cached on `globalThis` for hot-reload reuse, which a one-shot CLI does not want.
 */
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

import { selectPrismaAdapter } from "../src/lib/prisma.js";

const prisma = new PrismaClient({ adapter: selectPrismaAdapter() });

const ROLES = [
  { key: "admin", name: "Administrator", description: "Full platform access." },
  {
    key: "coordinator",
    name: "Coordinator",
    description: "Manages projects and publishes issues.",
  },
  { key: "developer", name: "Developer", description: "Runs analyses and drafts issues." },
  { key: "reader", name: "Reader", description: "Read-only access to assigned projects." },
] as const;

const PERMISSIONS = [
  "project.create",
  "project.read",
  "project.update",
  "project.delete",
  "document.upload",
  "document.read",
  "document.delete",
  "analysis.run",
  "analysis.read",
  "issue.draft",
  "issue.publish",
  "vault.read",
  "vault.write",
  "mcp.manage",
  "mcp.read",
  "mcp.write",
  "skill.manage",
  "agent.manage",
  "user.manage",
  "role.manage",
  "audit.read",
  // Epic #164 — admin-only runtime config (read) + FinOps + safety writes (write).
  "admin.read",
  "admin.write",
  // Epic #394 (#400) — PR-reviewer agent permissions.
  "pr.review",
  "pr.review.read",
  "pr.review.manage",
  // Epic #609 (#617) — formal review & approval workflow permissions.
  "review.create",
  "review.read",
  "review.decide",
  "review.admin",
] as const;

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
  admin: PERMISSIONS,
  coordinator: [
    "project.create",
    "project.read",
    "project.update",
    "document.upload",
    "document.read",
    "analysis.run",
    "analysis.read",
    "issue.draft",
    "issue.publish",
    "vault.read",
    "mcp.manage",
    "mcp.read",
    "mcp.write",
    "pr.review",
    "pr.review.read",
    "pr.review.manage",
    "review.create",
    "review.read",
    "review.decide",
    "review.admin",
  ],
  developer: [
    "project.read",
    "document.upload",
    "document.read",
    "analysis.run",
    "analysis.read",
    "issue.draft",
    "vault.read",
    "mcp.read",
    "pr.review",
    "pr.review.read",
    "review.create",
    "review.read",
    "review.decide",
  ],
  reader: ["project.read", "document.read", "analysis.read", "review.read"],
};

async function main(): Promise<void> {
  console.log("🌱 Seeding METIS dev database...");

  // 1. Permissions
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key, description: `Allows ${key.replace(/\./g, " ")}.` },
    });
  }

  // 2. Roles + role->permission joins
  for (const role of ROLES) {
    const created = await prisma.role.upsert({
      where: { key: role.key },
      update: { name: role.name, description: role.description, isSystem: true },
      create: { ...role, isSystem: true },
    });

    const desiredKeys = ROLE_PERMISSIONS[role.key] ?? [];
    const perms = await prisma.permission.findMany({
      where: { key: { in: [...desiredKeys] } },
    });
    for (const p of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: created.id, permissionId: p.id } },
        update: {},
        create: { roleId: created.id, permissionId: p.id },
      });
    }
  }

  // 3. Admin user (mock — no real password)
  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: { displayName: "System Admin", email: "admin@metis.local", status: "active" },
    create: {
      username: "admin",
      displayName: "System Admin",
      email: "admin@metis.local",
      status: "active",
    },
  });
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { key: "admin" } });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    update: {},
    create: { userId: admin.id, roleId: adminRole.id },
  });

  // 4. Sample project
  const project = await prisma.project.upsert({
    where: { slug: "sample-project" },
    update: {},
    create: {
      name: "Sample Project",
      slug: "sample-project",
      description: "Seeded sample project for local development.",
      status: "draft",
      createdById: admin.id,
    },
  });

  // 5. Preconfigured Atlassian MCP server (Epic #163, Issue #96).
  // Global scope so every project can ingest Confluence + Jira out of the
  // box once the operator fills in the vault refs. Disabled until the
  // operator approves it on /settings/mcp.
  const atlassianLabel = "mcp-atlassian";
  const existingAtlassian = await prisma.mCPServer.findFirst({
    where: { label: atlassianLabel, scope: "global", projectId: null, deletedAt: null },
  });
  if (!existingAtlassian) {
    await prisma.mCPServer.create({
      data: {
        scope: "global",
        projectId: null,
        label: atlassianLabel,
        transport: "stdio",
        command: "uvx",
        args: JSON.stringify(["mcp-atlassian"]),
        envJson: JSON.stringify({
          CONFLUENCE_URL: "${vault:atlassian-confluence-url}",
          CONFLUENCE_USERNAME: "${vault:atlassian-username}",
          CONFLUENCE_API_TOKEN: "${vault:atlassian-api-token}",
          JIRA_URL: "${vault:atlassian-jira-url}",
          JIRA_USERNAME: "${vault:atlassian-username}",
          JIRA_API_TOKEN: "${vault:atlassian-api-token}",
        }),
        envSecretRefs: JSON.stringify({
          CONFLUENCE_URL: "atlassian-confluence-url",
          CONFLUENCE_USERNAME: "atlassian-username",
          CONFLUENCE_API_TOKEN: "atlassian-api-token",
          JIRA_URL: "atlassian-jira-url",
          JIRA_USERNAME: "atlassian-username",
          JIRA_API_TOKEN: "atlassian-api-token",
        }),
        trustLevel: "trusted",
        defaultToolRisk: "medium",
        toolAllowlist: JSON.stringify([
          "confluence_search",
          "confluence_page",
          "jira_search",
          "jira_issue",
        ]),
        requireApproval: false,
        enabled: false,
        createdById: admin.id,
      },
    });
  }

  console.log("✅ Seed complete:", {
    roles: ROLES.map((r) => r.key),
    permissions: PERMISSIONS.length,
    users: [admin.username],
    projects: [project.slug],
  });
}

main()
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
