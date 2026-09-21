/**
 * Tests for connection-scanner.ts — Issue #468.
 * Covers JDBC URLs, Spring Boot configs, Docker Compose, env vars,
 * persistence.xml, and Gradle/Maven dependencies.
 */
import { describe, expect, it } from "vitest";
import { scanFileForConnections } from "../src/lib/connectors/repo/connection-scanner.js";

describe("scanFileForConnections", () => {
  // ---------- JDBC URLs ---------------------------------------------------

  describe("JDBC URLs", () => {
    it("detects PostgreSQL JDBC URL", () => {
      const content = `spring.datasource.url=jdbc:postgresql://db-host:5432/mydb`;
      const results = scanFileForConnections("application.properties", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.host === "db-host");
      expect(pg).toBeDefined();
      expect(pg!.port).toBe(5432);
      expect(pg!.database).toBe("mydb");
      expect(pg!.confidence).toBe("high");
    });

    it("detects PostgreSQL JDBC URL with default port", () => {
      const content = `url=jdbc:postgresql://localhost/testdb`;
      const results = scanFileForConnections("config.properties", content);
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.host).toBe("localhost");
      expect(pg!.port).toBe(5432);
      expect(pg!.database).toBe("testdb");
    });

    it("detects MySQL JDBC URL", () => {
      const content = `jdbc:mysql://mysql-server:3307/appdb?useSSL=true`;
      const results = scanFileForConnections("app.conf", content);
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
      expect(mysql!.host).toBe("mysql-server");
      expect(mysql!.port).toBe(3307);
      expect(mysql!.database).toBe("appdb");
    });

    it("detects Oracle thin JDBC URL (service name format with double slash)", () => {
      const content = `jdbc:oracle:thin:@//oracle-host:1521/ORCL`;
      const results = scanFileForConnections("datasource.xml", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.host).toBe("oracle-host");
      expect(ora!.port).toBe(1521);
      expect(ora!.database).toBe("ORCL");
      expect(ora!.confidence).toBe("high");
    });

    it("detects Oracle thin JDBC URL (service name format without double slash)", () => {
      // Common in JBoss/WildFly .properties files: jdbc:oracle:thin:@host:port/service
      const content = `asis.had.ds.connection.url=jdbc:oracle:thin:@a1haddb1:1526/asis`;
      const results = scanFileForConnections("build.dev.properties", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.host).toBe("a1haddb1");
      expect(ora!.port).toBe(1526);
      expect(ora!.database).toBe("asis");
      expect(ora!.confidence).toBe("high");
    });

    it("detects Oracle thin JDBC URL (SID format) and strips credentials", () => {
      const content = `jdbc:oracle:thin:scott/tiger@db-host:1522:PROD`;
      const results = scanFileForConnections("config.java", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.host).toBe("db-host");
      expect(ora!.port).toBe(1522);
      expect(ora!.database).toBe("PROD");
      // No credential fields in the interface — security by design
    });

    it("detects SQL Server JDBC URL with databaseName", () => {
      const content = `jdbc:sqlserver://sql-host:1433;databaseName=AppDB;encrypt=true`;
      const results = scanFileForConnections("db.properties", content);
      const ss = results.find((r) => r.driverType === "sqlserver" && r.database === "AppDB");
      expect(ss).toBeDefined();
      expect(ss!.host).toBe("sql-host");
      expect(ss!.port).toBe(1433);
    });

    it("detects SQL Server JDBC URL without databaseName", () => {
      const content = `jdbc:sqlserver://sqlsrv-host:1434`;
      const results = scanFileForConnections("config.xml", content);
      const ss = results.find((r) => r.driverType === "sqlserver");
      expect(ss).toBeDefined();
      expect(ss!.host).toBe("sqlsrv-host");
      expect(ss!.port).toBe(1434);
      expect(ss!.database).toBeNull();
    });

    it("detects SQLite JDBC URL", () => {
      const content = `jdbc:sqlite:/data/app.db`;
      const results = scanFileForConnections("build.gradle", content);
      const sq = results.find((r) => r.driverType === "sqlite");
      expect(sq).toBeDefined();
      expect(sq!.host).toBeNull();
      expect(sq!.port).toBeNull();
      expect(sq!.database).toBe("/data/app.db");
    });
  });

  // ---------- DATABASE_URL-style patterns ---------------------------------

  describe("DATABASE_URL patterns", () => {
    it("detects postgresql:// connection string", () => {
      const content = `DATABASE_URL=postgresql://user:pass@pghost:5433/proddb`;
      const results = scanFileForConnections(".env", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.host === "pghost");
      expect(pg).toBeDefined();
      expect(pg!.port).toBe(5433);
      expect(pg!.database).toBe("proddb");
      expect(pg!.confidence).toBe("high");
    });

    it("detects postgres:// connection string (alias)", () => {
      const content = `export DB_URL=postgres://admin:secret@rds-host/analytics`;
      const results = scanFileForConnections(".env.local", content);
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.host).toBe("rds-host");
      expect(pg!.port).toBe(5432);
      expect(pg!.database).toBe("analytics");
    });

    it("detects mysql:// connection string", () => {
      const content = `MYSQL_URL=mysql://root:pass@mysql-host:3308/shop`;
      const results = scanFileForConnections(".env", content);
      const mysql = results.find((r) => r.driverType === "mysql" && r.host === "mysql-host");
      expect(mysql).toBeDefined();
      expect(mysql!.port).toBe(3308);
      expect(mysql!.database).toBe("shop");
    });
  });

  // ---------- Spring Boot properties/yaml ---------------------------------

  describe("Spring Boot properties", () => {
    it("detects spring.datasource.url in properties file", () => {
      const content = [
        "server.port=8080",
        "spring.datasource.url=jdbc:postgresql://spring-host:5432/springdb",
        "spring.datasource.username=user",
      ].join("\n");
      const results = scanFileForConnections("application.properties", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.host === "spring-host");
      expect(pg).toBeDefined();
      expect(pg!.lineNumber).toBe(2);
    });

    it("detects spring.datasource.driver-class-name", () => {
      const content = `spring.datasource.driver-class-name=org.postgresql.Driver`;
      const results = scanFileForConnections("application.properties", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.confidence === "medium");
      expect(pg).toBeDefined();
    });

    it("detects Oracle driver class", () => {
      const content = `spring.datasource.driver-class-name: oracle.jdbc.OracleDriver`;
      const results = scanFileForConnections("application.yml", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.confidence).toBe("medium");
    });
  });

  // ---------- Docker Compose images ---------------------------------------

  describe("Docker Compose images", () => {
    it("detects postgres image", () => {
      const content = [
        "services:",
        "  db:",
        "    image: postgres:15-alpine",
        "    ports:",
        '      - "5432:5432"',
      ].join("\n");
      const results = scanFileForConnections("docker-compose.yml", content);
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.confidence).toBe("medium");
      expect(pg!.port).toBe(5432);
      expect(pg!.lineNumber).toBe(3);
    });

    it("detects mysql image", () => {
      const content = `    image: mysql:8.0`;
      const results = scanFileForConnections("docker-compose.yml", content);
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
      expect(mysql!.port).toBe(3306);
    });

    it("detects mariadb image as mysql driver", () => {
      const content = `    image: mariadb:10.11`;
      const results = scanFileForConnections("docker-compose.yml", content);
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
    });

    it("detects mssql image", () => {
      const content = `    image: mcr.microsoft.com/mssql/server:2022-latest`;
      const results = scanFileForConnections("docker-compose.yml", content);
      const ss = results.find((r) => r.driverType === "sqlserver");
      expect(ss).toBeDefined();
      expect(ss!.port).toBe(1433);
    });

    it("detects oracle image", () => {
      const content = `    image: oraclelinux/oracle-xe:21.3.0`;
      const results = scanFileForConnections("docker-compose.yml", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
    });
  });

  // ---------- Env var patterns --------------------------------------------

  describe("Env var patterns", () => {
    it("detects DB_HOST with postgresql driver hint", () => {
      const content = `PGHOST=pg-server.internal`;
      const results = scanFileForConnections(".env", content);
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.host).toBe("pg-server.internal");
      expect(pg!.confidence).toBe("medium");
    });

    it("detects MYSQL_HOST", () => {
      const content = `MYSQL_HOST=mysql.cluster.local`;
      const results = scanFileForConnections(".env", content);
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
      expect(mysql!.host).toBe("mysql.cluster.local");
    });

    it("detects DATABASE_URL with embedded postgres URL", () => {
      const content = `DATABASE_URL=postgres://u:p@envhost:5432/envdb`;
      const results = scanFileForConnections(".env.production", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.host === "envhost");
      expect(pg).toBeDefined();
      expect(pg!.database).toBe("envdb");
      expect(pg!.confidence).toBe("high");
    });
  });

  // ---------- Gradle/Maven dependencies -----------------------------------

  describe("Gradle/Maven dependencies", () => {
    it("detects PostgreSQL Gradle dependency", () => {
      const content = `    runtimeOnly 'org.postgresql:postgresql:42.6.0'`;
      const results = scanFileForConnections("build.gradle", content);
      const pg = results.find((r) => r.driverType === "postgresql");
      expect(pg).toBeDefined();
      expect(pg!.confidence).toBe("low");
      expect(pg!.host).toBeNull();
    });

    it("detects MySQL Maven dependency", () => {
      const content = `    <artifactId>mysql-connector-java</artifactId>`;
      const results = scanFileForConnections("pom.xml", content);
      const mysql = results.find((r) => r.driverType === "mysql");
      expect(mysql).toBeDefined();
      expect(mysql!.confidence).toBe("low");
    });

    it("detects Oracle JDBC Gradle dependency", () => {
      const content = `    implementation 'com.oracle.database.jdbc:ojdbc11:23.2.0.0'`;
      const results = scanFileForConnections("build.gradle.kts", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.confidence).toBe("low");
    });

    it("detects SQL Server Maven dependency", () => {
      const content = `    <artifactId>mssql-jdbc</artifactId>`;
      const results = scanFileForConnections("pom.xml", content);
      const ss = results.find((r) => r.driverType === "sqlserver");
      expect(ss).toBeDefined();
    });
  });

  // ---------- persistence.xml ---------------------------------------------

  describe("persistence.xml", () => {
    it("detects javax.persistence.jdbc.url property", () => {
      const content = [
        '<?xml version="1.0"?>',
        "<persistence>",
        "  <persistence-unit>",
        '    <property name="javax.persistence.jdbc.url" value="jdbc:postgresql://persist-host:5432/persistdb"/>',
        "  </persistence-unit>",
        "</persistence>",
      ].join("\n");
      const results = scanFileForConnections("persistence.xml", content);
      const pg = results.find((r) => r.driverType === "postgresql" && r.host === "persist-host");
      expect(pg).toBeDefined();
      expect(pg!.database).toBe("persistdb");
      expect(pg!.confidence).toBe("high");
    });

    it("detects hibernate.connection.url property", () => {
      const content = `<property name="hibernate.connection.url" value="jdbc:mysql://hib-host:3306/hibdb"/>`;
      const results = scanFileForConnections("hibernate.cfg.xml", content);
      const mysql = results.find((r) => r.driverType === "mysql" && r.host === "hib-host");
      expect(mysql).toBeDefined();
    });

    it("detects hibernate.connection.driver_class property", () => {
      const content = `<property name="hibernate.connection.driver_class" value="oracle.jdbc.OracleDriver"/>`;
      const results = scanFileForConnections("persistence.xml", content);
      const ora = results.find((r) => r.driverType === "oracle");
      expect(ora).toBeDefined();
      expect(ora!.confidence).toBe("medium");
    });
  });

  // ---------- Edge cases & security ---------------------------------------

  describe("edge cases and security", () => {
    it("returns empty array for empty content", () => {
      expect(scanFileForConnections("empty.txt", "")).toEqual([]);
    });

    it("returns empty array for non-matching content", () => {
      const content = "console.log('hello world');\nconst x = 42;";
      expect(scanFileForConnections("app.ts", content)).toEqual([]);
    });

    it("never includes credentials in results (by interface design)", () => {
      const content = `jdbc:oracle:thin:admin/s3cr3t@host:1521:DB`;
      const results = scanFileForConnections("config.java", content);
      // The DiscoveredConnection interface has no user/password fields
      for (const r of results) {
        const keys = Object.keys(r);
        expect(keys).not.toContain("username");
        expect(keys).not.toContain("password");
        expect(keys).not.toContain("user");
        expect(keys).not.toContain("pass");
        // Host should not contain credentials
        if (r.host) {
          expect(r.host).not.toContain("admin");
          expect(r.host).not.toContain("s3cr3t");
        }
      }
    });

    it("reports correct line numbers", () => {
      const content = [
        "# Config",
        "",
        "DB_HOST=myhost",
        "",
        "spring.datasource.url=jdbc:postgresql://linehost:5432/linedb",
      ].join("\n");
      const results = scanFileForConnections("config.properties", content);
      const pgLine = results.find((r) => r.host === "linehost");
      expect(pgLine).toBeDefined();
      expect(pgLine!.lineNumber).toBe(5);
    });

    it("detects multiple connections in one file", () => {
      const content = [
        "jdbc:postgresql://pg:5432/pgdb",
        "jdbc:mysql://my:3306/mydb",
        "jdbc:oracle:thin:@//ora:1521/oradb",
      ].join("\n");
      const results = scanFileForConnections("multi.properties", content);
      expect(results.length).toBeGreaterThanOrEqual(3);
      expect(results.some((r) => r.driverType === "postgresql")).toBe(true);
      expect(results.some((r) => r.driverType === "mysql")).toBe(true);
      expect(results.some((r) => r.driverType === "oracle")).toBe(true);
    });

    it("preserves sourceFile in results", () => {
      const content = `jdbc:postgresql://x:5432/db`;
      const results = scanFileForConnections("path/to/file.yml", content);
      expect(results[0].sourceFile).toBe("path/to/file.yml");
    });
  });
});
