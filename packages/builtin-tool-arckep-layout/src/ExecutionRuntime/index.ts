import { type BuiltinServerRuntimeOutput } from '@lobechat/types';

import {
  type CheckLayoutParams,
  type CheckLayoutResult,
  type CheckRoundSummary,
  type CheckSnapshot,
  type EditArtifactParams,
  type EditArtifactResult,
  type TechniqueSummary,
} from '../types';

interface ArckepLayoutRuntimeDeps {
  checkLayout: (params: CheckLayoutParams) => Promise<CheckLayoutResult>;
  editArtifact: (params: EditArtifactParams) => Promise<EditArtifactResult>;
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
}
