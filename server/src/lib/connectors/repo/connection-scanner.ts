/**
 * Connection String Scanner — Epic #467 / Issue #468, extended for #702.
 *
 * Scans source files for database connection references (JDBC URLs, Spring
 * datasource configs, Docker Compose services, env vars, etc.) and returns
 * structured DiscoveredConnection objects.
 *
 * SECURITY (default behaviour): NEVER returns credentials. User/password
 * fragments are stripped from JDBC URLs and other patterns.
 *
 * SECURITY (opt-in): Callers may pass `{ extractCredentials: true }` to
 * additionally surface dev-environment credentials, but ONLY when the file
 * passes `classifyDevFile()` (see ./dev-file-classifier.ts). Even with
 * the opt-in flag set, production-pattern files always return without
 * credentials. The boundary is double-gated:
 *   1. caller flag,
 *   2. file classifier,
 * so missing either gate falls back to the original safe behaviour.
 */

import { classifyDevFile } from "./dev-file-classifier.js";

export type DriverType = "oracle" | "postgresql" | "mysql" | "sqlserver" | "sqlite";
export type Confidence = "high" | "medium" | "low";

export interface DiscoveredConnection {
  driverType: DriverType;
  host: string | null;
  port: number | null;
  database: string | null;
  sourceFile: string;
  lineNumber: number;
  confidence: Confidence;
  /** Discovered username (only populated when extractCredentials gating allows). */
  username?: string | null;
  /** Discovered plaintext password (only populated when extractCredentials gating allows). */
  password?: string | null;
  /** True when credentials were extracted from a recognised dev-pattern file. */
  devCredsDetected?: boolean;
  /** Source file the credentials came from (mirrors sourceFile for now, kept for forward-compat). */
  credentialSourceFile?: string | null;
}

export interface ScanOptions {
  /**
   * Opt-in flag to extract dev credentials. Defaults to `false` for
   * backward compatibility with existing callers.
   */
  extractCredentials?: boolean;
}

// ---- JDBC URL Patterns -------------------------------------------------------

