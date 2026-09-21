#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI script and prints to stdout/stderr */
/**
 * `pnpm mcp:test <serverId>` — manually probe a registered MCP server.
 *
 * Workflow:
 *   1. Load the row from Prisma.
 *   2. Resolve env via the vault (so we exercise the real secret path).
 *   3. Start the lifecycle entry, run the handshake, print discovered tools.
 *   4. Stop everything and exit with code 0 on success / 1 on failure.
 */
import { setTimeout as delay } from "node:timers/promises";
import { bootstrapMCP } from "./index.js";
import { prisma } from "../prisma.js";

async function main(): Promise<number> {
  const serverId = process.argv[2];
  if (!serverId) {
    console.error("Usage: pnpm mcp:test <serverId>");
    return 1;
  }
  const row = await prisma.mCPServer.findFirst({ where: { id: serverId, deletedAt: null } });
  if (!row) {
    console.error(`MCP server ${serverId} not found`);
    return 1;
  }
  const boot = bootstrapMCP({ io: null, startHealthMonitor: false });
  try {
    const config = boot.registry.toConfig(row);
    console.log(`Probing ${config.label} (${config.transport})...`);
    const state = await boot.lifecycle.start(config);
    if (state.status !== "ready") {
      console.error(`Server failed to reach ready: ${state.status} (${state.lastError ?? ""})`);
      return 1;
    }
    const probe = await boot.lifecycle.probe(serverId);
    const snapshot = boot.lifecycle.get(serverId);
    console.log(`Status: ${state.status}`);
    console.log(`Latency: ${probe.latencyMs}ms`);
    console.log(`Tools: ${snapshot?.state.tools.length ?? 0}`);
    for (const tool of snapshot?.state.tools ?? []) {
      console.log(`  - ${tool.name} (risk=${tool.risk})`);
    }
    return probe.ok ? 0 : 1;
  } finally {
    // Give the lifecycle a moment to flush any stderr from children.
    await delay(50);
    await boot.shutdown();
    await prisma.$disconnect().catch(() => undefined);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
