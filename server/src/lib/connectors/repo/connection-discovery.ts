/**
 * Suggested Connector Discovery — Epic #467 / Issue #470.
 *
 * Scans cloned repo files for database connection references and upserts
 * SuggestedConnector rows. Called during deep-ingest and refresh-ingest.
 *
 * Design:
 *  - Individual file scanner errors never fail the entire ingest
 *  - Deduplicates on (projectId, driverType, host, port, database)
 *  - On re-ingest, upserts existing rows (doesn't create duplicates)
 *  - Does NOT delete suggestions when a connection is removed from code
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { audit } from "../../audit/audit-service.js";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import { getVaultService } from "../../vault/vault-service.js";
import { scanFileForConnections, type DiscoveredConnection } from "./connection-scanner.js";

const log = createChildLogger("suggested-connector-discovery");

/** Extensions worth scanning for DB connection references. */
const SCANNABLE_EXTENSIONS = new Set([
  ".properties",
  ".yml",
  ".yaml",
  ".xml",
  ".env",
  ".gradle",
  ".java",
  ".kt",
  ".json",
  ".groovy",
  ".kts",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "build",
  "dist",
  "out",
  ".gradle",
  ".idea",
  ".vscode",
  "__pycache__",
  ".next",
]);

const MAX_FILES = 2000;
const MAX_FILE_SIZE = 256 * 1024; // 256 KB

export interface DiscoverySummary {
  filesScanned: number;
  connectionsFound: number;
  suggestionsUpserted: number;
  errors: number;
}

/**
 * Walk a directory yielding file paths matching scannable extensions.
 */
async function* walkScannableFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".env") continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkScannableFiles(fullPath);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      // Also include files named .env* (e.g. .env.local, .env.production)
      if (SCANNABLE_EXTENSIONS.has(ext) || entry.name.startsWith(".env")) {
        yield fullPath;
      }
    }
  }
}

/**
 * Scan a cloned repo for database connections and upsert SuggestedConnector rows.
 */
