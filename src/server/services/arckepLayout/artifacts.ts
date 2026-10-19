/**
 * arckep (19.10.2026): артефакты `<lobeArtifact identifier="…" type="text/html" title="…">…</lobeArtifact>` в ответах
 * помощника — чтобы инструменты `checkLayout` и `editArtifact` сами находили последнюю версию письма, а модель не
 * передавала HTML аргументом (это снова дорого).
 *
 * Версия бывает двух видов: с телом (модель напечатала HTML) и со ссылкой на файл чата
 * (`src="https://arckep.ru/chat/f/<id>/"`, тело пустое — так показывает результат сам движок; экран студии это
 * умеет, PR студии #694). Последняя версия — самая поздняя по порядку сообщений ассистента темы и по порядку тегов
 * в сообщении. Сообщение текущего хода уже в базе: `call_llm` сохраняет текст до вызова инструментов.
 */

export interface ArtifactVersion {
  body?: string;
  identifier: string;
  /** Сообщение, в котором стоит тег */
  messageId: string;
  /** Файл чата, из которого берётся содержимое (номер файла) */
  srcFileId?: string;
  title: string;
  type: string;
}

const TAG_RE = /<lobeArtifact\b([^>]*?)(\/?)>/g;
const ATTR_RE = /([A-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CLOSE = '</lobeArtifact>';

const decodeEntities = (value: string) =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/** Значения атрибута для тега: кавычки и угловые скобки экранируются (так тег разбирает и экран студии). */
export const escapeAttr = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

/** Адрес файла чата в `src` (`/chat/f/<id>/`, с хостом или без) → номер файла; чужой адрес — `undefined`. */
export const parseChatFileId = (src: string | undefined): string | undefined =>
  src ? /^(?:https:\/\/arckep\.ru)?\/chat\/f\/([\w-]{1,64})\/?$/.exec(src.trim())?.[1] : undefined;

/** Тело без общей ограды кода: модель иногда заворачивает HTML в ```html внутри тега. */
const cleanBody = (raw: string) => {
  let body = raw
    .replace(/^[ \t]*\r?\n/, '')
    .replaceAll('\r\n', '\n')
    .trimEnd();
  body = body.replace(/^[ \t]*```[^\n]*\n/, '').replace(/\n?[ \t]*```$/, '');
  return body.trim();
};

/** Все артефакты текста по порядку. Недописанный тег (нет закрывающего) — тело до конца текста. */
export const parseArtifacts = (text: string, messageId: string): ArtifactVersion[] => {
  const versions: ArtifactVersion[] = [];
  let from = 0;
  while (from < text.length) {
    TAG_RE.lastIndex = from;
    const match = TAG_RE.exec(text);
    if (!match) break;
    const attrs: Record<string, string> = {};
    for (const attr of match[1].matchAll(ATTR_RE)) {
      attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? '');
    }
    const selfClosing = match[2] === '/';
    let end = match.index + match[0].length;
    let body = '';
    if (!selfClosing) {
      const close = text.indexOf(CLOSE, end);
      body = cleanBody(text.slice(end, close < 0 ? text.length : close));
      end = close < 0 ? text.length : close + CLOSE.length;
    }
    // тело важнее ссылки: при обоих `src` отбрасывается (как в экране студии)
    const srcFileId = body ? undefined : parseChatFileId(attrs.src);
    versions.push({
      ...(body ? { body } : {}),
      identifier: attrs.identifier ?? '',
      messageId,
      ...(srcFileId ? { srcFileId } : {}),
      title: attrs.title ?? '',
      type: attrs.type ?? '',
    });
    from = end;
  }
  return versions;
};

export const isHtmlArtifact = (version: Pick<ArtifactVersion, 'type'>) =>
  version.type.trim().toLowerCase() === 'text/html';

/** Версии HTML-артефактов из сообщений ассистента темы (по возрастанию времени), все. */
export const collectHtmlVersions = (
  messages: Array<{ content: string | null; id: string }>,
): ArtifactVersion[] =>
  messages.flatMap((message) =>
    message.content && message.content.includes('<lobeArtifact')
      ? parseArtifacts(message.content, message.id).filter(isHtmlArtifact)
      : [],
  );

/** Есть ли в тексте хоть один HTML-артефакт (дёшево, без разбора тела). */
export const hasHtmlArtifact = (content: string | null | undefined): boolean =>
  Boolean(content && /<lobeArtifact(?:\s[^>]*)?\stype\s*=\s*["']text\/html["']/i.test(content));

/** Тег для показа версии из файла чата: HTML заново печатать не нужно. */
export const artifactTag = (params: { identifier: string; src: string; title: string }): string =>
  `<lobeArtifact identifier="${escapeAttr(params.identifier)}" type="text/html" title="${escapeAttr(params.title)}" src="${escapeAttr(params.src)}"></lobeArtifact>`;
