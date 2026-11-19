import { MessagesEngine } from '@lobechat/context-engine';
import { ARCKEP_MOCKUP_LAYOUT_PROMPT } from '@lobechat/prompts';
import { describe, expect, it } from 'vitest';

import { builtinSkills } from '../../../../../packages/builtin-skills/src';
import { DEFAULT_AGENT_CONFIG } from '../../../../../packages/const/src/settings/agent';

// arckep (19.10.2026): как модель отдаёт готовую HTML-страницу. Правила в системном промпте помощника (картинки из
// вложений, шрифты) не должны спорить с навыком Artifacts: он подключается в тот же запрос.
// Ситуативные правила вёрстки PDF-макета (`Mockup layout` / `checkLayout`) и перевода вложений
// (`<attached_file_translation>`) больше не едут в каждом текстовом чате — их добавляет
// `ArckepConditionalRulesProvider` только при наличии `<layout>` или вложенных файлов.

const systemRole = DEFAULT_AGENT_CONFIG.systemRole ?? '';
const artifactsSkill = builtinSkills.find((skill) => skill.identifier === 'lobe-artifacts')!;
const skill = artifactsSkill.content;

/** Раздел HTML навыка: от «### **HTML**» до следующего раздела. */
const htmlSection = skill.slice(skill.indexOf('### **HTML**'), skill.indexOf('### **SVG**'));

describe('системный промпт помощника: готовые страницы', () => {
  it('HTML-страница, письмо, лендинг, SVG — всегда в <lobeArtifact>, не блоком кода', () => {
    expect(systemRole).toContain('<lobeArtifact type="text/html"');
    expect(systemRole).toMatch(/HTML page, email, landing page or SVG/);
    expect(systemRole).toMatch(/never into a code block/);
    // отдельный SVG — тип навыка
    expect(systemRole).toContain('image/svg+xml');
  });

  it('картинки в HTML: адреса из <attachments> и результатов create_image / get_image, заглушка только без подходящей', () => {
    expect(systemRole).toContain('<attachments>');
    expect(systemRole).toContain('create_image');
    expect(systemRole).toContain('get_image');
    expect(systemRole).toMatch(/placeholder only when no suitable picture exists/);
  });

  it('шрифты: Google Fonts по прямой ссылке; другой шрифт — песочница, файл чата /chat/f/…, @font-face', () => {
    expect(systemRole).toMatch(/Google Fonts by a direct link/);
    expect(systemRole).toContain('sandbox');
    expect(systemRole).toContain('/chat/f/');
    expect(systemRole).toContain('@font-face');
  });

  it('обычный текстовый чат не тащит правила PDF-макета и перевода вложений в базовом systemRole', () => {
    expect(systemRole).not.toContain('Mockup layout:');
    expect(systemRole).not.toContain('checkLayout');
    expect(systemRole).not.toContain('Файлы на перевод');
    expect(systemRole.length).toBeLessThan(1300);
  });

  it('условный блок PDF-макета сохраняет все правила вёрстки по <layout>, checkLayout и editArtifact', () => {
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toContain('<layout>');
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/build the HTML to its numbers/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /font sizes, colors, line breaks, and widths, paddings and gaps worked out from its positions/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/never placing elements by their coordinates/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /an email as nested tables with inline styles, without position:absolute\/fixed, flex or grid/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).not.toMatch(/font sizes, positions, colors/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/pictures, icons and logos only from its crops/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/never replace an icon with text or emoji/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/font hint/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /do not claim the result matches the mockup exactly/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/list what differs/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(/gives their own image addresses for the mockup/);
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /use those instead of the crops, matched to the right places/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /unclear which address goes where, ask before building/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /call checkLayout once \(again only after rewriting a page it says still uses mail-breaking techniques\)/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toContain('<lobeArtifact … src="…">');
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /never re-print the whole HTML after checkLayout or editArtifact/,
    );
    expect(ARCKEP_MOCKUP_LAYOUT_PROMPT).toMatch(
      /later changes to an existing HTML artifact use editArtifact with small edits/i,
    );
  });

  it('MessagesEngine: опускает Mockup layout в обычном чате и добавляет при наличии <layout>', async () => {
    const plain = await new MessagesEngine({
      enableSystemDate: false,
      messages: [
        { content: 'Привет, как дела?', createdAt: 0, id: 'u1', role: 'user', updatedAt: 0 },
      ],
      model: 'deepseek-flash',
      provider: 'deepseek',
      systemRole,
    }).process();
    const plainSys = String(plain.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(plainSys).not.toContain('Mockup layout:');
    expect(plainSys).not.toContain('checkLayout');

    const withLayout = await new MessagesEngine({
      enableSystemDate: false,
      messages: [
        {
          content: 'Сверстай письмо по макету\n<layout file="mail.pdf">...</layout>',
          createdAt: 0,
          id: 'u2',
          role: 'user',
          updatedAt: 0,
        },
      ],
      model: 'deepseek-flash',
      provider: 'deepseek',
      systemRole,
    }).process();
    const layoutSys = String(withLayout.messages.find((m) => m.role === 'system')?.content ?? '');
    expect(layoutSys).toContain('Mockup layout:');
    expect(layoutSys).toContain('call checkLayout once');
    expect(layoutSys).toContain('editArtifact');
  });

  it('базовые якоря на месте: студия (картинки, видео) и память', () => {
    expect(systemRole).toContain('mcp-arckep-studio-images');
    expect(systemRole).toContain('-video');
    expect(systemRole).toContain('lobe-user-memory');
  });
});

