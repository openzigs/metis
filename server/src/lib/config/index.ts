/**
 * Public surface of the runtime config layer.
 */
export {
  ConfigService,
  getConfigService,
  __resetConfigSingleton,
  type ConfigServiceOptions,
  type ConfigSourceInfo,
  type ConfigChangedEvent,
} from "./config-service.js";
export { ConfigCache, type CacheEntry } from "./cache.js";
export {
  CONFIG_KEYS,
  type ConfigKey,
  type ConfigKeyDef,
  type ConfigTier,
  type ConfigValueType,
  getKeyDef,
  listKeysByTier,
  isConfigKey,
} from "./key-registry.js";
export { ConfigBootstrapError, ConfigUnknownKeyError, ConfigValidationError } from "./errors.js";