export async function discoverAndUpsertConnections(
  projectId: string,
  clonePath: string,
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = {
    filesScanned: 0,
    connectionsFound: 0,
    suggestionsUpserted: 0,
    errors: 0,
  };

  // Epic #701 / Issue #703 — credential extraction is OFF unless the
  // project owner explicitly opted in. The scanner enforces a *second*
  // gate (dev-file classifier) downstream — both must agree.
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { allowCredentialScan: true },
  });
  const extractCredentials = project?.allowCredentialScan === true;
  if (extractCredentials) {
    log.info("Dev credential extraction enabled for project", { projectId });
  }

  // Phase 1: Scan files
  const allConnections: DiscoveredConnection[] = [];
  let fileCount = 0;

  for await (const filePath of walkScannableFiles(clonePath)) {
    if (fileCount >= MAX_FILES) break;
    fileCount++;

    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = await fs.readFile(filePath, "utf-8");
      const relPath = path.relative(clonePath, filePath).split(path.sep).join("/");

      const connections = scanFileForConnections(relPath, content, { extractCredentials });
      allConnections.push(...connections);
      summary.filesScanned++;
    } catch (err) {
      // Individual file errors don't fail the entire ingest
      log.warn("Failed to scan file for connections", { filePath, error: String(err) });
      summary.errors++;
    }
  }

  summary.connectionsFound = allConnections.length;

  // Phase 2: Deduplicate — key: driverType + host + port + database
  const deduped = deduplicateConnections(allConnections);

  // Phase 3: Upsert into SuggestedConnector (with optional vault-stored creds).
  const vault = extractCredentials ? getVaultService() : null;

  for (const conn of deduped) {
    try {
      // Existing row lookup so we can reconcile any prior vault secret with
      // the freshly-scanned plaintext (idempotency requirement).
      const existing = await prisma.suggestedConnector.findUnique({
        where: {
          projectId_driverType_host_port_database: {
            projectId,
            driverType: conn.driverType,
            host: conn.host ?? "",
            port: conn.port ?? 0,
            database: conn.database ?? "",
          },
        },
        select: { id: true, passwordVaultRef: true },
      });

      // Resolve passwordVaultRef. Only touch vault when we both have a fresh
      // discovered password AND extraction is enabled (sanity: the scanner
      // is already double-gated, this is defence in depth).
      let passwordVaultRef: string | null = existing?.passwordVaultRef ?? null;
      let vaultMutated: "created" | "rotated" | "reused" | "untouched" = "untouched";
      if (vault && conn.password) {
        if (existing?.passwordVaultRef) {
          // Compare existing plaintext to the freshly discovered one. Reuse
          // if identical to keep secret-history tidy.
          let existingPlaintext: string | null = null;
          try {
            const { plaintext } = await vault.read(existing.passwordVaultRef);
            existingPlaintext = plaintext;
          } catch (err) {
            log.warn("Failed to read existing vault secret; will rotate", {
              vaultRef: existing.passwordVaultRef,
              error: String(err),
            });
          }
          if (existingPlaintext === conn.password) {
            vaultMutated = "reused";
          } else {
            await vault.rotate(existing.passwordVaultRef, conn.password);
            vaultMutated = "rotated";
          }
        } else {
          const safeHost = sanitizeLabelFragment(conn.host ?? "");
          const safeDb = sanitizeLabelFragment(conn.database ?? "");
          const label = `discovered-cred:project:${projectId}:${conn.driverType}:${safeHost}:${conn.port ?? 0}:${safeDb}`;
          const summaryRow = await vault.create(label, conn.password, "project", {
            description: `Auto-discovered dev DB password from ${conn.credentialSourceFile ?? conn.sourceFile}`,
          });
          passwordVaultRef = summaryRow.id;
          vaultMutated = "created";
        }
      }

      const upserted = await prisma.suggestedConnector.upsert({
        where: {
          projectId_driverType_host_port_database: {
            projectId,
            driverType: conn.driverType,
            host: conn.host ?? "",
            port: conn.port ?? 0,
            database: conn.database ?? "",
          },
        },
        create: {
          projectId,
          driverType: conn.driverType,
          host: conn.host ?? "",
          port: conn.port ?? 0,
          database: conn.database ?? "",
          sourceFile: conn.sourceFile,
          lineNumber: conn.lineNumber,
          confidence: conn.confidence,
          status: "pending",
          username: conn.username ?? null,
          passwordVaultRef,
          devCredsDetected: conn.devCredsDetected === true,
          credentialSourceFile: conn.credentialSourceFile ?? null,
        },
        update: {
          sourceFile: conn.sourceFile,
          lineNumber: conn.lineNumber,
          confidence: conn.confidence,
          // Don't overwrite status if user already accepted/dismissed
          // Credential fields are only written when extraction surfaced them
          // this run — otherwise we leave any prior values intact (e.g. user
          // hasn't toggled the flag off, just re-ingested).
          ...(conn.devCredsDetected
            ? {
                username: conn.username ?? null,
                passwordVaultRef,
                devCredsDetected: true,
                credentialSourceFile: conn.credentialSourceFile ?? null,
              }
            : {}),
        },
      });
      summary.suggestionsUpserted++;

      if (vault && conn.devCredsDetected) {
        // Audit emits MUST NEVER include plaintext — only metadata.
        audit({
          actor: null,
          action: "suggested_connector.credential_discovered",
          target: { type: "suggested_connector", id: upserted.id },
          metadata: {
            projectId,
            driverType: conn.driverType,
            credentialSourceFile: conn.credentialSourceFile ?? null,
            vaultMutation: vaultMutated,
            hasUsername: typeof conn.username === "string" && conn.username.length > 0,
            hasPassword: typeof conn.password === "string" && conn.password.length > 0,
          },
        });
      }
    } catch (err) {
      // SECURITY: never serialise the full `conn` — it carries the plaintext
      // `password` field when extraction is enabled. Only log non-sensitive
      // identifiers + a boolean flag indicating whether creds were attached.
      log.warn("Failed to upsert suggested connector", {
        projectId,
        driverType: conn.driverType,
        host: conn.host,
        port: conn.port,
        database: conn.database,
        sourceFile: conn.sourceFile,
        devCredsDetected: typeof conn.password === "string" && conn.password.length > 0,
        error: String(err),
      });
      summary.errors++;
    }
  }

  log.info("Connection discovery complete", { projectId, summary });
  return summary;
}

/**
 * Sanitize a fragment used in a vault label. Vault labels are dot/colon
 * delimited; database names can legally contain colons (MSSQL bracketed
 * names, SQLite paths), and discovered host strings might carry an
 * `IPv6:port`-style embedded colon — both would break label parsing /
 * trigger ambiguous collisions. Strip everything outside `[A-Za-z0-9_-]`
 * and collapse runs.
 */
function sanitizeLabelFragment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Deduplicate connections by (driverType, host, port, database).
 * Keeps the highest confidence match for each unique key.
 */
function deduplicateConnections(connections: DiscoveredConnection[]): DiscoveredConnection[] {
  const CONFIDENCE_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const map = new Map<string, DiscoveredConnection>();

  for (const conn of connections) {
    const key = `${conn.driverType}|${conn.host ?? ""}|${conn.port ?? 0}|${conn.database ?? ""}`;
    const existing = map.get(key);
    if (
      !existing ||
      (CONFIDENCE_ORDER[conn.confidence] ?? 0) > (CONFIDENCE_ORDER[existing.confidence] ?? 0)
    ) {
      map.set(key, conn);
    }
  }

  return Array.from(map.values());
}
