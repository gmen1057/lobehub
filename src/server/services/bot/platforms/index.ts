// --------------- Core types & utilities ---------------
// --------------- Registry singleton ---------------
import { PlatformRegistry } from './registry';

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

export const platformRegistry = new PlatformRegistry();
