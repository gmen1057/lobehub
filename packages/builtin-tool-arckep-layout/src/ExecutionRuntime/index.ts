import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type CheckLayoutParams,
  type CheckLayoutResult,
  type CheckRoundSummary,
  type CheckSnapshot,
  type EditArtifactParams,
  type EditArtifactResult,
  type RenderArtifactParams,
  type RenderArtifactResult,
  type TechniqueSummary,
  type WriteArtifactParams,
  type WriteArtifactResult,
} from '../types';

interface ArckepLayoutRuntimeDeps {
  checkLayout: (params: CheckLayoutParams) => Promise<CheckLayoutResult>;
  editArtifact: (params: EditArtifactParams) => Promise<EditArtifactResult>;
  renderArtifact: (params: RenderArtifactParams) => Promise<RenderArtifactResult>;
  writeArtifact: (params: WriteArtifactParams) => Promise<WriteArtifactResult>;
}

const percent = (value: number | undefined) =>
  value === undefined ? '—' : `${value.toFixed(1).replace('.', ',')} %`;

const snapshot = (value: CheckSnapshot | undefined) =>
  value
    ? `похожесть ${percent(value.similarity)}, расхождений ${value.issues}, строк найдено ${value.linesFound} из ${value.linesTotal}`
    : 'нет данных';

const ROUND_WORDS: Record<CheckRoundSummary['status'], string> = {
  accepted: 'принят',
  editor_failed: 'правщик не ответил',
  no_edits: 'правок не получено',
  nothing_applied: 'правки не применились',
  render_failed: 'отрисовка после правок не удалась',
  rolled_back: 'откат (стало хуже)',
};

const STOP_WORDS: Record<NonNullable<CheckLayoutResult['stopped']>, string> = {
  clean: 'письмо совпало с макетом по замерам и по картинке',
  editor_failed: 'правщик недоступен',
  render_failed: 'отрисовка недоступна',
  rolled_back:
    'правки сделали хуже и откачены, новых кругов не было (эту же версию заново не сверяй — выйдет то же)',
  rounds: 'использованы все круги',
  time: 'вышло время',
};

const roundLine = (round: CheckRoundSummary) => {
  const gain =
    round.similarityBefore !== undefined && round.similarityAfter !== undefined
      ? `, похожесть ${percent(round.similarityBefore)} → ${percent(round.similarityAfter)}`
      : '';
  const edits =
    round.applied + round.rejected > 0
      ? `, правок применено ${round.applied}, не применено ${round.rejected}`
      : '';
  const note = round.note ? ` — ${round.note.replaceAll(/\s+/g, ' ').slice(0, 220)}` : '';
  return `${round.round}) ${ROUND_WORDS[round.status]}${gain}${edits}${note}`;
};

const techniqueList = (items: TechniqueSummary[]) =>
  items
    .map(
      (item) => `${item.label} ×${item.count}${item.example ? ` (пример: ${item.example})` : ''}`,
    )
    .join('; ');

const REWRITE =
  'Перепиши письмо обычным потоком: вложенные таблицы, стили в style, без position:absolute/fixed, flex, grid, float, <script> и <link rel=stylesheet>; ширины, отступы и выравнивание посчитай по положению элементов в макете.';

const SHOW_TAG = 'Покажи письмо ТОЛЬКО этим тегом (HTML заново не печатай ни целиком, ни частями):';

/**
 * ArcKep Layout Execution Runtime (server-side only).
 *
 * Данные и вызовы подключает src/server/services/toolExecution/serverRuntimes/arckepLayout.ts; здесь только
 * текст ответа модели: что сделано, что осталось и готовый тег со `src` для показа.
 */
export class ArckepLayoutExecutionRuntime {
  private deps: ArckepLayoutRuntimeDeps;

  constructor(deps: ArckepLayoutRuntimeDeps) {
    this.deps = deps;
  }

