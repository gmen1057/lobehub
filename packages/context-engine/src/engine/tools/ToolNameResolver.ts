import { Md5 } from 'ts-md5';

import type { ChatToolPayload, MessageToolCall } from '@/types/index';

import type {
  LobeChatPluginApi,
  LobeToolManifest,
  ResolveToolCallsOptions,
  ToolResolveDiagnostics,
  UnresolvedToolCall,
  UnresolvedToolCallReason,
} from './types';

// Tool naming constants
const PLUGIN_SCHEMA_SEPARATOR = '____';
const PLUGIN_SCHEMA_API_MD5_PREFIX = 'MD5HASH_';
const REPAIR_SEPARATORS = ['__', '.', '/'] as const;
const KNOWN_MANIFEST_TYPES = ['builtin', 'standalone', 'markdown', 'mcp', 'default'] as const;

interface RepairCandidate {
  api: LobeChatPluginApi;
  identifier: string;
  resolvedType: string;
}

/**
 * Tool Name Resolver
 * Handles tool name generation and resolution for function calling
 */
export class ToolNameResolver {
  /**
   * Generate MD5 hash for tool name shortening
   * @private
   */
  private genHash(name: string): string {
    return Md5.hashStr(name).toString().slice(0, 12);
  }

  /**
   * Generate tool calling name
   * @param identifier - Plugin identifier
   * @param name - API name
   * @param type - Plugin type (default: 'default')
   * @returns Generated tool name (max 64 characters)
   */
  generate(identifier: string, name: string, type: string = 'default'): string {
    const pluginType = type && type !== 'default' ? `${PLUGIN_SCHEMA_SEPARATOR}${type}` : '';

    // Step 1: Try normal format
    let apiName = identifier + PLUGIN_SCHEMA_SEPARATOR + name + pluginType;

    // OpenAI GPT function_call name can't be longer than 64 characters
    // Step 2: If >= 64, hash the name part
    if (apiName.length >= 64) {
      const nameHash = PLUGIN_SCHEMA_API_MD5_PREFIX + this.genHash(name);
      apiName = identifier + PLUGIN_SCHEMA_SEPARATOR + nameHash + pluginType;

      // Step 3: If still >= 64, also hash the identifier
      if (apiName.length >= 64) {
        const identifierHash = PLUGIN_SCHEMA_API_MD5_PREFIX + this.genHash(identifier);
        apiName = identifierHash + PLUGIN_SCHEMA_SEPARATOR + nameHash + pluginType;
      }
    }

    return apiName;
  }

  /**
   * Resolve tool calls from AI response back to original tool information
   * @param toolCalls - Tool calls from AI model response
   * @param manifests - Available tool manifests mapped by identifier
   * @returns Resolved tool payloads
   */
  resolve(
    toolCalls: MessageToolCall[],
    manifests: Record<string, LobeToolManifest>,
  ): ChatToolPayload[] {
    return this.resolveWithDiagnostics(toolCalls, manifests).resolved;
  }

