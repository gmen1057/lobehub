// --------------- Core types & utilities ---------------
// --------------- Registry singleton ---------------
import { PlatformRegistry } from './registry';
import { telegram } from './telegram/definition';

export { PlatformRegistry } from './registry';
export type {
  BotPlatformRedisClient,
  BotPlatformRuntimeContext,
  BotProviderConfig,
  FieldSchema,
  PlatformClient,
  PlatformDefinition,
  PlatformDocumentation,
  PlatformMessenger,
  SerializedPlatformDefinition,
  UsageStats,
  ValidationResult,
} from './types';
export { ClientFactory } from './types';
export {
  buildRuntimeKey,
  extractDefaults,
  formatDuration,
  formatTokens,
  formatUsageStats,
  mergeWithDefaults,
  parseRuntimeKey,
} from './utils';

// --------------- Platform definitions ---------------
export { telegram } from './telegram/definition';

export const platformRegistry = new PlatformRegistry();

platformRegistry.register(telegram);