  async checkLayout(args: CheckLayoutParams): Promise<BuiltinServerRuntimeOutput> {
    if (!args?.identifier || typeof args.identifier !== 'string') {
      return { content: 'checkLayout: нужен identifier HTML-артефакта.', success: false };
    }
    try {
      const result = await this.deps.checkLayout(args);

      const leftTechniques = result.techniques?.left ?? [];
      const beforeTechniques = result.techniques?.before ?? [];

      if (result.status === 'unavailable') {
        const broken =
          leftTechniques.length > 0
            ? ` Но и без отрисовки видно: в письме приёмы, которые выбросит почта (Gmail, Outlook): ${techniqueList(leftTechniques)}. ${REWRITE} Новое письмо покажи сразу, checkLayout в этом ответе повторно не вызывай.`
            : '';
        return {
          content:
            `Сверка с макетом сейчас недоступна: ${result.unavailableReason ?? 'причина неизвестна'}. ` +
            'Письмо не проверено. Покажи то, что уже написал, и честно скажи человеку, что сверка не выполнена; ' +
            `checkLayout в этом ответе повторно не вызывай.${broken}`,
          state: result,
          success: true,
        };
      }

      const lines: string[] = [
        `Сверка с макетом «${result.file}» выполнена (кругов: ${result.rounds.length}).`,
        `Было: ${snapshot(result.before)}.`,
        `Стало: ${snapshot(result.after)}.${result.changed ? '' : ' Версия осталась прежней.'}`,
      ];
      if (result.rounds.length > 0) lines.push('Круги:', ...result.rounds.map(roundLine));
      if (result.stopped) lines.push(`Остановка: ${STOP_WORDS[result.stopped]}.`);
      if (result.problem) lines.push(`Не вышло до конца: ${result.problem}.`);
      if (result.remaining.length > 0) {
        lines.push(`Осталось расхождений: ${result.remaining.length} (показаны главные):`);
        lines.push(...result.remaining.map((item) => `- ${item}`));
      }
      if (result.observations) {
        lines.push(`Правщик заметил то, чего линейка не меряет: ${result.observations}`);
      }
      if (leftTechniques.length > 0) {
        lines.push(
          '',
          `ВАЖНО: в письме остались приёмы, которые выбросит почта (Gmail, Outlook): ${techniqueList(leftTechniques)}. Такое письмо в почте развалится, даже если на экране похоже на макет.`,
          `${REWRITE} Выдай его новым <lobeArtifact> с тем же identifier и вызови checkLayout ещё раз.`,
        );
        if (result.tag) {
          lines.push(
            'Если переписать никак нельзя — покажи этот тег и честно скажи человеку, что в почте письмо может развалиться:',
            result.tag,
          );
        }
      } else {
        if (beforeTechniques.length > 0) {
          lines.push(
            `Приёмы, которые выбросит почта, убраны (было: ${techniqueList(beforeTechniques)}).`,
          );
        }
        if (result.tag) lines.push('', SHOW_TAG, result.tag);
      }
      lines.push(
        '',
        'Человеку — одной-двумя строками: что исправлено и что ещё отличается. Не пиши «совпадает точно».',
      );
      return { content: lines.join('\n'), state: result, success: true };
    } catch (error) {
      return { content: `Сверка не выполнена: ${(error as Error).message}`, success: false };
    }
  }