  /**
   * Resolve tool calls with soft separator repair, disabled/active manifest guards,
   * and structured diagnostics for unresolved tool calls.
   */
  resolveWithDiagnostics(
    toolCalls: MessageToolCall[],
    manifests: Record<string, LobeToolManifest>,
    options?: ResolveToolCallsOptions,
  ): ToolResolveDiagnostics {
    const disabledSet = new Set(Array.from(options?.disabledToolIds ?? []).filter(Boolean));
    const passthroughSet = new Set(
      Array.from(options?.passthroughIdentifiers ?? []).filter(Boolean),
    );
    const enforceActiveManifests = Boolean(options?.enforceActiveManifests);

    const repairedNames: Record<string, string> = {};
    const resolved: ChatToolPayload[] = [];
    const unresolved: UnresolvedToolCall[] = [];

    for (const toolCall of toolCalls) {
      const rawName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name : '';

      if (!rawName) {
        unresolved.push({ rawName, reason: 'invalid_format', toolCall });
        continue;
      }

      const [initialIdentifier, initialApiName, typeSuffix] =
        rawName.split(PLUGIN_SCHEMA_SEPARATOR);
      const hasValidStandardSplit = Boolean(
        rawName.includes(PLUGIN_SCHEMA_SEPARATOR) && initialIdentifier && initialApiName,
      );

      if (hasValidStandardSplit) {
        let identifier = initialIdentifier;

        // Step 1: Resolve hashed identifier if needed (against manifests or disabledSet)
        if (identifier.startsWith(PLUGIN_SCHEMA_API_MD5_PREFIX)) {
          const identifierMd5 = identifier.slice(PLUGIN_SCHEMA_API_MD5_PREFIX.length);
          const foundInManifests = Object.keys(manifests).find(
            (id) => this.genHash(id) === identifierMd5,
          );
          if (foundInManifests) {
            identifier = foundInManifests;
          } else {
            const foundInDisabled = Array.from(disabledSet).find(
              (id) => this.genHash(id) === identifierMd5,
            );
            if (foundInDisabled) {
              identifier = foundInDisabled;
            }
          }
        }

        if (disabledSet.has(identifier) || disabledSet.has(initialIdentifier)) {
          unresolved.push({ rawName, reason: 'disabled', toolCall });
          continue;
        }

        const payload: ChatToolPayload = {
          apiName: initialApiName,
          arguments: toolCall.function.arguments,
          id: toolCall.id,
          identifier,
          thoughtSignature: toolCall.thoughtSignature,
          type: (typeSuffix ?? manifests[identifier]?.type ?? 'default') as any,
        };

        // Step 2: Resolve hashed apiName if needed
        if (initialApiName.startsWith(PLUGIN_SCHEMA_API_MD5_PREFIX) && manifests[identifier]) {
          const md5 = initialApiName.slice(PLUGIN_SCHEMA_API_MD5_PREFIX.length);
          const manifest = manifests[identifier];

          const api = manifest?.api.find(
            (item: LobeChatPluginApi) => this.genHash(item.name) === md5,
          );
          if (api) {
            payload.apiName = api.name;
          }
        }

        // Step 3: Enforce active manifest membership when requested
        if (enforceActiveManifests && !passthroughSet.has(identifier)) {
          const activeManifest = manifests[identifier];
          const isApiActive =
            Boolean(activeManifest) &&
            Array.isArray(activeManifest.api) &&
            activeManifest.api.some((item) => item.name === payload.apiName);

          if (!isApiActive) {
            unresolved.push({ rawName, reason: 'inactive_or_unknown', toolCall });
            continue;
          }
        }

        resolved.push(payload);
        continue;
      }

      // Soft repair path: no valid `____` separator
      const repairResult = this.repairWithoutStandardSeparator(rawName, manifests, disabledSet);

      if (!repairResult.ok) {
        unresolved.push({ rawName, reason: repairResult.reason, toolCall });
        continue;
      }

      const { api, identifier, resolvedType } = repairResult.candidate;
      repairedNames[toolCall.id] = this.generate(identifier, api.name, resolvedType);
      resolved.push({
        apiName: api.name,
        arguments: toolCall.function.arguments,
        id: toolCall.id,
        identifier,
        thoughtSignature: toolCall.thoughtSignature,
        type: resolvedType as any,
      });
    }

    return {
      repairedNames,
      resolved,
      unresolved,
    };
  }

