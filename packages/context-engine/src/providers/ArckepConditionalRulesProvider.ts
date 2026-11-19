import {
  ARCKEP_FIGMA_PLAYBOOK_PROMPT,
  ARCKEP_MOCKUP_LAYOUT_PROMPT,
  attachedFileTranslationPrompt,
} from '@lobechat/prompts';
import debug from 'debug';

import { BaseSystemRoleProvider } from '../base/BaseSystemRoleProvider';
import type { LobeToolManifest } from '../engine/tools/types';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    arckepConditionalRules?: {
      figmaPlaybook: boolean;
      fileTranslation: boolean;
      mockupLayout: boolean;
    };
  }
}

const log = debug('context-engine:provider:ArckepConditionalRulesProvider');

const LAYOUT_TAG_RE = /<layout(?:\s|>)/;
const FIGMA_LINK_RE =
  /(?<![\w.@/=?&#%-])(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:design|file|proto|board|slides|make)\/[^\s/?#]/i;

export interface ArckepConditionalRulesConfig {
  availableToolIds?: string[];
  enabled?: boolean;
  hasKnowledgeFiles?: boolean;
  manifests?: LobeToolManifest[];
  toolIds?: string[];
}

const extractText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { text: string; type: string } =>
        Boolean(part) && typeof part === 'object' && typeof (part as any).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
};

/**
 * Injects heavy situational Arckep instructions into the system message ONLY when
 * the conversation context actually needs them (zero tokens on plain text chats):
 * - PDF mockup layout + checkLayout rules when `<layout>` / `metadata.layouts` is present
 * - `<attached_file_translation>` when user-attached files are present in an Arckep/activator chat
 * - `<figma_playbook>` when a Figma URL is present or `mcp-arckep-figma` is active
 */
export class ArckepConditionalRulesProvider extends BaseSystemRoleProvider {
  readonly name = 'ArckepConditionalRulesProvider';

  private lastInjectedFlags = {
    figmaPlaybook: false,
    fileTranslation: false,
    mockupLayout: false,
  };

  constructor(
    private config: ArckepConditionalRulesConfig = {},
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected buildSystemRoleContent(context: PipelineContext): string | null {
    if (this.config.enabled === false) return null;

    const toolIds = this.config.toolIds ?? [];
    const availableToolIds = this.config.availableToolIds ?? [];
    const manifestIds = (this.config.manifests ?? []).map((m) => m.identifier);
    const activeIds = new Set([...toolIds, ...manifestIds]);

    const existingSystem = context.messages
      .filter((m) => m.role === 'system')
      .map((m) => extractText(m.content))
      .join('\n');

    let hasLayout = false;
    let hasFiles = Boolean(this.config.hasKnowledgeFiles);
    let hasFigma = activeIds.has('mcp-arckep-figma');

    const scanMessage = (raw: unknown): void => {
      if (!raw || typeof raw !== 'object') return;
      const m = raw as Record<string, any>;
      if (m.role === 'system') return;

      if (m.role === 'compressedGroup' && Array.isArray(m.compressedMessages)) {
        for (const inner of m.compressedMessages) {
          scanMessage(inner);
        }
      }

      if (!hasLayout && Array.isArray(m.metadata?.layouts) && m.metadata.layouts.length > 0) {
        hasLayout = true;
      }

      const isUser = m.role === 'user';
      if (
        isUser &&
        !hasFiles &&
        ((Array.isArray(m.fileList) && m.fileList.length > 0) ||
          (Array.isArray(m.imageList) && m.imageList.length > 0))
      ) {
        hasFiles = true;
      }

      const text = extractText(m.content);
      if (text) {
        if (!hasLayout && LAYOUT_TAG_RE.test(text)) hasLayout = true;
        if (
          isUser &&
          !hasFiles &&
          (text.includes('<attachments>') || text.includes('<files_info>'))
        ) {
          hasFiles = true;
        }
        if (!hasFigma && FIGMA_LINK_RE.test(text)) hasFigma = true;
      }
    };

    for (const msg of context.messages) {
      scanMessage(msg);
    }

    const hasActivator = activeIds.has('lobe-activator');
    const hasArckepContext =
      existingSystem.includes('chat.arckep.ru') ||
      [...activeIds, ...availableToolIds].some(
        (id) => id.startsWith('mcp-arckep-') || id.startsWith('arckep-'),
      );
    const hasSkillStore =
      activeIds.has('lobe-skill-store') || availableToolIds.includes('lobe-skill-store');

    const parts: string[] = [];
    const flags = {
      figmaPlaybook: false,
      fileTranslation: false,
      mockupLayout: false,
    };

    if (hasLayout && !existingSystem.includes('Mockup layout:')) {
      parts.push(ARCKEP_MOCKUP_LAYOUT_PROMPT);
      flags.mockupLayout = true;
    }

    if (
      hasFiles &&
      (hasActivator || hasArckepContext) &&
      !existingSystem.includes('<attached_file_translation>') &&
      !existingSystem.includes('Файлы на перевод:')
    ) {
      parts.push(attachedFileTranslationPrompt(!hasSkillStore));
      flags.fileTranslation = true;
    }

    if (hasFigma && !existingSystem.includes('<figma_playbook>')) {
      parts.push(ARCKEP_FIGMA_PLAYBOOK_PROMPT);
      flags.figmaPlaybook = true;
    }

    this.lastInjectedFlags = flags;

    if (parts.length === 0) return null;

    log('Injecting conditional rules: %O', flags);
    return parts.join('\n\n');
  }

  protected onInjected(context: PipelineContext): void {
    context.metadata.arckepConditionalRules = { ...this.lastInjectedFlags };
  }
}
