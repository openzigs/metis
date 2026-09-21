import globalSetup from "../global-setup.js";

await globalSetup();

// Migrations do not seed role definitions. Durable login now requires the
// provider's role to exist. Seed the standard role only; real login creates
// the user/assignment and all production permission checks remain enabled.
const { prisma } = await import("../../server/src/lib/prisma.js");
try {
  await prisma.role.upsert({
    where: { key: "admin" },
    update: {},
    create: {
      key: "admin",
      name: "Administrator",
      description: "Full platform access.",
      isSystem: true,
    },
  });
} finally {
  await prisma.$disconnect();
}
