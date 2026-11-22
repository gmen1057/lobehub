// @vitest-environment node
import { ArckepLayoutApiName, ArckepLayoutIdentifier } from '@lobechat/builtin-tool-arckep-layout';
import { arckepLazyToolIds, builtinTools } from '@lobechat/builtin-tools';
import { builtinToolIdentifiers } from '@lobechat/builtin-tools/identifiers';
import { describe, expect, it, vi } from 'vitest';

import { type ToolExecutionContext } from '../../types';
import { arckepLayoutRuntime } from '../arckepLayout';
import { getServerRuntime, hasServerRuntime } from '../index';

// arckep (19.10.2026): регистрация инструмента arckep-layout и привязка рантайма к человеку и теме хода.

const dbWithEmail = (email: string | null) =>
  ({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (email ? [{ email }] : []) }) }),
    }),
  }) as any;

const context = (extra: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  parentMessageId: 'msg_A',
  serverDB: dbWithEmail('user15@arckep.ru'),
  toolManifestMap: {},
  topicId: 'tpc_1',
  userId: 'lobe-user-1',
  ...extra,
});

describe('регистрация arckep-layout', () => {
  it('серверный рантайм зарегистрирован, манифест в builtinTools скрыт и не «по требованию»', () => {
    expect(hasServerRuntime(ArckepLayoutIdentifier)).toBe(true);
    expect(arckepLayoutRuntime.identifier).toBe('arckep-layout');
    expect(builtinToolIdentifiers).toContain(ArckepLayoutIdentifier);
    const tool = builtinTools.find((item) => item.identifier === ArckepLayoutIdentifier)!;
    expect(tool).toMatchObject({ discoverable: false, hidden: true, type: 'builtin' });
    expect(tool.manifest.api.map((api) => api.name)).toEqual([
      ArckepLayoutApiName.checkLayout,
      ArckepLayoutApiName.editArtifact,
      ArckepLayoutApiName.writeArtifact,
      ArckepLayoutApiName.renderArtifact,
    ]);
    // включается в ход сразу (execAgent), а не через activateTools
    expect(arckepLazyToolIds).not.toContain(ArckepLayoutIdentifier);
  });

  it('манифест: identifier обязателен, HTML модель не передаёт в checkLayout/editArtifact/renderArtifact; writeArtifact принимает content', () => {
    const manifest = builtinTools.find(
      (item) => item.identifier === ArckepLayoutIdentifier,
    )!.manifest;
    const [check, edit, write, render] = manifest.api;
    expect(check.parameters.required).toEqual(['identifier']);
    expect(Object.keys(check.parameters.properties as object).sort()).toEqual([
      'file',
      'identifier',
    ]);
    expect(edit.parameters.required).toEqual(['identifier', 'edits']);
    const edits = (edit.parameters.properties as any).edits;
    expect(edits.maxItems).toBe(30);
    expect(edits.items.required).toEqual(['find', 'replace']);
    expect(write.parameters.required).toEqual(['identifier', 'title', 'content']);
    expect(render.parameters.required).toEqual(['identifier']);
    expect(Object.keys(render.parameters.properties as object).sort()).toEqual([
      'identifier',
      'lines',
      'width',
    ]);
    expect((render.parameters.properties as any).width).toMatchObject({
      maximum: 1600,
      minimum: 320,
    });
    expect((render.parameters.properties as any).lines).toMatchObject({ maxItems: 50 });
    // ни у одного вызова нет параметра с именем `html`
    for (const api of manifest.api) {
      expect(Object.keys(api.parameters.properties as object)).not.toContain('html');
    }
    expect(manifest.systemRole).toMatch(/never pass HTML as an argument/);
    expect(manifest.systemRole).toMatch(/checkLayout ONCE/);
    expect(manifest.systemRole).toMatch(/<renderArtifact>/);
    expect(manifest.systemRole).toMatch(/ONLY for complex visual HTML/);
    expect(manifest.systemRole).toMatch(/at most 1–2 times per turn/);
    expect(manifest.systemRole).toMatch(
      /Never withhold or hide an already generated HTML artifact/,
    );
    // приёмы, которые выбросит почта: письмо надо переписать обычным потоком и вызвать checkLayout ещё раз
    expect(manifest.systemRole).toMatch(/mail-breaking techniques/);
    expect(manifest.systemRole).toMatch(/nested tables/);
    expect(manifest.systemRole).toMatch(/call checkLayout again/);
    expect(check.description).toMatch(/again only after you rewrote a page/);
    expect(check.description).toMatch(/position:absolute\/fixed, flex, grid, float, <script>/);
    expect(render.description).toMatch(/ONLY for complex visual HTML/);
    expect(render.description).toMatch(/Never withhold or hide/);
  });
});

describe('рантайм', () => {
  it('нужны человек и база', () => {
    expect(() => arckepLayoutRuntime.factory(context({ userId: undefined }))).toThrow(
      /userId and serverDB are required/,
    );
    expect(() => arckepLayoutRuntime.factory(context({ serverDB: undefined }))).toThrow(
      /userId and serverDB are required/,
    );
  });

  it('создаётся через реестр и отвечает методами checkLayout / editArtifact / writeArtifact / renderArtifact', async () => {
    const runtime = await getServerRuntime(ArckepLayoutIdentifier, context());
    expect(typeof runtime.checkLayout).toBe('function');
    expect(typeof runtime.editArtifact).toBe('function');
    expect(typeof runtime.writeArtifact).toBe('function');
    expect(typeof runtime.renderArtifact).toBe('function');
  });

  it('вызов без темы — понятный отказ, а не падение хода', async () => {
    const runtime = await getServerRuntime(ArckepLayoutIdentifier, context({ topicId: undefined }));
    const result = await runtime.checkLayout({ identifier: 'mail' });
    expect(result.success).toBe(false);
    expect(result.content).toMatch(/нет темы чата/);
    const edit = await runtime.editArtifact({
      edits: [{ find: 'a', replace: 'b' }],
      identifier: 'mail',
    });
    expect(edit.success).toBe(false);
    const render = await runtime.renderArtifact({ identifier: 'mail' });
    expect(render.success).toBe(false);
    expect(render.content).toMatch(/нет темы чата/);
  });

  it('пустые аргументы — отказ без обращения к базе', async () => {
    const runtime = await getServerRuntime(ArckepLayoutIdentifier, context());
    const select = vi.fn();
    expect((await runtime.checkLayout({})).content).toMatch(/нужен identifier/);
    expect((await runtime.renderArtifact({})).content).toMatch(/нужен identifier/);
    expect((await runtime.editArtifact({ identifier: 'mail', edits: [] })).content).toMatch(
      /нужны identifier и непустой edits/,
    );
    expect(select).not.toHaveBeenCalled();
  });
});
