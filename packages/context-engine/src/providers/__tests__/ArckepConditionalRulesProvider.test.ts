import { describe, expect, it } from 'vitest';

import { MessagesEngine } from '../../engine/messages/MessagesEngine';
import type { LobeToolManifest } from '../../engine/tools/types';
import type { PipelineContext } from '../../types';
import { ArckepConditionalRulesProvider } from '../ArckepConditionalRulesProvider';

const headlessActivatorManifest: LobeToolManifest = {
  api: [{ description: 'Activate tools', name: 'activateTools', parameters: { type: 'object' } }],
  identifier: 'lobe-activator',
  meta: { title: 'Активатор инструментов' },
  systemRole: '<on_demand_tools>stub activator</on_demand_tools>',
  type: 'builtin',
};

const figmaManifest: LobeToolManifest = {
  api: [
    {
      description: 'Read design nodes via get_design_context',
      name: 'get_design_context',
      parameters: { type: 'object' },
    },
  ],
  identifier: 'mcp-arckep-figma',
  meta: { title: 'Figma' },
  systemRole: 'Figma tool manifest mentioning get_design_context',
  type: 'mcp',
};

const createContext = (messages: any[]): PipelineContext => ({
  initialState: {
    messages: [],
    model: 'deepseek-flash',
    provider: 'deepseek',
    systemRole: '',
    tools: [],
  },
  isAborted: false,
  messages,
  metadata: {},
});

