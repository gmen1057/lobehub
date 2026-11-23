import debug from 'debug';

import { BaseSystemRoleProvider } from '../base/BaseSystemRoleProvider';
import type { PipelineContext, ProcessorOptions } from '../types';

declare module '../types' {
  interface PipelineContextMetadataOverrides {
    dynamicSystemAppendInjected?: boolean;
    projectWorkspaceRulesInjected?: boolean;
  }
}

const logRules = debug('context-engine:provider:ProjectWorkspaceRulesInjector');
const logDynamic = debug('context-engine:provider:DynamicSystemAppendInjector');

export interface WorkspaceRuleFileInput {
  content: string;
  path: string;
  revision?: number;
}

export interface ProjectWorkspaceRulesInjectorConfig {
  enabled?: boolean;
  rulesBlock?: string;
}

export interface DynamicSystemAppendInjectorConfig {
  content?: string;
  enabled?: boolean;
}

const sanitizeAttrControlChars = (value: string): string => {
  let out = '';
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\r' || ch === '\n' || ch === '\t') {
      out += ' ';
      continue;
    }
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      continue;
    }
    out += ch;
  }
  return out;
};

const escapeXmlAttr = (raw: string): string =>
  sanitizeAttrControlChars(raw)
    .trim()
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/**
 * Deterministically formats pinned workspace rule files into a `<project_rules>` block.
 * Root `AGENTS.md` is always placed first, followed by additional pinned files in stable order.
 */
export const formatProjectRulesBlock = (files: WorkspaceRuleFileInput[]): string => {
  if (!Array.isArray(files) || files.length === 0) return '';

  const nonEmpty = files.filter(
    (file) =>
      file &&
      typeof file.path === 'string' &&
      file.path.trim() !== '' &&
      typeof file.content === 'string' &&
      file.content.trim() !== '',
  );

  if (nonEmpty.length === 0) return '';

  const rootAgents: WorkspaceRuleFileInput[] = [];
  const otherRules: WorkspaceRuleFileInput[] = [];

  for (const file of nonEmpty) {
    if (file.path.trim().toLowerCase() === 'agents.md') {
      rootAgents.push(file);
    } else {
      otherRules.push(file);
    }
  }

  const ordered = [...rootAgents, ...otherRules];
  const lines: string[] = ['<project_rules>'];

  for (const file of ordered) {
    const escapedPath = escapeXmlAttr(file.path);
    const rev =
      typeof file.revision === 'number' && Number.isFinite(file.revision)
        ? Math.floor(file.revision)
        : 1;
    const normalizedBody = file.content.replaceAll('\r\n', '\n').replace(/\n+$/, '');
    lines.push(
      `<rule_file path="${escapedPath}" revision="${rev}">`,
      normalizedBody,
      '</rule_file>',
    );
  }

  lines.push('</project_rules>');
  return lines.join('\n');
};

/**
 * Project Workspace Rules Injector (Breakpoint 1 static prefix).
 * Appends `<project_rules>` immediately after `SystemRoleInjector` and strictly BEFORE
 * `DynamicSystemAppendInjector` so pinned rules remain in the warm static prompt head.
 */
export class ProjectWorkspaceRulesInjector extends BaseSystemRoleProvider {
  readonly name = 'ProjectWorkspaceRulesInjector';

  constructor(
    private config: ProjectWorkspaceRulesInjectorConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected buildSystemRoleContent(_context: PipelineContext): string | null {
    if (this.config.enabled === false) {
      logRules('Disabled, skipping project workspace rules injection');
      return null;
    }

    const trimmed = this.config.rulesBlock?.trim();
    if (!trimmed) {
      logRules('Empty rulesBlock, skipping project workspace rules injection');
      return null;
    }

    return trimmed;
  }

  protected onInjected(context: PipelineContext): void {
    context.metadata.projectWorkspaceRulesInjected = true;
  }
}

/**
 * Dynamic System Append Injector (`R2-1`).
 * Injects per-turn platform additions (`instructions`, `resumeRule`, `setupHints`, `codeSourceRules`)
 * strictly AFTER `ProjectWorkspaceRulesInjector` so `<project_rules>` stays byte-static in Breakpoint 1.
 */
export class DynamicSystemAppendInjector extends BaseSystemRoleProvider {
  readonly name = 'DynamicSystemAppendInjector';

  constructor(
    private config: DynamicSystemAppendInjectorConfig,
    options: ProcessorOptions = {},
  ) {
    super(options);
  }

  protected buildSystemRoleContent(_context: PipelineContext): string | null {
    if (this.config.enabled === false) {
      logDynamic('Disabled, skipping dynamic system append injection');
      return null;
    }

    const trimmed = this.config.content?.trim();
    if (!trimmed) {
      logDynamic('Empty dynamic content, skipping injection');
      return null;
    }

    return trimmed;
  }

  protected onInjected(context: PipelineContext): void {
    context.metadata.dynamicSystemAppendInjected = true;
  }
}
