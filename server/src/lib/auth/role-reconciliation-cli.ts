import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { inspectRolesForHost, confirmRolesForHost } from "./role-reconciliation-host.js";
import { reconciliationSchema, reconciliationTargetSchema } from "./role-reconciliation.js";
import { prisma } from "../prisma.js";

export async function runRoleReconciliationCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      operator: { type: "string" },
      "target-id": { type: "string" },
      username: { type: "string" },
      "expected-fingerprint": { type: "string" },
      "request-id": { type: "string" },
      decision: { type: "string" },
      reason: { type: "string" },
      confirm: { type: "string" },
      "acknowledge-host-authority": { type: "boolean" },
    },
  });
  if (
    positionals.length !== 1 ||
    !["inspect", "confirm"].includes(positionals[0]) ||
    !values.operator ||
    !values["acknowledge-host-authority"]
  ) {
    throw new Error(
      "Usage: inspect|confirm --operator NAME --acknowledge-host-authority --target-id ID --username USER; confirm also requires --expected-fingerprint HASH --request-id UUID --decision provider-managed|keep-explicit|revoked --reason REASON --confirm ID:USER:DECISION",
    );
  }
  const target = reconciliationTargetSchema.parse({
    targetId: values["target-id"],
    username: values.username,
  });
  if (positionals[0] === "inspect") return inspectRolesForHost(values.operator, target);
  const input = reconciliationSchema.parse({
    ...target,
    expectedFingerprint: values["expected-fingerprint"],
    requestId: values["request-id"],
    decision: values.decision,
    reason: values.reason,
  });
  return confirmRolesForHost(values.operator, input, values.confirm ?? "");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(
      `${JSON.stringify(await runRoleReconciliationCli(process.argv.slice(2)), null, 2)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Reconciliation failed"}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
