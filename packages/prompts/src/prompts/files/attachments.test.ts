import { describe, expect, it } from 'vitest';

import { attachmentsPrompts } from './attachments';
import { filesPrompts } from './index';

// arckep (19.10.2026): список вложений для модели — имя, тип, размер в точках, адрес ОРИГИНАЛА.

const original = {
  height: 23_050,
  mime: 'image/jpeg',
  name: 'макет.jpg',
  url: 'https://arckep.ru/chat/f/orig_1/',
  width: 2512,
};

describe('attachmentsPrompts', () => {
  it('нет вложений — пусто', () => {
    expect(attachmentsPrompts(undefined)).toBe('');
    expect(attachmentsPrompts([])).toBe('');
  });

  it('одна строка на файл: имя · тип · размер в точках · адрес', () => {
    const result = attachmentsPrompts([
      original,
      { mime: 'application/pdf', name: 'tmpl.pdf', url: 'https://arckep.ru/chat/f/pdf_1/' },
    ]);

    expect(result).toContain('<attachments>');
    expect(result).toContain('</attachments>');
    expect(result).toContain(
      '- макет.jpg · image/jpeg · 2512×23050 px · https://arckep.ru/chat/f/orig_1/',
    );
    // у файла без размеров размера в строке нет
    expect(result).toContain('- tmpl.pdf · application/pdf · https://arckep.ru/chat/f/pdf_1/');
    // строки только с адресами: ни содержимого, ни лишних полей
    expect(result.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(2);
  });

  it('пометка и картинки из PDF: «картинка N из …», страница, размер, адрес', () => {
    const result = attachmentsPrompts([
      {
        height: 400,
        mime: 'image/png',
        name: 'картинка 3 из tmpl.pdf',
        note: 'стр. 2',
        url: 'https://arckep.ru/chat/f/img_3/',
        width: 800,
      },
    ]);
    expect(result).toContain(
      '- картинка 3 из tmpl.pdf · image/png · 800×400 px · стр. 2 · https://arckep.ru/chat/f/img_3/',
    );
  });

  it('поясняет модели, зачем адреса: вставить в HTML или скачать в песочнице', () => {
    const result = attachmentsPrompts([original]);
    expect(result).toContain('<attachments_docstring>');
    expect(result).toMatch(/img src/);
    expect(result).toMatch(/@font-face/);
    expect(result).toMatch(/sandbox/);
  });

  it('прибавка токенов мала: строка с адресом — около 150 знаков', () => {
    const result = attachmentsPrompts([original]);
    const line = result.split('\n').find((row) => row.startsWith('- '))!;
    expect(line.length).toBeLessThan(150);
  });
});

describe('filesPrompts со списком вложений', () => {
  const image = {
    alt: 'макет.jpg',
    id: 'img-1',
    url: 'https://s3.example/signed/part-1?X-Amz-Signature=abcdef',
  };
  const file = {
    fileType: 'application/pdf',
    id: 'file-1',
    name: 'tmpl.pdf',
    size: 1024,
    url: 'https://s3.example/signed/tmpl.pdf?X-Amz-Signature=abcdef',
  };

  it('блок <attachments> внутри <files_info>, адреса копий не повторяются', () => {
    const result = filesPrompts({
      attachments: [original],
      fileList: [file],
      imageList: [image],
    });

    expect(result).toContain('<files_info>');
    expect(result).toContain('<attachments>');
    expect(result.indexOf('<attachments>')).toBeLessThan(result.indexOf('</files_info>'));
    expect(result).toContain('https://arckep.ru/chat/f/orig_1/');
    // длинные подписанные адреса копий (сотни токенов на картинку) в тексте не повторяются
    expect(result).not.toContain('X-Amz-Signature');
    expect(result).toContain('name="макет.jpg"');
  });

  it('без списка вложений всё как раньше: адреса копий на месте', () => {
    const result = filesPrompts({ fileList: [file], imageList: [image] });

    expect(result).not.toContain('<attachments>');
    expect(result).toContain('url="https://s3.example/signed/part-1?X-Amz-Signature=abcdef"');
  });

  it('есть только список вложений без картинок и файлов — ничего не добавляется', () => {
    expect(filesPrompts({ attachments: [original] })).toBe('');
  });
});
