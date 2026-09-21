/**
 * Driver registration entry-point.
 *
 * Imported once at module load time by `db-service.ts` to populate the
 * registry. Tests that want to substitute a fake driver call
 * `__resetDriverRegistry()` first, then `registerDriver(...)` themselves.
 */
import { registerDriver } from "./driver.js";
import { PostgresDriverAdapter } from "./drivers/postgres.js";
import { MySqlDriverAdapter } from "./drivers/mysql.js";
import { OracleDriverAdapter } from "./drivers/oracle.js";
import { SqlServerDriverAdapter } from "./drivers/sqlserver.js";

let registered = false;

export function registerBuiltInDrivers(): void {
  if (registered) return;
  registerDriver("postgres", () => new PostgresDriverAdapter());
  registerDriver("mysql", () => new MySqlDriverAdapter());
  registerDriver("oracle", () => new OracleDriverAdapter());
  registerDriver("sqlserver", () => new SqlServerDriverAdapter());
  registered = true;
}

export function __resetBuiltInRegistration(): void {
  registered = false;
}
