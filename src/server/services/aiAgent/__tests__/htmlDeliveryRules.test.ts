import { builtinSkills } from '@lobechat/builtin-skills';
import { DEFAULT_AGENT_CONFIG } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

// arckep (19.10.2026): как модель отдаёт готовую HTML-страницу. Правила в системном промпте помощника (картинки из
// вложений, шрифты) не должны спорить с навыком Artifacts: он подключается в тот же запрос.

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

  it('макет PDF с блоком <layout>: верстать по его числам, картинки и значки только из вырезок, не писать «точно»', () => {
    expect(systemRole).toContain('<layout>');
    expect(systemRole).toMatch(/build the HTML to its numbers/);
    expect(systemRole).toMatch(
      /font sizes, colors, line breaks, and widths, paddings and gaps worked out from its positions/,
    );
    // 19.10 живая проверка: по точным координатам модель расставила всё position:absolute — в почте это разваливается
    expect(systemRole).toMatch(/never placing elements by their coordinates/);
    expect(systemRole).toMatch(
      /an email as nested tables with inline styles, without position:absolute\/fixed, flex or grid/,
    );
    expect(systemRole).not.toMatch(/font sizes, positions, colors/);
    expect(systemRole).toMatch(/pictures, icons and logos only from its crops/);
    expect(systemRole).toMatch(/never replace an icon with text or emoji/);
    expect(systemRole).toMatch(/font hint/);
    expect(systemRole).toMatch(/do not claim the result matches the mockup exactly/);
    expect(systemRole).toMatch(/list what differs/);
  });

  it('макет: свои адреса картинок от человека — вместо вырезок на нужные места; непонятно, какой куда, — спросить до вёрстки', () => {
    expect(systemRole).toMatch(/gives their own image addresses for the mockup/);
    expect(systemRole).toMatch(/use those instead of the crops, matched to the right places/);
    expect(systemRole).toMatch(/unclear which address goes where, ask before building/);
  });

  it('сверка с макетом: после вёрстки по <layout> один вызов checkLayout, результат коротким тегом src, HTML заново не печатать', () => {
    expect(systemRole).toMatch(/call checkLayout once/);
    expect(systemRole).toContain('<lobeArtifact … src="…">');
    expect(systemRole).toMatch(/never re-print the whole HTML after checkLayout or editArtifact/);
  });

  it('сверка: после переписывания письма, в котором остались приёмы почты, — ещё один checkLayout', () => {
    expect(systemRole).toMatch(
      /call checkLayout once \(again only after rewriting a page it says still uses mail-breaking techniques\)/,
    );
  });

  it('правки по просьбе человека: editArtifact малыми правками вместо печати страницы заново', () => {
    expect(systemRole).toMatch(
      /later changes to an existing HTML artifact use editArtifact with small edits/i,
    );
  });

  it('прежние правила на месте: студия, видео с оценкой, перевод файлов', () => {
    expect(systemRole).toContain('mcp-arckep-studio-images');
    expect(systemRole).toContain('mcp-arckep-studio-video');
    expect(systemRole).toContain('Файлы на перевод');
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
