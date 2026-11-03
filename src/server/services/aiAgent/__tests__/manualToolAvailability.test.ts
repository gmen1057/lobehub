// @vitest-environment node
import { AgentDocumentsManifest } from '@lobechat/builtin-tool-agent-documents';
import { MemoryManifest } from '@lobechat/builtin-tool-memory';
import { arckepLazyToolIds, manualModeExcludeToolIds } from '@lobechat/builtin-tools';
import { MessagesEngine } from '@lobechat/context-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServerAgentToolsEngine } from '@/server/modules/Mecha/AgentToolsEngine';

import { DEFAULT_AGENT_CONFIG } from '../../../../../packages/const/src/settings/agent';
import { getDeferredToolIds } from '../toolDeferral';

const STUDIO = 'mcp-arckep-studio-images';
const studioManifest = {
  api: [{ description: 'Create an image', name: 'create_image', parameters: { type: 'object' } }],
  identifier: STUDIO,
  meta: { title: 'Images' },
  type: 'mcp',
};

const assemble = ({
  configured = [AgentDocumentsManifest.identifier, STUDIO],
  excluded = [] as string[],
  hasDocuments = true,
  manual = true,
  memory = false,
  picked = [] as string[],
} = {}) => {
  const selected = [...configured, ...picked].filter((id) => !excluded.includes(id));
  const deferred = getDeferredToolIds({
    candidates: [...arckepLazyToolIds, STUDIO],
    configuredToolIds: selected,
    hiddenToolIds: excluded,
    isManualMode: manual,
    pickedToolIds: new Set(picked),
  });
  const engine = createServerAgentToolsEngine(
    {
      installedPlugins: [{ identifier: STUDIO, manifest: studioManifest } as any],
      isModelSupportToolUse: () => true,
    },
    {
      agentConfig: {
        plugins: selected,
      },
      globalMemoryEnabled: memory,
      hasAgentDocuments: hasDocuments,
      model: 'offline-fixture',
      provider: 'offline-fixture',
    },
  );
  return engine.generateToolsDetailed({
    excludeDefaultToolIds: [...deferred, ...excluded, ...(manual ? manualModeExcludeToolIds : [])],
    model: 'offline-fixture',
    provider: 'offline-fixture',
    toolIds: selected.filter((id) => !deferred.includes(id)),
  });
};

describe('manual tools: effective function schemas and prompts', () => {
  beforeEach(() => vi.stubEnv('ARCKEP_HEADLESS_TOOLS', '1'));
  afterEach(() => vi.unstubAllEnvs());

  it('manual mode exposes configured document and studio APIs without the activator', async () => {
    const result = assemble();
    expect(result.enabledToolIds).toContain(AgentDocumentsManifest.identifier);
    expect(result.enabledToolIds).toContain(STUDIO);
    expect(result.enabledToolIds).not.toContain('lobe-activator');
    expect(result.enabledManifests).toContainEqual(AgentDocumentsManifest);
    expect(result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          function: expect.objectContaining({
            name: 'lobe-agent-documents____readDocument____builtin',
            parameters: expect.objectContaining({ required: ['id'] }),
          }),
        }),
        expect.objectContaining({
          function: expect.objectContaining({ name: `${STUDIO}____create_image____mcp` }),
        }),
      ]),
    );
    const objective = 'Read my existing document';
    const output = await new MessagesEngine({
      enableSystemDate: false,
      messages: [{ content: objective, createdAt: 0, id: 'user-fixture', role: 'user', updatedAt: 0 }],
      model: 'offline-fixture',
      provider: 'offline-fixture',
      toolsConfig: { manifests: result.enabledManifests, tools: result.enabledToolIds },
    }).process();
    const system = output.messages.find((message) => message.role === 'system')?.content;
    expect(system).toContain(AgentDocumentsManifest.systemRole);
    expect(output.messages.some((message) => message.content === objective)).toBe(true);
  });

  it('auto mode still defers configured heavy tools and keeps its activator', () => {
    const result = assemble({ manual: false });
    expect(result.enabledToolIds).toContain('lobe-activator');
    expect(result.enabledToolIds).not.toContain(AgentDocumentsManifest.identifier);
    expect(result.enabledToolIds).not.toContain(STUDIO);
  });

  it('manual mode does not enable the unselected lazy catalog or suppress ordinary defaults', () => {
    const result = assemble({ configured: [] });
    expect(result.enabledToolIds).toEqual(['lobe-knowledge-base', 'lobe-topic-reference']);
    expect(result.tools?.map((tool) => tool.function.name)).toEqual([
      'lobe-knowledge-base____searchKnowledgeBase____builtin',
      'lobe-knowledge-base____readKnowledge____builtin',
      'lobe-topic-reference____getTopicContext____builtin',
    ]);
  });

  it('keeps explicit exclusions and capability rules even for configured tools', () => {
    const result = assemble({
      configured: [AgentDocumentsManifest.identifier, MemoryManifest.identifier, STUDIO],
      excluded: [STUDIO],
      hasDocuments: false,
      memory: false,
    });
    expect(result.enabledToolIds).not.toContain(STUDIO);
    expect(result.enabledToolIds).not.toContain(AgentDocumentsManifest.identifier);
    expect(result.enabledToolIds).not.toContain(MemoryManifest.identifier);
    expect(
      result.enabledManifests.every((manifest) => !manifest.identifier.includes('studio')),
    ).toBe(true);
  });

  it('does not revive an explicitly excluded default through a message pick', () => {
    const id = AgentDocumentsManifest.identifier;
    const result = assemble({ configured: [id], excluded: [id], picked: [id] });
    expect(result.enabledToolIds).not.toContain(id);
    expect(result.enabledManifests).not.toContainEqual(AgentDocumentsManifest);
    expect(result.tools?.some((tool) => tool.function.name.startsWith(id))).toBe(false);
  });

  it('a tool picked for the message remains eager in either mode', () => {
    for (const manual of [false, true]) {
      expect(assemble({ configured: [], manual, picked: [STUDIO] }).enabledToolIds).toContain(
        STUDIO,
      );
    }
  });

  it('the default prompt refers to the real memory manifest, not its removed name', () => {
    expect(DEFAULT_AGENT_CONFIG.systemRole).toContain(MemoryManifest.identifier);
    expect(DEFAULT_AGENT_CONFIG.systemRole).not.toMatch(/\blobe-memory\b/);
  });
});