describe('навык Artifacts не спорит с системным промптом', () => {
  it('навык найден и содержит раздел HTML', () => {
    expect(artifactsSkill).toBeDefined();
    expect(htmlSection).toContain('text/html');
  });

  it('HTML: больше нет запрета на внешние картинки — разрешены адреса вложений и результатов', () => {
    expect(htmlSection).not.toMatch(/No external images/);
    expect(htmlSection).toContain('<attachments>');
    expect(htmlSection).toContain('create_image / get_image');
  });

  it('HTML: заглушка /api/placeholder остаётся, но только если подходящей картинки нет', () => {
    expect(htmlSection).toContain('/api/placeholder/WIDTH/HEIGHT');
    expect(htmlSection).toMatch(/only when no suitable picture exists/);
  });

  it('HTML: Google Fonts и файлы чата разрешены, остальное по-прежнему только cdnjs', () => {
    expect(htmlSection).toContain('cdnjs.cloudflare.com');
    expect(htmlSection).toContain('Google Fonts');
    expect(htmlSection).toContain('/chat/f/<id>/');
    expect(htmlSection).toContain('@font-face');
  });

  it('HTML: макет с блоком <layout> — по его числам, картинки и значки из вырезок, без «точно», с перечнем отличий', () => {
    expect(htmlSection).toContain('<layout>');
    expect(htmlSection).toMatch(/build to its numbers/);
    expect(htmlSection).toMatch(/never placing elements by their coordinates/);
    expect(htmlSection).toMatch(
      /an email as nested tables with inline styles, without position:absolute\/fixed, flex or grid/,
    );
    expect(htmlSection).toMatch(/only from its crops/);
    expect(htmlSection).toMatch(/never replace an icon with text or emoji/);
    expect(htmlSection).toMatch(/follow its font hint/);
    expect(htmlSection).toMatch(/do not claim the result matches the mockup exactly/);
    expect(htmlSection).toMatch(/list what differs/);
  });

  it('HTML: свои адреса картинок от человека — вместо вырезок на нужные места; непонятно, какой куда, — спросить до вёрстки', () => {
    expect(htmlSection).toMatch(/gives their own image addresses for the mockup/);
    expect(htmlSection).toMatch(/use those instead of the crops, matched to the right places/);
    expect(htmlSection).toMatch(/unclear which address goes where, ask before building/);
  });

  it('HTML: после вёрстки по макету — один checkLayout и показ коротким тегом src; правки — editArtifact', () => {
    expect(htmlSection).toMatch(/call `checkLayout` once/);
    expect(htmlSection).toContain('<lobeArtifact … src="…">');
    expect(htmlSection).toMatch(
      /never re-print the whole HTML after `checkLayout` or `editArtifact`/,
    );
    expect(htmlSection).toMatch(
      /call `editArtifact` with small find\/replace edits instead of re-printing the page/,
    );
    expect(htmlSection).toMatch(
      /again only after rewriting a page it says still uses mail-breaking techniques/,
    );
  });

  it('SVG и React: правила не тронуты', () => {
    const svg = skill.slice(skill.indexOf('### **SVG**'), skill.indexOf('### **React**'));
    expect(svg).toContain('viewBox');
    const react = skill.slice(skill.indexOf('### **React**'), skill.indexOf('## Step C'));
    expect(react).toMatch(/No external images \(use placeholders/);
  });
});
