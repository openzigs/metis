/**
 * Typed errors thrown by `ConfigService` and the admin config routes.
 *
 * The route layer maps these to HTTP statuses:
 *   - `ConfigUnknownKeyError`  → 400
 *   - `ConfigBootstrapError`   → 400 (bootstrap keys never writable via API)
 *   - `ConfigValidationError`  → 400 (Zod failure carried in `.issues`)
 */

export class ConfigUnknownKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Unknown config key: ${key}`);
    this.name = "ConfigUnknownKeyError";
  }
}

export class ConfigBootstrapError extends Error {
  constructor(public readonly key: string) {
    super(
      `${key} is a bootstrap config value and cannot be modified at runtime. Set it in .env and restart.`,
    );
    this.name = "ConfigBootstrapError";
  }
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly key: string,
    public readonly issues: unknown,
  ) {
    super(`Invalid value for config key ${key}`);
    this.name = "ConfigValidationError";
  }
}
