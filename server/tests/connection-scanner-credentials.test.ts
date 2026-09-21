/**
 * Tests for connection-scanner.ts credential extraction — Issue #702.
 *
 * Verifies the OPT-IN credential extraction path:
 *   - default (no opts) → no credentials, ever
 *   - extractCredentials: true on dev file → credentials surfaced
 *   - extractCredentials: true on prod file → STILL no credentials
 *   - extractCredentials: true on ambiguous file → STILL no credentials
 */
import { describe, expect, it } from "vitest";
import { scanFileForConnections } from "../src/lib/connectors/repo/connection-scanner.js";

describe("scanFileForConnections — credential extraction", () => {
  describe("backward compatibility (no opts / opts.extractCredentials !== true)", () => {
    it("never returns credentials when called with no opts (default behaviour)", () => {
      const content = [
        "POSTGRES_USER=admin",
        "POSTGRES_PASSWORD=devpass",
        "DATABASE_URL=postgresql://admin:devpass@db:5432/app",
      ].join("\n");
      const results = scanFileForConnections("docker-compose.yml", content);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.username == null).toBe(true);
        expect(r.password == null).toBe(true);
        expect(r.devCredsDetected).toBeFalsy();
      }
    });

    it("never returns credentials when extractCredentials is explicitly false", () => {
      const content = `POSTGRES_PASSWORD=secret\nDATABASE_URL=postgresql://u:p@h:5432/d`;
      const results = scanFileForConnections("docker-compose.yml", content, {
        extractCredentials: false,
      });
      for (const r of results) {
        expect(r.password == null).toBe(true);
      }
    });
  });

  describe("dev files with extractCredentials=true", () => {
    it("extracts JDBC user-info form (jdbc:postgresql://user:pass@host/db)", () => {
      const content = `JDBC_URL=jdbc:postgresql://devuser:s3cr3t@db-host:5432/mydb`;
      const results = scanFileForConnections("application-dev.properties", content, {
        extractCredentials: true,
      });
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.username).toBe("devuser");
      expect(pg!.password).toBe("s3cr3t");
      expect(pg!.devCredsDetected).toBe(true);
      expect(pg!.credentialSourceFile).toBe("application-dev.properties");
    });

    it("extracts Spring datasource.username + datasource.password", () => {
      const content = [
        "spring.datasource.url=jdbc:postgresql://localhost:5432/mydb",
        "spring.datasource.username=appuser",
        "spring.datasource.password=spring-pw",
      ].join("\n");
      const results = scanFileForConnections("application-dev.properties", content, {
        extractCredentials: true,
      });
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.username).toBe("appuser");
      expect(pg!.password).toBe("spring-pw");
      expect(pg!.devCredsDetected).toBe(true);
    });

    it("extracts DB_USERNAME / DB_PASSWORD env vars from .env.local", () => {
      const content = [
        "DATABASE_URL=postgresql://h:5432/d",
        "DB_USERNAME=envuser",
        "DB_PASSWORD=env-pass",
      ].join("\n");
      const results = scanFileForConnections(".env.local", content, {
        extractCredentials: true,
      });
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.username).toBe("envuser");
      expect(pg!.password).toBe("env-pass");
    });

    it("extracts POSTGRES_USER/POSTGRES_PASSWORD from docker-compose.yml", () => {
      const content = [
        "services:",
        "  db:",
        "    image: postgres:15",
        "    environment:",
        "      POSTGRES_USER: pguser",
        "      POSTGRES_PASSWORD: pgpw",
      ].join("\n");
      const results = scanFileForConnections("docker-compose.yml", content, {
        extractCredentials: true,
      });
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.username).toBe("pguser");
      expect(pg!.password).toBe("pgpw");
      expect(pg!.devCredsDetected).toBe(true);
    });

    it("extracts MYSQL_USER / MYSQL_PASSWORD from docker-compose.yml", () => {
      const content = [
        "services:",
        "  db:",
        "    image: mysql:8",
        "    environment:",
        "      MYSQL_USER: appuser",
        "      MYSQL_PASSWORD: app-pw",
      ].join("\n");
      const results = scanFileForConnections("docker-compose.yml", content, {
        extractCredentials: true,
      });
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
      expect(mysql!.username).toBe("appuser");
      expect(mysql!.password).toBe("app-pw");
    });

    it("extracts ORACLE_PASSWORD from .env.development", () => {
      const content = ["ORACLE_HOST=oracle-dev", "ORACLE_USER=scott", "ORACLE_PASSWORD=tiger"].join(
        "\n",
      );
      const results = scanFileForConnections(".env.development", content, {
        extractCredentials: true,
      });
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.username).toBe("scott");
      expect(ora!.password).toBe("tiger");
    });

    it("handles quoted values", () => {
      const content = `DB_USERNAME="quoted-user"\nDB_PASSWORD='quoted pass'\nDATABASE_URL=postgresql://h/d`;
      const results = scanFileForConnections("application-test.properties", content, {
        extractCredentials: true,
      });
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.username).toBe("quoted-user");
      expect(pg!.password).toBe("quoted pass");
    });
  });

  describe("security — production files NEVER yield credentials", () => {
    it.each([
      "application-prod.properties",
      "application-production.yml",
      ".env.production",
      "docker-compose.prod.yml",
    ])("does not extract from '%s' even with extractCredentials=true", (filename) => {
      const content = [
        "DATABASE_URL=postgresql://produser:prodpass@db:5432/proddb",
        "spring.datasource.username=produser",
        "spring.datasource.password=prodpass",
        "POSTGRES_PASSWORD=prodpass",
      ].join("\n");
      const results = scanFileForConnections(filename, content, {
        extractCredentials: true,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.username == null).toBe(true);
        expect(r.password == null).toBe(true);
        expect(r.devCredsDetected).toBeFalsy();
        expect(r.credentialSourceFile == null).toBe(true);
      }
    });

    it("does not extract from ambiguous filename ('application.properties') with extractCredentials=true", () => {
      const content = [
        "spring.datasource.url=jdbc:postgresql://localhost:5432/mydb",
        "spring.datasource.username=u",
        "spring.datasource.password=p",
      ].join("\n");
      const results = scanFileForConnections("application.properties", content, {
        extractCredentials: true,
      });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.password == null).toBe(true);
      }
    });

    it("does not extract from bare '.env' (ambiguous) with extractCredentials=true", () => {
      const content = `POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nDATABASE_URL=postgresql://h:5432/d`;
      const results = scanFileForConnections(".env", content, {
        extractCredentials: true,
      });
      for (const r of results) {
        expect(r.password == null).toBe(true);
      }
    });
  });

  describe("edge cases", () => {
    it("does nothing when no connections are found, even on dev files", () => {
      const content = `# no db references here\nDB_PASSWORD=ignored`;
      const results = scanFileForConnections(".env.local", content, {
        extractCredentials: true,
      });
      expect(results).toEqual([]);
    });

    it("attaches credentialSourceFile to all returned connections from a dev file", () => {
      const content = ["DATABASE_URL=postgresql://h:5432/d", "MYSQL_HOST=m", "DB_PASSWORD=x"].join(
        "\n",
      );
      const results = scanFileForConnections("docker-compose.dev.yml", content, {
        extractCredentials: true,
      });
      expect(results.length).toBeGreaterThan(1);
      for (const r of results) {
        expect(r.credentialSourceFile).toBe("docker-compose.dev.yml");
        expect(r.devCredsDetected).toBe(true);
      }
    });

    it("extracts generic .properties password/username (e.g. asis.had.ds.password=...)", () => {
      const content = [
        "asis.had.ds.connection.url=jdbc:oracle:thin:@adhaddb1:1526/asis",
        "asis.had.ds.password=SmZCcq4gk9AYttXn78jUevKElcklFhRX",
        "datasource.username=epvpool",
      ].join("\n");
      const results = scanFileForConnections("gradle/properties/build.local.properties", content, {
        extractCredentials: true,
      });
      const oracle = results.find((r) => r.driverType === "oracle");
      expect(oracle).toBeDefined();
      expect(oracle!.username).toBe("epvpool");
      expect(oracle!.password).toBe("SmZCcq4gk9AYttXn78jUevKElcklFhRX");
      expect(oracle!.devCredsDetected).toBe(true);
    });

    it("skips VAULT:: references in generic .properties patterns", () => {
      const content = [
        "asis.had.ds.connection.url=jdbc:oracle:thin:@adhaddb1:1526/asis",
        "pv.integration.service.password=VAULT::PVIntegration::password::1",
      ].join("\n");
      const results = scanFileForConnections("gradle/properties/build.dev.properties", content, {
        extractCredentials: true,
      });
      const oracle = results.find((r) => r.driverType === "oracle");
      expect(oracle).toBeDefined();
      // VAULT:: references should NOT be extracted as plaintext passwords
      expect(oracle!.password).toBeUndefined();
    });
  });
});