const JDBC_PATTERNS: Array<{
  regex: RegExp;
  driver: DriverType;
  extract: (match: RegExpExecArray) => {
    host: string | null;
    port: number | null;
    database: string | null;
  };
}> = [
  // Oracle thin: jdbc:oracle:thin:@//host:port/service (new style with double slash)
  // Also handles jdbc:oracle:thin:user/pass@//host:port/service
  {
    regex: /jdbc:oracle:thin:(?:[^@]*@)?\/\/([^:/]+)(?::(\d+))?\/([^\s"',;]+)/i,
    driver: "oracle",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 1521, database: m[3] }),
  },
  // Oracle thin: jdbc:oracle:thin:@host:port/service (new style without double slash)
  // e.g. jdbc:oracle:thin:@a1haddb1:1526/asis
  {
    regex: /jdbc:oracle:thin:(?:[^@]*@)?([^:/\s"',;]+):(\d+)\/([^\s"',;]+)/i,
    driver: "oracle",
    extract: (m) => ({ host: m[1], port: parseInt(m[2], 10), database: m[3] }),
  },
  // Oracle thin: jdbc:oracle:thin:@host:port:sid (classic SID format)
  // Also handles jdbc:oracle:thin:user/pass@host:port:sid
  {
    regex: /jdbc:oracle:thin:(?:[^@]*@)?([^:/\s"',;]+):(\d+):([^\s"',;/]+)/i,
    driver: "oracle",
    extract: (m) => ({ host: m[1], port: parseInt(m[2], 10), database: m[3] }),
  },
  // PostgreSQL: jdbc:postgresql://host:port/database
  {
    regex: /jdbc:postgresql:\/\/([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "postgresql",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 5432, database: m[3] }),
  },
  // MySQL: jdbc:mysql://host:port/database
  {
    regex: /jdbc:mysql:\/\/([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "mysql",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 3306, database: m[3] }),
  },
  // SQL Server: jdbc:sqlserver://host:port;databaseName=db
  {
    regex: /jdbc:sqlserver:\/\/([^:;]+)(?::(\d+))?(?:;[^;]*)*;databaseName=([^\s"';,]+)/i,
    driver: "sqlserver",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 1433, database: m[3] }),
  },
  // SQL Server without databaseName
  {
    regex: /jdbc:sqlserver:\/\/([^:;]+)(?::(\d+))?/i,
    driver: "sqlserver",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 1433, database: null }),
  },
  // SQLite: jdbc:sqlite:path
  {
    regex: /jdbc:sqlite:([^\s"',;]+)/i,
    driver: "sqlite",
    extract: (m) => ({ host: null, port: null, database: m[1] }),
  },
];

// ---- DATABASE_URL / connection string patterns (non-JDBC) --------------------

const DATABASE_URL_PATTERNS: Array<{
  regex: RegExp;
  driver: DriverType;
  extract: (match: RegExpExecArray) => {
    host: string | null;
    port: number | null;
    database: string | null;
  };
}> = [
  // postgresql://user:pass@host:port/database
  {
    regex: /postgresql:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "postgresql",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 5432, database: m[3] }),
  },
  // postgres://user:pass@host:port/database
  {
    regex: /postgres:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "postgresql",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 5432, database: m[3] }),
  },
  // mysql://user:pass@host:port/database
  {
    regex: /mysql:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "mysql",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 3306, database: m[3] }),
  },
  // sqlserver://user:pass@host:port/database
  {
    regex: /sqlserver:\/\/(?:[^@]+@)?([^:/]+)(?::(\d+))?\/([^\s"'?,;]+)/i,
    driver: "sqlserver",
    extract: (m) => ({ host: m[1], port: m[2] ? parseInt(m[2], 10) : 1433, database: m[3] }),
  },
];

// ---- Spring Boot properties/yaml patterns ------------------------------------

const SPRING_DRIVER_MAP: Record<string, DriverType> = {
  "org.postgresql.Driver": "postgresql",
  "com.mysql.cj.jdbc.Driver": "mysql",
  "com.mysql.jdbc.Driver": "mysql",
  "oracle.jdbc.OracleDriver": "oracle",
  "oracle.jdbc.driver.OracleDriver": "oracle",
  "com.microsoft.sqlserver.jdbc.SQLServerDriver": "sqlserver",
  "org.sqlite.JDBC": "sqlite",
};

// ---- Docker Compose image patterns -------------------------------------------

const DOCKER_IMAGE_PATTERNS: Array<{ regex: RegExp; driver: DriverType; defaultPort: number }> = [
  {
    regex: /image:\s*['"]?postgres(?:sql)?(?::[\w.-]+)?['"]?/i,
    driver: "postgresql",
    defaultPort: 5432,
  },
  { regex: /image:\s*['"]?mysql(?::[\w.-]+)?['"]?/i, driver: "mysql", defaultPort: 3306 },
  { regex: /image:\s*['"]?mariadb(?::[\w.-]+)?['"]?/i, driver: "mysql", defaultPort: 3306 },
  {
    regex: /image:\s*['"]?(?:oraclelinux\/)?oracle[\w-]*(?::[\w.-]+)?['"]?/i,
    driver: "oracle",
    defaultPort: 1521,
  },
  {
    regex: /image:\s*['"]?mcr\.microsoft\.com\/mssql[\w/-]*(?::[\w.-]+)?['"]?/i,
    driver: "sqlserver",
    defaultPort: 1433,
  },
];

// ---- Gradle/Maven driver dependency patterns ---------------------------------

const DEPENDENCY_PATTERNS: Array<{ regex: RegExp; driver: DriverType }> = [
  // Gradle: implementation 'org.postgresql:postgresql:...'
  { regex: /['"]org\.postgresql:postgresql(?::[\w.-]+)?['"]/i, driver: "postgresql" },
  // Gradle: runtimeOnly 'mysql:mysql-connector-java:...'
  { regex: /['"]mysql:mysql-connector-java(?::[\w.-]+)?['"]/i, driver: "mysql" },
  { regex: /['"]com\.mysql:mysql-connector-j(?::[\w.-]+)?['"]/i, driver: "mysql" },
  // Gradle: runtimeOnly 'com.oracle.database.jdbc:ojdbc...'
  { regex: /['"]com\.oracle\.database\.jdbc:ojdbc[\w]*(?::[\w.-]+)?['"]/i, driver: "oracle" },
  // Gradle: runtimeOnly 'com.microsoft.sqlserver:mssql-jdbc:...'
  { regex: /['"]com\.microsoft\.sqlserver:mssql-jdbc(?::[\w.-]+)?['"]/i, driver: "sqlserver" },
  // Maven: <artifactId>postgresql</artifactId>
  { regex: /<artifactId>postgresql<\/artifactId>/i, driver: "postgresql" },
  { regex: /<artifactId>mysql-connector-java<\/artifactId>/i, driver: "mysql" },
  { regex: /<artifactId>mysql-connector-j<\/artifactId>/i, driver: "mysql" },
  { regex: /<artifactId>ojdbc\w*<\/artifactId>/i, driver: "oracle" },
  { regex: /<artifactId>mssql-jdbc<\/artifactId>/i, driver: "sqlserver" },
  // Maven groupId+artifactId combo for oracle
  { regex: /<groupId>com\.oracle\.database\.jdbc<\/groupId>/i, driver: "oracle" },
];

// ---- Env var patterns --------------------------------------------------------

const ENV_VAR_PATTERNS: Array<{ regex: RegExp; driver: DriverType | null }> = [
  { regex: /(?:DATABASE_URL|DB_URL|JDBC_URL)\s*[=:]\s*["']?(\S+)/i, driver: null },
  { regex: /(?:DB_HOST|DATABASE_HOST|PGHOST)\s*[=:]\s*["']?([^\s"']+)/i, driver: "postgresql" },
  { regex: /MYSQL_HOST\s*[=:]\s*["']?([^\s"']+)/i, driver: "mysql" },
  { regex: /ORACLE_HOST\s*[=:]\s*["']?([^\s"']+)/i, driver: "oracle" },
];

// ---- persistence.xml patterns ------------------------------------------------

const PERSISTENCE_PROPERTY_REGEX = /<property\s+name="([^"]+)"\s+value="([^"]+)"\s*\/>/g;

// ---- Credential extraction (opt-in, dev-files only) -------------------------
//
// These patterns intentionally live OUT of the standard connection-detection
// path so existing callers that omit `extractCredentials` continue to return
// the original credential-free results.

const USERNAME_ENV_KEYS = [
  "DB_USER",
  "DB_USERNAME",
  "DATABASE_USER",
  "DATABASE_USERNAME",
  "POSTGRES_USER",
  "PGUSER",
  "MYSQL_USER",
  "MYSQL_USERNAME",
  "ORACLE_USER",
  "ORACLE_USERNAME",
  "MSSQL_USER",
  "MSSQL_USERNAME",
];

const PASSWORD_ENV_KEYS = [
  "DB_PASSWORD",
  "DB_PASS",
  "DATABASE_PASSWORD",
  "POSTGRES_PASSWORD",
  "PGPASSWORD",
  "MYSQL_PASSWORD",
  "MYSQL_ROOT_PASSWORD",
  "ORACLE_PASSWORD",
  "MSSQL_PASSWORD",
  "SA_PASSWORD",
];

function buildEnvKeyRegex(keys: string[]): RegExp {
  // Matches:  KEY = value   |   KEY: value   |   - KEY=value   |   "KEY": "value"
  // The value is captured up to (un-quoted): whitespace or end-of-line.
  //                                 (quoted): the matching closing quote.
  const alt = keys.join("|");
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- keys is only ever the hardcoded USERNAME_ENV_KEYS/PASSWORD_ENV_KEYS arrays (static identifiers); no user input is interpolated.
  return new RegExp(
    `(?:^|[\\s\\-"'])(${alt})\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'#]+))`,
    "i",
  );
}

const USERNAME_KEY_REGEX = buildEnvKeyRegex(USERNAME_ENV_KEYS);
const PASSWORD_KEY_REGEX = buildEnvKeyRegex(PASSWORD_ENV_KEYS);

const SPRING_USERNAME_REGEX =
  /spring\.datasource\.username\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#]+))/i;
const SPRING_PASSWORD_REGEX =
  /spring\.datasource\.password\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#]+))/i;

/**
 * Generic .properties password/username patterns for Java/Gradle projects.
 * Matches lines like:
 *   asis.had.ds.password=SmZCcq4g...
 *   datasource.username=epvpool
 *   pv.integration.service.password=iamGroot
 *
 * The key must end with `.password` or `.username` (case-insensitive).
 * Excludes vault-reference values (e.g. VAULT::...) since those are not
 * plaintext credentials.
 */
const GENERIC_PROPS_PASSWORD_REGEX =
  /(?:^|\s)[\w.-]+\.password\s*[=:]\s*(?!"?\$\{)(?!VAULT::)(?:"([^"]*)"|'([^']*)'|([^\s"'#]+))/i;
const GENERIC_PROPS_USERNAME_REGEX =
  /(?:^|\s)[\w.-]+\.(?:username|user)\s*[=:]\s*(?:"([^"]*)"|'([^']*)'|([^\s"'#]+))/i;

/**
 * JDBC user-info form: jdbc:driver://user:pass@host... or driver://user:pass@host...
 * The leading scheme is captured so we can ignore matches inside other strings.
 */
const URL_USERINFO_REGEX =
  /(?:jdbc:)?(?:postgresql|postgres|mysql|sqlserver|oracle:thin)[^\s"'`]*:\/\/(?:([^:@/\s"']+):([^@/\s"']+)@)/i;

interface ExtractedCreds {
  username?: string | null;
  password?: string | null;
}

/**
 * Extract any credentials from a single line of text. Returns `null` when
 * nothing matched. Caller is responsible for the dev-file gating.
 */
function extractCredentialsFromLine(line: string): ExtractedCreds | null {
  const out: ExtractedCreds = {};

  const userInfo = URL_USERINFO_REGEX.exec(line);
  if (userInfo) {
    out.username = userInfo[1];
    out.password = userInfo[2];
  }

  const springUser = SPRING_USERNAME_REGEX.exec(line);
  if (springUser) {
    out.username = springUser[1] ?? springUser[2] ?? springUser[3] ?? out.username ?? null;
  }
  const springPass = SPRING_PASSWORD_REGEX.exec(line);
  if (springPass) {
    out.password = springPass[1] ?? springPass[2] ?? springPass[3] ?? out.password ?? null;
  }

  const envUser = USERNAME_KEY_REGEX.exec(line);
  if (envUser) {
    out.username = envUser[2] ?? envUser[3] ?? envUser[4] ?? out.username ?? null;
  }
  const envPass = PASSWORD_KEY_REGEX.exec(line);
  if (envPass) {
    out.password = envPass[2] ?? envPass[3] ?? envPass[4] ?? out.password ?? null;
  }

  // Generic .properties patterns (*.password=, *.username=)
  if (out.password == null) {
    const propsPass = GENERIC_PROPS_PASSWORD_REGEX.exec(line);
    if (propsPass) {
      out.password = propsPass[1] ?? propsPass[2] ?? propsPass[3] ?? null;
    }
  }
  if (out.username == null) {
    const propsUser = GENERIC_PROPS_USERNAME_REGEX.exec(line);
    if (propsUser) {
      out.username = propsUser[1] ?? propsUser[2] ?? propsUser[3] ?? null;
    }
  }

  if (out.username == null && out.password == null) return null;
  return out;
}

/**
 * Scan the full file for credentials and return aggregate { username, password }.
 * The first non-empty username / password wins. Callers MUST have already
 * verified `classifyDevFile()` permits extraction.
 */
function extractCredentialsFromContent(content: string): ExtractedCreds {
  const aggregate: ExtractedCreds = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const found = extractCredentialsFromLine(line);
    if (!found) continue;
    if (aggregate.username == null && found.username != null) aggregate.username = found.username;
    if (aggregate.password == null && found.password != null) aggregate.password = found.password;
    if (aggregate.username != null && aggregate.password != null) break;
  }
  return aggregate;
}

/**
 * Main scanner function.
 * Scans a single file's content for database connection references.
 *
 * When `opts.extractCredentials === true` AND the file is classified as a
 * dev-pattern file, any discovered credentials are attached to the returned
 * connections via the optional `username`/`password`/`devCredsDetected`
 * fields. Otherwise behaviour is unchanged from the original signature.
 */
export function scanFileForConnections(
  filePath: string,
  content: string,
  opts: ScanOptions = {},
): DiscoveredConnection[] {
  const results: DiscoveredConnection[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // 1. JDBC URLs (high confidence)
    for (const pattern of JDBC_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (match) {
        const extracted = pattern.extract(match);
        results.push({
          driverType: pattern.driver,
          host: extracted.host || null,
          port: extracted.port,
          database: extracted.database || null,
          sourceFile: filePath,
          lineNumber,
          confidence: "high",
        });
      }
    }

    // 2. DATABASE_URL-style connection strings (high confidence)
    for (const pattern of DATABASE_URL_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (match) {
        const extracted = pattern.extract(match);
        results.push({
          driverType: pattern.driver,
          host: extracted.host || null,
          port: extracted.port,
          database: extracted.database || null,
          sourceFile: filePath,
          lineNumber,
          confidence: "high",
        });
      }
    }

    // 3. Spring Boot datasource properties (high confidence)
    if (/spring\.datasource\.url\s*[=:]/i.test(line)) {
      // Try to parse the URL value
      for (const pattern of JDBC_PATTERNS) {
        const match = pattern.regex.exec(line);
        if (match) {
          const extracted = pattern.extract(match);
          results.push({
            driverType: pattern.driver,
            host: extracted.host || null,
            port: extracted.port,
            database: extracted.database || null,
            sourceFile: filePath,
            lineNumber,
            confidence: "high",
          });
        }
      }
    }

    // 4. Spring Boot driver-class-name (medium confidence — no host info)
    if (/spring\.datasource\.driver-class-name\s*[=:]/i.test(line)) {
      for (const [driverClass, driverType] of Object.entries(SPRING_DRIVER_MAP)) {
        if (line.includes(driverClass)) {
          results.push({
            driverType,
            host: null,
            port: null,
            database: null,
            sourceFile: filePath,
            lineNumber,
            confidence: "medium",
          });
        }
      }
    }

    // 5. Docker Compose images (medium confidence)
    for (const pattern of DOCKER_IMAGE_PATTERNS) {
      if (pattern.regex.test(line)) {
        results.push({
          driverType: pattern.driver,
          host: null,
          port: pattern.defaultPort,
          database: null,
          sourceFile: filePath,
          lineNumber,
          confidence: "medium",
        });
      }
    }

    // 6. Gradle/Maven dependencies (low confidence — just driver presence)
    for (const pattern of DEPENDENCY_PATTERNS) {
      if (pattern.regex.test(line)) {
        results.push({
          driverType: pattern.driver,
          host: null,
          port: null,
          database: null,
          sourceFile: filePath,
          lineNumber,
          confidence: "low",
        });
      }
    }

    // 7. Env var patterns (medium confidence)
    for (const pattern of ENV_VAR_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (match) {
        if (pattern.driver === null) {
          // DATABASE_URL — try to parse the value
          const value = match[1];
          let found = false;
          for (const urlPattern of DATABASE_URL_PATTERNS) {
            const urlMatch = urlPattern.regex.exec(value);
            if (urlMatch) {
              const extracted = urlPattern.extract(urlMatch);
              results.push({
                driverType: urlPattern.driver,
                host: extracted.host || null,
                port: extracted.port,
                database: extracted.database || null,
                sourceFile: filePath,
                lineNumber,
                confidence: "high",
              });
              found = true;
              break;
            }
          }
          for (const jdbcPattern of JDBC_PATTERNS) {
            if (found) break;
            const jdbcMatch = jdbcPattern.regex.exec(value);
            if (jdbcMatch) {
              const extracted = jdbcPattern.extract(jdbcMatch);
              results.push({
                driverType: jdbcPattern.driver,
                host: extracted.host || null,
                port: extracted.port,
                database: extracted.database || null,
                sourceFile: filePath,
                lineNumber,
                confidence: "high",
              });
              found = true;
            }
          }
        } else {
          results.push({
            driverType: pattern.driver,
            host: match[1] || null,
            port: null,
            database: null,
            sourceFile: filePath,
            lineNumber,
            confidence: "medium",
          });
        }
      }
    }
  }

  // 8. persistence.xml — scan for javax.persistence / hibernate properties
  if (filePath.endsWith(".xml")) {
    let propMatch: RegExpExecArray | null;
    const regex = new RegExp(PERSISTENCE_PROPERTY_REGEX.source, "g");
    while ((propMatch = regex.exec(content)) !== null) {
      const propName = propMatch[1];
      const propValue = propMatch[2];
      if (propName === "javax.persistence.jdbc.url" || propName === "hibernate.connection.url") {
        for (const pattern of JDBC_PATTERNS) {
          const match = pattern.regex.exec(propValue);
          if (match) {
            const extracted = pattern.extract(match);
            // Find the line number
            const lineIdx = content.substring(0, propMatch.index).split("\n").length;
            results.push({
              driverType: pattern.driver,
              host: extracted.host || null,
              port: extracted.port,
              database: extracted.database || null,
              sourceFile: filePath,
              lineNumber: lineIdx,
              confidence: "high",
            });
          }
        }
      }
      if (
        propName === "javax.persistence.jdbc.driver" ||
        propName === "hibernate.connection.driver_class"
      ) {
        const driverType = SPRING_DRIVER_MAP[propValue];
        if (driverType) {
          const lineIdx = content.substring(0, propMatch.index).split("\n").length;
          results.push({
            driverType,
            host: null,
            port: null,
            database: null,
            sourceFile: filePath,
            lineNumber: lineIdx,
            confidence: "medium",
          });
        }
      }
    }
  }

  // ── Optional credential extraction ─────────────────────────────────────
  // Double-gated:
  //   1. caller opts.extractCredentials === true
  //   2. classifyDevFile(filePath).isDevFile === true
  // Either gate missing → no credentials are attached and the function
  // returns the same shape as the original Issue #468 contract.
  if (opts.extractCredentials === true && results.length > 0) {
    const classification = classifyDevFile(filePath);
    if (classification.isDevFile) {
      const creds = extractCredentialsFromContent(content);
      if (creds.username != null || creds.password != null) {
        for (const r of results) {
          if (creds.username != null) r.username = creds.username;
          if (creds.password != null) r.password = creds.password;
          r.devCredsDetected = true;
          r.credentialSourceFile = filePath;
        }
      }
    }
  }

  return results;
}
