import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import base from "../playwright.config.js";

// Playwright starts webServers BEFORE globalSetup. The base setup deletes the
// SQLite file, so running it after API startup strands the open DB connection.
// Reuse the existing setup + webServers, but reset/migrate BEFORE starting API.
// Scoped to these specs; no change to the shared suite or its auth settings.
const servers = base.webServer;
if (!Array.isArray(servers) || servers.length !== 2) {
  throw new Error("Manual approval suite requires both isolated Playwright webServers");
}
const bootstrap = fileURLToPath(new URL("./manual-approval-setup.ts", import.meta.url));

export default defineConfig({
  ...base,
  testDir: fileURLToPath(new URL("../tests", import.meta.url)),
  outputDir: fileURLToPath(new URL("../test-results", import.meta.url)),
  globalSetup: undefined,
  webServer: [
    {
      ...servers[0],
      command: `pnpm --filter @metis/server exec tsx ${JSON.stringify(bootstrap)} && ${servers[0].command}`,
    },
    servers[1],
  ],
});
