/**
 * Tests for connection-discovery.ts — Issue #470.
 * Verifies the integration of the scanner with the file walker and upsert logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Track upserts
const upsertedRecords: Record<string, unknown>[] = [];

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findUnique: vi.fn(async () => ({ allowCredentialScan: false })),
    },
    suggestedConnector: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        upsertedRecords.push(create);
        return { id: `sc_${upsertedRecords.length}`, ...create };
      }),
    },
  },
}));

vi.mock("../../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { discoverAndUpsertConnections } from "../../src/lib/connectors/repo/connection-discovery.js";

let tmpDir: string;

async function writeFile(relPath: string, content: string) {
  const fullPath = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
}

describe("discoverAndUpsertConnections", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-discovery-test-"));
    upsertedRecords.length = 0;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("scans properties files and upserts discovered connections", async () => {
    await writeFile(
      "application.properties",
      "spring.datasource.url=jdbc:postgresql://db-host:5432/appdb\nspring.datasource.username=user",
    );
    await writeFile("README.md", "# My Project");

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.filesScanned).toBe(1); // only .properties scanned
    expect(summary.connectionsFound).toBeGreaterThanOrEqual(1);
    expect(summary.suggestionsUpserted).toBeGreaterThanOrEqual(1);
    expect(upsertedRecords[0]).toMatchObject({
      projectId: "proj-1",
      driverType: "postgresql",
      host: "db-host",
      port: 5432,
      database: "appdb",
    });
  });

  it("scans docker-compose.yml for database images", async () => {
    await writeFile(
      "docker-compose.yml",
      ["services:", "  db:", "    image: postgres:15", "  cache:", "    image: redis:7"].join("\n"),
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.connectionsFound).toBeGreaterThanOrEqual(1);
    const pgUpsert = upsertedRecords.find((r) => r.driverType === "postgresql");
    expect(pgUpsert).toBeDefined();
  });

  it("scans .env files for connection strings", async () => {
    await writeFile(
      ".env",
      "DATABASE_URL=postgresql://user:pass@env-host:5433/envdb\nAPP_PORT=3000",
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.connectionsFound).toBeGreaterThanOrEqual(1);
    const pgUpsert = upsertedRecords.find(
      (r) => r.driverType === "postgresql" && r.host === "env-host",
    );
    expect(pgUpsert).toBeDefined();
    expect(pgUpsert!.database).toBe("envdb");
  });

  it("deduplicates connections with same host/port/database/driver", async () => {
    await writeFile(
      "src/main/resources/application.properties",
      "spring.datasource.url=jdbc:postgresql://same-host:5432/samedb",
    );
    await writeFile(
      "src/main/resources/application-dev.properties",
      "spring.datasource.url=jdbc:postgresql://same-host:5432/samedb",
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    // Both files scanned, same connection found twice, but only 1 upsert
    expect(summary.filesScanned).toBe(2);
    expect(summary.suggestionsUpserted).toBe(1);
  });

  it("skips node_modules and .git directories", async () => {
    await writeFile(
      "node_modules/some-pkg/config.properties",
      "spring.datasource.url=jdbc:postgresql://hidden:5432/db",
    );
    await writeFile(".git/config.yml", "image: postgres:15");
    await writeFile(
      "src/config.properties",
      "spring.datasource.url=jdbc:postgresql://visible:5432/db",
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.filesScanned).toBe(1);
    const visibleUpsert = upsertedRecords.find((r) => r.host === "visible");
    expect(visibleUpsert).toBeDefined();
    const hiddenUpsert = upsertedRecords.find((r) => r.host === "hidden");
    expect(hiddenUpsert).toBeUndefined();
  });

  it("returns zero summary for empty repo", async () => {
    await writeFile("README.md", "# Empty project");

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.filesScanned).toBe(0);
    expect(summary.connectionsFound).toBe(0);
    expect(summary.suggestionsUpserted).toBe(0);
  });

  it("scans Gradle files for driver dependencies", async () => {
    await writeFile(
      "build.gradle",
      [
        "dependencies {",
        "    runtimeOnly 'org.postgresql:postgresql:42.6.0'",
        "    implementation 'com.oracle.database.jdbc:ojdbc11:23.2.0.0'",
        "}",
      ].join("\n"),
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.connectionsFound).toBeGreaterThanOrEqual(2);
    expect(upsertedRecords.some((r) => r.driverType === "postgresql")).toBe(true);
    expect(upsertedRecords.some((r) => r.driverType === "oracle")).toBe(true);
  });

  it("scans XML files (persistence.xml)", async () => {
    await writeFile(
      "src/main/resources/META-INF/persistence.xml",
      [
        '<?xml version="1.0"?>',
        "<persistence>",
        '  <property name="javax.persistence.jdbc.url" value="jdbc:mysql://xml-host:3306/xmldb"/>',
        "</persistence>",
      ].join("\n"),
    );

    const summary = await discoverAndUpsertConnections("proj-1", tmpDir);
    expect(summary.connectionsFound).toBeGreaterThanOrEqual(1);
    const mysqlUpsert = upsertedRecords.find((r) => r.host === "xml-host");
    expect(mysqlUpsert).toBeDefined();
  });
});