  async editArtifact(args: EditArtifactParams): Promise<BuiltinServerRuntimeOutput> {
    if (!args?.identifier || !Array.isArray(args.edits) || args.edits.length === 0) {
      return {
        content: 'editArtifact: нужны identifier и непустой edits (find/replace).',
        success: false,
      };
    }
    try {
      const result = await this.deps.editArtifact(args);
      const lines = [
        `Правки применены: ${result.applied.length} из ${result.applied.length + result.rejected.length}. Версия сохранена в файле чата.`,
        ...result.applied.map((item) => `• №${item.index} «${item.find}»`),
      ];
      if (result.rejected.length > 0) {
        lines.push(
          'Не применены (исправь find и вызови editArtifact ещё раз, не пересобирай письмо):',
          ...result.rejected.map((item) => `• №${item.index} «${item.find}»: ${item.reason}`),
        );
      }
      lines.push('', SHOW_TAG, result.tag);
      return { content: lines.join('\n'), state: result, success: true };
    } catch (error) {
      return {
        content: `Не удалось применить правки: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async writeArtifact(args: WriteArtifactParams): Promise<BuiltinServerRuntimeOutput> {
    if (
      !args?.identifier ||
      typeof args.identifier !== 'string' ||
      !args?.title ||
      typeof args.title !== 'string' ||
      !args?.content ||
      typeof args.content !== 'string'
    ) {
      return {
        content: 'writeArtifact: нужны непустые identifier, title и content (HTML-документ).',
        success: false,
      };
    }
    try {
      const result = await this.deps.writeArtifact(args);
      const lines = [
        `HTML-артефакт «${result.title}» (${result.identifier}) проверен и сохранён в файл чата (sha256: ${result.sha256.slice(0, 12)}, проверено скриптов: ${result.checkedScripts}).`,
        `Проверено: ${result.verifiedParts.join(', ')}.`,
        `Не проверялось автоматически: ${result.unverifiedParts.join(', ')}.`,
        '',
        SHOW_TAG,
        result.tag,
      ];
      return { content: lines.join('\n'), state: result, success: true };
    } catch (error) {
      return {
        content: `HTML-артефакт не прошёл проверку и не сохранён: ${(error as Error).message}`,
        success: false,
      };
    }
  }

  async renderArtifact(args: RenderArtifactParams): Promise<BuiltinServerRuntimeOutput> {
    if (!args?.identifier || typeof args.identifier !== 'string' || !args.identifier.trim()) {
      return { content: 'renderArtifact: нужен identifier HTML-артефакта.', success: false };
    }
    try {
      const result = await this.deps.renderArtifact(args);

      if (result.status === 'limit_reached') {
        const limit = result.limit ?? 3;
        const shownAttempt = Math.min(result.attempt ?? limit, limit);
        return {
          content:
            `Лимит визуальных проверок renderArtifact в этом ответе исчерпан (${shownAttempt} из ${limit}). ` +
            `Больше не вызывай renderArtifact в этом ответе — покажи пользователю текущую версию HTML-артефакта «${result.title}» (${result.identifier}) и никогда не скрывай уже созданный артефакт.`,
          state: result,
          success: true,
        };
      }

      if (result.status === 'unavailable') {
        return {
          content:
            `Визуальный рендер артефакта «${result.title}» (${result.identifier}) сейчас недоступен: ${result.unavailableReason ?? 'причина неизвестна'}. ` +
            'HTML-артефакт сохранён и не изменялся — покажи пользователю уже созданный артефакт и честно сообщи, что визуальная проверка не выполнена; повторно renderArtifact в этом ответе не вызывай.',
          state: result,
          success: true,
        };
      }

      const overflow = result.horizontalOverflowPx ?? 0;
      const metaParts = [
        result.attempt && result.limit ? `проверка ${result.attempt} из ${result.limit}` : '',
        result.elapsedMs !== undefined ? `${result.elapsedMs} мс` : '',
      ].filter(Boolean);
      const metaSuffix = metaParts.length > 0 ? ` (${metaParts.join(', ')})` : '';
      const lines: string[] = [
        `Визуальный рендер «${result.title}» (${result.identifier}) выполнен${metaSuffix}.`,
        `Геометрия: окно ${result.width} px, высота документа ${result.height} px, ширина документа (scrollWidth) ${result.scrollWidth} px` +
          (overflow > 0
            ? ` — ГОРИЗОНТАЛЬНОЕ ПЕРЕПОЛНЕНИЕ +${overflow} px!`
            : ' — горизонтального переполнения нет.'),
      ];
      if (result.clampedFromWidth !== undefined) {
        lines.push(
          `Запрошенная ширина ${result.clampedFromWidth} px была ограничена допустимым диапазоном 320–1600 px.`,
        );
      }

      const imagesTotal = result.imagesTotal ?? result.images.length;
      const imagesLoaded = result.imagesLoaded ?? result.images.filter((img) => img.loaded).length;
      lines.push(`Картинки: загрузилось ${imagesLoaded} из ${imagesTotal}.`);

      const brokenImages = result.images.filter((img) => !img.loaded);
      if (brokenImages.length > 0) {
        lines.push(`Не загрузились <img> (${brokenImages.length}):`);
        for (const img of brokenImages.slice(0, 10)) {
          const reason = img.error ? `, причина: ${img.error}` : '';
          lines.push(
            `- src=${img.src ?? '(пусто)'} (x=${img.x}, y=${img.y}, ${img.w}×${img.h}${reason})`,
          );
        }
        if (brokenImages.length > 10) {
          lines.push(`… и ещё ${brokenImages.length - 10} незагрузившихся <img>`);
        }
      }

      if (result.failedImages.length > 0) {
        lines.push(`Не удалось подставить сетевые картинки (${result.failedImages.length}):`);
        for (const failed of result.failedImages.slice(0, 10)) {
          lines.push(`- ${failed.url} (${failed.origin}: ${failed.reason})`);
        }
        if (result.failedImages.length > 10) {
          lines.push(`… и ещё ${result.failedImages.length - 10} картинок`);
        }
      }

      const linesTotal = result.linesTotal ?? result.lines.length;
      const linesFound = result.linesFound ?? result.lines.filter((item) => item.found).length;
      if (linesTotal > 0) {
        lines.push(`Проверенные строки: найдено ${linesFound} из ${linesTotal}.`);
        const missing = result.lines.filter((item) => !item.found);
        if (missing.length > 0) {
          lines.push(
            `Не найдены (или скрыты display:none): ${missing
              .slice(0, 10)
              .map((item) => `«${item.text}»`)
              .join(', ')}.`,
          );
        }
        const foundItems = result.lines.filter((item) => item.found).slice(0, 20);
        for (const item of foundItems) {
          lines.push(
            `- «${item.text}»: x=${item.x}, y=${item.y}, h=${item.h}, font=${item.fontSize}px/${item.fontWeight}`,
          );
        }
        if (linesFound > foundItems.length) {
          lines.push(`… и ещё ${linesFound - foundItems.length} найденных строк`);
        }
      }

      const metrics = {
        failed_images_count: result.failedImages.length,
        height: result.height,
        horizontal_overflow_px: overflow,
        images_loaded: imagesLoaded,
        images_total: imagesTotal,
        ...(linesTotal > 0 ? { lines_found: linesFound, lines_total: linesTotal } : {}),
        ...(result.renderPath ? { render_path: result.renderPath } : {}),
        ...(result.renderer ? { renderer: result.renderer } : {}),
        scroll_width: result.scrollWidth,
        width: result.width,
      };
      lines.push(`Метрики JSON: ${JSON.stringify(metrics)}`);

      if (result.screenshotAttached && result.screenshot) {
        lines.push(
          `Снимок рендера (${result.screenshot.width}×${result.screenshot.height} px` +
            `${result.screenshot.scaled ? ', уменьшен со всей страницы' : ''}) приложен следующим сообщением для визуального осмотра. ` +
            'Это внутренний превью-снимок для проверки, а не замена HTML-артефакту.',
        );
      } else {
        lines.push(
          'Снимок экрана не приложен (модель без поддержки зрения или превью недоступно) — опирайся на точные замеры геометрии, переполнения, картинок и строк выше.',
        );
      }

      lines.push(
        `Если есть реальные дефекты (переполнение, битые картинки, наложение или пропавший текст) — исправь через editArtifact и при необходимости перепроверь не более 1–2 раз. ` +
          `Если всё в порядке — не делай лишних правок и покажи пользователю уже сохранённый HTML-артефакт «${result.title}» (${result.identifier}) (никогда не скрывай созданный артефакт).`,
      );

      // Для vision-моделей: блок `{type: 'image', data: <адрес>, fileId, mimeType}` подхватывает
      // ToolResultImagesProcessor (и дополнительно проверяет isCanUseVision). Сырой base64 в state не попадает никогда.
      const state = {
        ...result,
        ...(result.screenshotAttached && result.screenshot
          ? {
              content: [
                {
                  data: result.screenshot.address,
                  fileId: result.screenshot.fileId,
                  mimeType: 'image/jpeg',
                  type: 'image' as const,
                },
              ],
            }
          : {}),
      };

      return { content: lines.join('\n'), state, success: true };
    } catch (error) {
      return {
        content: `Визуальный рендер не выполнен: ${(error as Error).message}`,
        success: false,
      };
    }
  }
}