describe('ArckepConditionalRulesProvider', () => {
  it('injects nothing on plain text chats', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Ты — помощник Arckep AI на chat.arckep.ru.', role: 'system' },
        { content: 'Объясни теорему Байеса простыми словами', role: 'user' },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toBe('Ты — помощник Arckep AI на chat.arckep.ru.');
    expect(sys).not.toContain('Mockup layout:');
    expect(sys).not.toContain('<attached_file_translation>');
    expect(sys).not.toContain('<figma_playbook>');
    expect(result.metadata.arckepConditionalRules).toBeUndefined();
  });

  it('injects Mockup layout + checkLayout rules when metadata.layouts is present', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Base system role', role: 'system' },
        {
          content: 'Сверстай письмо по PDF',
          metadata: { layouts: [{ file: 'mockup.pdf', pages: [{ lines: [{ text: 'Hi' }] }] }] },
          role: 'user',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toContain('Mockup layout:');
    expect(sys).toContain('call checkLayout once');
    expect(sys).toContain('writeArtifact');
    expect(sys).toContain('editArtifact');
    expect(result.metadata.arckepConditionalRules).toEqual({
      figmaPlaybook: false,
      fileTranslation: false,
      mockupLayout: true,
    });
  });

  it('injects Mockup layout rules when message text contains <layout ...>', async () => {
    const provider = new ArckepConditionalRulesProvider({});
    const result = await provider.process(
      createContext([
        { content: 'Base', role: 'system' },
        { content: '<layout file="a.pdf">content</layout>', role: 'user' },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toContain('Mockup layout:');
    expect(sys).toContain('nested tables with inline styles');
    expect(result.metadata.arckepConditionalRules?.mockupLayout).toBe(true);
  });

  it('injects headless <attached_file_translation> without lobe-skill-store when files are attached', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Base', role: 'system' },
        {
          content: 'Переведи этот файл на английский',
          fileList: [{ id: 'file-1', name: 'book.pdf' }],
          role: 'user',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toContain('<attached_file_translation>');
    expect(sys).toContain('createDocument');
    expect(sys).toContain('mcp-arckep-studio-documents');
    expect(sys).not.toContain('lobe-skill-store');
    expect(result.metadata.arckepConditionalRules?.fileTranslation).toBe(true);
  });

  it('injects browser <attached_file_translation> forbidding lobe-skill-store when skill store is present', async () => {
    const provider = new ArckepConditionalRulesProvider({
      availableToolIds: ['lobe-skill-store'],
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Base', role: 'system' },
        {
          content: 'Translate attached file',
          fileList: [{ id: 'file-1', name: 'doc.docx' }],
          role: 'user',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toContain('<attached_file_translation>');
    expect(sys).toContain('Do NOT activate `lobe-skill-store`');
  });

  it('does not inject <attached_file_translation> for generic non-Arckep chats without activator', async () => {
    const provider = new ArckepConditionalRulesProvider({
      hasKnowledgeFiles: true,
    });
    const result = await provider.process(
      createContext([
        { content: 'You are a generic helper.', role: 'system' },
        { content: 'Summarize the document', role: 'user' },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toBe('You are a generic helper.');
    expect(sys).not.toContain('<attached_file_translation>');
  });

  it('does not trigger <attached_file_translation> on assistant-generated imageList or fileList', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Ты — помощник Arckep AI на chat.arckep.ru.', role: 'system' },
        { content: 'Нарисуй закат', role: 'user' },
        {
          content: 'Готово!',
          imageList: [{ id: 'gen-1', url: 'https://cdn.example/sunset.png' }],
          role: 'assistant',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).not.toContain('<attached_file_translation>');
    expect(result.metadata.arckepConditionalRules).toBeUndefined();
  });

  it('skips <attached_file_translation> when legacy DB systemRole already contains "Файлы на перевод:"', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const legacy =
      'Ты — помощник Arckep AI на chat.arckep.ru.\n\nФайлы на перевод: не лей книгу в чат.';
    const result = await provider.process(
      createContext([
        { content: legacy, role: 'system' },
        {
          content: 'Переведи этот файл',
          fileList: [{ id: 'f1', name: 'doc.pdf' }],
          role: 'user',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toBe(legacy);
    expect(sys).not.toContain('<attached_file_translation>');
  });

  it('injects <figma_playbook> when a Figma URL is present or mcp-arckep-figma is active (even if manifest mentions get_design_context)', async () => {
    const fromLink = await new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    }).process(
      createContext([
        { content: 'Base', role: 'system' },
        { content: 'Посмотри макет https://www.figma.com/design/abc123/Landing', role: 'user' },
      ]),
    );
    const linkSys = fromLink.messages.find((m) => m.role === 'system')?.content as string;
    expect(linkSys).toContain('<figma_playbook>');
    expect(linkSys).toContain('get_design_context');
    expect(linkSys).toContain('~20 reads/month');
    expect(fromLink.metadata.arckepConditionalRules?.figmaPlaybook).toBe(true);

    // Regression: ToolSystemRoleProvider injects mcp-arckep-figma's manifest (containing get_design_context)
    // BEFORE ArckepConditionalRulesProvider runs; <figma_playbook> must still be injected.
    const fromToolEngine = await new MessagesEngine({
      enableSystemDate: false,
      messages: [
        {
          content: 'Теперь сверстай этот экран',
          createdAt: 0,
          id: 'u1',
          role: 'user',
          updatedAt: 0,
        },
      ],
      model: 'deepseek-flash',
      provider: 'deepseek',
      systemRole: 'Base',
      toolsConfig: {
        manifests: [figmaManifest],
        tools: ['mcp-arckep-figma'],
      },
    }).process();
    const toolSys = String(fromToolEngine.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(toolSys).toContain('Figma tool manifest mentioning get_design_context');
    expect(toolSys).toContain('<figma_playbook>');
  });

  it('preserves conditional rules when triggers live inside compressedGroup.compressedMessages', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest],
      toolIds: ['lobe-activator'],
    });
    const result = await provider.process(
      createContext([
        { content: 'Ты — помощник Arckep AI на chat.arckep.ru.', role: 'system' },
        {
          compressedMessages: [
            {
              content: 'Вот макет и ссылка https://figma.com/design/xyz/Hero',
              fileList: [{ id: 'f1', name: 'mail.pdf' }],
              metadata: {
                layouts: [{ file: 'mail.pdf', pages: [{ lines: [{ text: 'Title' }] }] }],
              },
              role: 'user',
            },
            {
              content: 'Сделал первый вариант',
              imageList: [{ id: 'img-a', url: 'https://cdn.example/a.png' }],
              role: 'assistant',
            },
          ],
          content: 'Summary of earlier turns',
          role: 'compressedGroup',
        },
        { content: 'Подправь кнопку в письме', role: 'user' },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toContain('Mockup layout:');
    expect(sys).toContain('<attached_file_translation>');
    expect(sys).toContain('<figma_playbook>');
    expect(result.metadata.arckepConditionalRules).toEqual({
      figmaPlaybook: true,
      fileTranslation: true,
      mockupLayout: true,
    });
  });

  it('is idempotent and does not duplicate blocks already present in systemRole', async () => {
    const provider = new ArckepConditionalRulesProvider({
      manifests: [headlessActivatorManifest, figmaManifest],
      toolIds: ['lobe-activator', 'mcp-arckep-figma'],
    });
    const existing =
      'Mockup layout: already here\n<attached_file_translation>existing</attached_file_translation>\n<figma_playbook>existing</figma_playbook>';
    const result = await provider.process(
      createContext([
        { content: existing, role: 'system' },
        {
          content: '<layout file="a.pdf">x</layout> https://figma.com/design/abc/Test',
          fileList: [{ id: 'f1', name: 'a.pdf' }],
          role: 'user',
        },
      ]),
    );

    const sys = result.messages.find((m) => m.role === 'system')?.content as string;
    expect(sys).toBe(existing);
  });

  it('wires end-to-end inside MessagesEngine: plain chat omits conditional blocks, mockup+file chat includes them', async () => {
    const plain = await new MessagesEngine({
      enableSystemDate: false,
      messages: [{ content: 'Привет!', createdAt: 0, id: 'm1', role: 'user', updatedAt: 0 }],
      model: 'deepseek-flash',
      provider: 'deepseek',
      systemRole: 'Ты — помощник Arckep AI на chat.arckep.ru.',
      toolsConfig: {
        manifests: [headlessActivatorManifest],
        tools: ['lobe-activator'],
      },
    }).process();
    const plainSys = String(plain.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(plainSys).not.toContain('Mockup layout:');
    expect(plainSys).not.toContain('<attached_file_translation>');
    expect(plainSys).not.toContain('<figma_playbook>');

    const rich = await new MessagesEngine({
      enableSystemDate: false,
      messages: [
        {
          content: 'Сверстай по макету <layout file="mail.pdf">x</layout>',
          createdAt: 0,
          fileList: [
            {
              fileType: 'application/pdf',
              id: 'f1',
              name: 'mail.pdf',
              size: 100,
              url: '/chat/f/f1',
            },
          ],
          id: 'm2',
          role: 'user',
          updatedAt: 0,
        } as any,
      ],
      model: 'deepseek-flash',
      provider: 'deepseek',
      systemRole: 'Ты — помощник Arckep AI на chat.arckep.ru.',
      toolsConfig: {
        manifests: [headlessActivatorManifest],
        tools: ['lobe-activator'],
      },
    }).process();
    const richSys = String(rich.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(richSys).toContain('Mockup layout:');
    expect(richSys).toContain('call checkLayout once');
    expect(richSys).toContain('<attached_file_translation>');
    expect(richSys).not.toContain('<figma_playbook>');
    expect(richSys.length).toBeGreaterThan(plainSys.length + 1800);
  });
});