  private matchesDisabledPrefix(rawName: string, disabledSet: Set<string>): boolean {
    for (const disabledId of disabledSet) {
      if (!disabledId) continue;
      const hashedDisabledId = `${PLUGIN_SCHEMA_API_MD5_PREFIX}${this.genHash(disabledId)}`;

      for (const token of [disabledId, hashedDisabledId]) {
        if (rawName === token || rawName.startsWith(`${token}${PLUGIN_SCHEMA_SEPARATOR}`)) {
          return true;
        }
        for (const sep of REPAIR_SEPARATORS) {
          if (rawName.startsWith(`${token}${sep}`)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private matchSeparatorPair(
    rawName: string,
    manifestId: string,
    manifestType: LobeToolManifest['type'],
    api: LobeChatPluginApi,
  ): string | null {
    const apiTokens = [api.name, `${PLUGIN_SCHEMA_API_MD5_PREFIX}${this.genHash(api.name)}`];
    const idTokens = [manifestId, `${PLUGIN_SCHEMA_API_MD5_PREFIX}${this.genHash(manifestId)}`];
    const suffixTypes = manifestType ? [manifestType] : KNOWN_MANIFEST_TYPES;

    for (const idToken of idTokens) {
      for (const sep of REPAIR_SEPARATORS) {
        for (const apiToken of apiTokens) {
          const base = `${idToken}${sep}${apiToken}`;
          if (rawName === base) {
            return manifestType ?? 'default';
          }

          for (const candidateType of suffixTypes) {
            if (
              rawName === `${base}${sep}${candidateType}` ||
              rawName === `${base}${PLUGIN_SCHEMA_SEPARATOR}${candidateType}`
            ) {
              return manifestType ?? candidateType ?? 'default';
            }
          }
        }
      }
    }

    return null;
  }

  private repairWithoutStandardSeparator(
    rawName: string,
    manifests: Record<string, LobeToolManifest>,
    disabledSet: Set<string>,
  ): { candidate: RepairCandidate; ok: true } | { ok: false; reason: UnresolvedToolCallReason } {
    const activeSeparatorMatches = new Map<string, RepairCandidate>();
    let hasDisabledSeparatorMatch = false;

    for (const [manifestKey, manifest] of Object.entries(manifests)) {
      if (!manifest || !Array.isArray(manifest.api)) continue;
      const manifestId = manifestKey;
      const isDisabled = disabledSet.has(manifestId) || disabledSet.has(manifest.identifier);

      for (const api of manifest.api) {
        const matchedType = this.matchSeparatorPair(rawName, manifestId, manifest.type, api);
        if (!matchedType) continue;

        if (isDisabled) {
          hasDisabledSeparatorMatch = true;
        } else {
          activeSeparatorMatches.set(`${manifestId}${PLUGIN_SCHEMA_SEPARATOR}${api.name}`, {
            api,
            identifier: manifestId,
            resolvedType: matchedType,
          });
        }
      }
    }

    if (activeSeparatorMatches.size === 1) {
      const [candidate] = activeSeparatorMatches.values();
      return { candidate, ok: true };
    }

    if (activeSeparatorMatches.size > 1) {
      return { ok: false, reason: 'ambiguous_bare_name' };
    }

    if (hasDisabledSeparatorMatch || this.matchesDisabledPrefix(rawName, disabledSet)) {
      return { ok: false, reason: 'disabled' };
    }

    // Bare apiName lookup across active manifests
    const activeBareMatches = new Map<string, RepairCandidate>();
    let hasDisabledBareMatch = false;

    for (const [manifestKey, manifest] of Object.entries(manifests)) {
      if (!manifest || !Array.isArray(manifest.api)) continue;
      const manifestId = manifestKey;
      const isDisabled = disabledSet.has(manifestId) || disabledSet.has(manifest.identifier);

      for (const api of manifest.api) {
        const hashedApiName = `${PLUGIN_SCHEMA_API_MD5_PREFIX}${this.genHash(api.name)}`;
        if (api.name !== rawName && hashedApiName !== rawName) continue;

        if (isDisabled) {
          hasDisabledBareMatch = true;
        } else {
          activeBareMatches.set(`${manifestId}${PLUGIN_SCHEMA_SEPARATOR}${api.name}`, {
            api,
            identifier: manifestId,
            resolvedType: manifest.type ?? 'default',
          });
        }
      }
    }

    if (activeBareMatches.size === 1) {
      const [candidate] = activeBareMatches.values();
      return { candidate, ok: true };
    }

    if (activeBareMatches.size > 1) {
      return { ok: false, reason: 'ambiguous_bare_name' };
    }

    if (hasDisabledBareMatch) {
      return { ok: false, reason: 'disabled' };
    }

    return { ok: false, reason: 'invalid_format' };
  }
}
