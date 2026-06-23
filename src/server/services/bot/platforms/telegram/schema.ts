import { DEFAULT_BOT_DEBOUNCE_MS, MAX_BOT_DEBOUNCE_MS } from '@lobechat/const';

import { displayToolCallsField, userIdField } from '../const';
import type { FieldSchema } from '../types';

export const schema: FieldSchema[] = [
  {
    key: 'credentials',
    label: 'channel.credentials',
    properties: [
      {
        key: 'botToken',
        description: 'channel.botTokenEncryptedHint',
        label: 'channel.botToken',
        required: true,
        type: 'password',
      },
      {
        key: 'secretToken',
        description: 'channel.secretTokenHint',
        label: 'channel.secretToken',
        required: false,
        type: 'password',
      },
      {
        devOnly: true,
        key: 'webhookProxyUrl',
        description: 'channel.devWebhookProxyUrlHint',
        label: 'channel.devWebhookProxyUrl',
        required: false,
        type: 'string',
      },
    ],
    type: 'object',
  },
  {
    key: 'settings',
    label: 'channel.settings',
    properties: [
      {
        key: 'charLimit',
        default: 4000,
        description: 'channel.charLimitHint',
        label: 'channel.charLimit',
        maximum: 4096,
        minimum: 100,
        type: 'number',
      },
      {
        key: 'concurrency',
        default: 'debounce',
        description: 'channel.concurrencyHint',
        enum: ['queue', 'debounce'],
        enumLabels: ['channel.concurrencyQueue', 'channel.concurrencyDebounce'],
        label: 'channel.concurrency',
        type: 'string',
      },
      {
        key: 'debounceMs',
        default: DEFAULT_BOT_DEBOUNCE_MS,
        description: 'channel.debounceMsHint',
        label: 'channel.debounceMs',
        maximum: MAX_BOT_DEBOUNCE_MS,
        minimum: 100,
        type: 'number',
        visibleWhen: { field: 'concurrency', value: 'debounce' },
      },
      {
        key: 'showUsageStats',
        default: false,
        description: 'channel.showUsageStatsHint',
        label: 'channel.showUsageStats',
        type: 'boolean',
      },
      displayToolCallsField,
      userIdField,
      // arckep (Phase 5 / G1): access mode the CLIENT controls. Default 'allowlist' = owner-only
      // (only the owner + explicitly-granted end-users; see bot_end_users + botAccessGate). The
      // owner widens to 'open' (everyone) or keeps 'allowlist' and grants selected users.
      {
        key: 'dm',
        label: 'channel.dm',
        properties: [
          {
            key: 'policy',
            default: 'allowlist',
            description: 'channel.dmPolicyHint',
            enum: ['open', 'allowlist', 'disabled'],
            enumLabels: [
              'channel.dmPolicyOpen',
              'channel.dmPolicyAllowlist',
              'channel.dmPolicyDisabled',
            ],
            label: 'channel.dmPolicy',
            type: 'string',
          },
        ],
        type: 'object',
      },
    ],
    type: 'object',
  },
];
