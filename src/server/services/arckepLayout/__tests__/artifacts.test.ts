import { describe, expect, it } from 'vitest';

import {
  artifactTag,
  collectHtmlVersions,
  escapeAttr,
  hasHtmlArtifact,
  parseArtifacts,
  parseChatFileId,
} from '../artifacts';

describe('теги <lobeArtifact>', () => {
  it('версия с телом: идентификатор, заголовок, тип, HTML без ограды кода', () => {
    const text = [
      'Вот письмо.',
      '<lobeArtifact identifier="mail-1" type="text/html" title="Письмо &quot;Клиника&quot;">',
      '```html',
      '<!doctype html><p>Привет</p>',
      '```',
      '</lobeArtifact>',
      'Готово.',
    ].join('\n');
    expect(parseArtifacts(text, 'm1')).toEqual([
      {
        body: '<!doctype html><p>Привет</p>',
        identifier: 'mail-1',
        messageId: 'm1',
        title: 'Письмо "Клиника"',
        type: 'text/html',
      },
    ]);
  });

  it('версия по ссылке: пустое тело и самозакрытый тег', () => {
    const empty =
      '<lobeArtifact identifier="a" type="text/html" title="T" src="https://arckep.ru/chat/f/file_X1/"></lobeArtifact>';
    const closed =
      '<lobeArtifact identifier="a" type="text/html" title="T" src="/chat/f/file_X2" />';
    expect(parseArtifacts(empty, 'm')[0]).toMatchObject({ srcFileId: 'file_X1' });
    expect(parseArtifacts(empty, 'm')[0].body).toBeUndefined();
    expect(parseArtifacts(closed, 'm')[0]).toMatchObject({ identifier: 'a', srcFileId: 'file_X2' });
  });

  it('чужой адрес в src не принимается: ни ссылки, ни тела — версия непригодна', () => {
    for (const src of [
      'https://arckep.ru.evil.com/chat/f/file_X/',
      'http://arckep.ru/chat/f/file_X/',
      '//arckep.ru/chat/f/file_X/',
      'https://arckep.ru/chat/f/file_X/?a=1',
      'https://arckep.ru/chat/f/../etc/',
    ]) {
      const [version] = parseArtifacts(
        `<lobeArtifact identifier="a" type="text/html" title="T" src="${src}"></lobeArtifact>`,
        'm',
      );
      expect(version.srcFileId).toBeUndefined();
      expect(version.body).toBeUndefined();
    }
    expect(parseChatFileId('https://arckep.ru/chat/f/abc-1_2/')).toBe('abc-1_2');
    expect(parseChatFileId(undefined)).toBeUndefined();
  });

  it('тело важнее ссылки: при обоих src отбрасывается', () => {
    const [version] = parseArtifacts(
      '<lobeArtifact identifier="a" type="text/html" src="/chat/f/file_X/"><p>x</p></lobeArtifact>',
      'm',
    );
    expect(version.body).toBe('<p>x</p>');
    expect(version.srcFileId).toBeUndefined();
  });

  it('несколько тегов в сообщении идут по порядку; недописанный тег — тело до конца текста', () => {
    const text =
      '<lobeArtifact identifier="a" type="text/html"><p>1</p></lobeArtifact> и ' +
      '<lobeArtifact identifier="b" type="image/svg+xml"><svg/></lobeArtifact> и ' +
      '<lobeArtifact identifier="c" type="text/html"><p>не закрыт';
    const versions = parseArtifacts(text, 'm');
    expect(versions.map((v) => v.identifier)).toEqual(['a', 'b', 'c']);
    expect(versions[2].body).toBe('<p>не закрыт');
  });

  it('collectHtmlVersions: только text/html, по порядку сообщений; несколько версий одного идентификатора', () => {
    const versions = collectHtmlVersions([
      {
        content:
          '<lobeArtifact identifier="mail" type="text/html" title="v1"><p>1</p></lobeArtifact>',
        id: 'm1',
      },
      { content: 'без тегов', id: 'm2' },
      {
        content: '<lobeArtifact identifier="logo" type="image/svg+xml"><svg/></lobeArtifact>',
        id: 'm3',
      },
      {
        content:
          '<lobeArtifact identifier="mail" type="text/html" title="v2" src="/chat/f/file_V2/"></lobeArtifact>',
        id: 'm4',
      },
      { content: null, id: 'm5' },
    ]);
    expect(versions.map((v) => `${v.messageId}:${v.identifier}:${v.title}`)).toEqual([
      'm1:mail:v1',
      'm4:mail:v2',
    ]);
    expect(versions[1].srcFileId).toBe('file_V2');
  });

  it('hasHtmlArtifact: дёшево находит HTML-артефакт, SVG не считается', () => {
    expect(hasHtmlArtifact('<lobeArtifact identifier="a" type="text/html">')).toBe(true);
    expect(hasHtmlArtifact("<lobeArtifact type='text/html' identifier='a'>")).toBe(true);
    expect(hasHtmlArtifact('<lobeArtifact identifier="a" type="image/svg+xml">')).toBe(false);
    expect(hasHtmlArtifact(null)).toBe(false);
  });

  it('тег для показа: атрибуты экранированы, формат — как ждёт экран студии (#694)', () => {
    const tag = artifactTag({
      identifier: 'mail-1',
      src: 'https://arckep.ru/chat/f/file_AB12/',
      title: 'Письмо "Клиника" <1>',
    });
    expect(tag).toBe(
      '<lobeArtifact identifier="mail-1" type="text/html" title="Письмо &quot;Клиника&quot; &lt;1&gt;" src="https://arckep.ru/chat/f/file_AB12/"></lobeArtifact>',
    );
    // тот же тег снова читается как версия по ссылке, название восстанавливается
    const [version] = parseArtifacts(tag, 'm');
    expect(version).toMatchObject({
      identifier: 'mail-1',
      srcFileId: 'file_AB12',
      title: 'Письмо "Клиника" <1>',
    });
    expect(escapeAttr('a&b')).toBe('a&amp;b');
  });
});
