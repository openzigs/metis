/**
 * Backfill script — assigns every existing project to a "Default" workspace.
 *
 * Usage: npx tsx scripts/backfill-workspaces.ts
 *
 * Idempotent — running again after the Default workspace exists is a no-op.
 */
/* eslint-disable no-console */
import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  try {
    // Upsert the Default workspace
    let workspace = await prisma.workspace.findFirst({
      where: { slug: "default" },
    });

    if (!workspace) {
      workspace = await prisma.workspace.create({
        data: {
          name: "Default",
          slug: "default",
        },
      });
      console.log(`Created Default workspace: ${workspace.id}`);
    } else {
      console.log(`Default workspace already exists: ${workspace.id}`);
    }

    // Assign all projects without a workspace to the Default workspace
    const result = await prisma.project.updateMany({
      where: { workspaceId: null },
      data: { workspaceId: workspace.id },
    });

    console.log(`Assigned ${result.count} project(s) to Default workspace`);

    // Make the first admin user an owner of the Default workspace
    const adminUser = await prisma.user.findFirst({
      where: {
        roles: { some: { role: { key: "admin" } } },
        deletedAt: null,
      },
      orderBy: { createdAt: "asc" },
    });

    if (adminUser) {
      const existing = await prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: workspace.id,
            userId: adminUser.id,
          },
        },
      });

      if (!existing) {
        await prisma.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: adminUser.id,
            role: "owner",
          },
        });
        console.log(`Added admin user ${adminUser.username} as workspace owner`);
      }
    }

    console.log("Backfill complete.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
