import type { CheckLayoutResult, EditArtifactResult } from '@lobechat/builtin-tool-arckep-layout';
import { ArckepLayoutExecutionRuntime } from '@lobechat/builtin-tool-arckep-layout/executionRuntime';
import { describe, expect, it, vi } from 'vitest';

// arckep (19.10.2026): текст ответа модели после checkLayout и editArtifact — что сделано, что осталось и готовый
// тег для показа.

const TAG =
  '<lobeArtifact identifier="mail" type="text/html" title="Письмо" src="https://arckep.ru/chat/f/file_NEW/"></lobeArtifact>';

const checked = (extra: Partial<CheckLayoutResult> = {}): CheckLayoutResult => ({
  after: { issues: 3, linesFound: 111, linesTotal: 111, similarity: 94.2 },
  before: { issues: 14, linesFound: 111, linesTotal: 111, similarity: 89.3 },
  changed: true,
  file: 'new.pdf',
  fileId: 'file_NEW',
  identifier: 'mail',
  observations: 'У кнопки другой оттенок.',
  remaining: ['«Абзац» (макет y80 x20): по горизонтали +60'],
  rounds: [
    {
      applied: 5,
      rejected: 1,
      round: 1,
      similarityAfter: 94.2,
      similarityBefore: 89.3,
      status: 'accepted',
    },
    {
      applied: 2,
      note: 'появились новые расхождения',
      rejected: 0,
      round: 2,
      status: 'rolled_back',
    },
  ],
  src: 'https://arckep.ru/chat/f/file_NEW/',
  status: 'checked',
  stopped: 'rolled_back',
  tag: TAG,
  title: 'Письмо',
  ...extra,
});

const runtime = (checkLayout: () => Promise<CheckLayoutResult>, editArtifact = vi.fn()) =>
  new ArckepLayoutExecutionRuntime({ checkLayout, editArtifact });

describe('ответ модели после checkLayout', () => {
  it('итоги до и после, круги, остаток, тег и запрет печатать HTML', async () => {
    const result = await runtime(async () => checked()).checkLayout({ identifier: 'mail' });
    expect(result.success).toBe(true);
    expect(result.content).toContain('Сверка с макетом «new.pdf» выполнена (кругов: 2).');
    expect(result.content).toContain(
      'Было: похожесть 89,3 %, расхождений 14, строк найдено 111 из 111.',
    );
    expect(result.content).toContain(
      'Стало: похожесть 94,2 %, расхождений 3, строк найдено 111 из 111.',
    );
    expect(result.content).toContain(
      '1) принят, похожесть 89,3 % → 94,2 %, правок применено 5, не применено 1',
    );
    expect(result.content).toContain(
      '2) откат (стало хуже), правок применено 2, не применено 0 — появились новые расхождения',
    );
    expect(result.content).toContain(
      'Остановка: правки сделали хуже и откачены, новых кругов не было (эту же версию заново не сверяй — выйдет то же).',
    );
    expect(result.content).toContain('- «Абзац» (макет y80 x20): по горизонтали +60');
    expect(result.content).toContain(
      'Правщик заметил то, чего линейка не меряет: У кнопки другой оттенок.',
    );
    expect(result.content).toContain(
      'Покажи письмо ТОЛЬКО этим тегом (HTML заново не печатай ни целиком, ни частями):',
    );
    expect(result.content).toContain(TAG);
    expect(result.content).toMatch(/Не пиши «совпадает точно»/);
    expect(result.state).toMatchObject({ fileId: 'file_NEW', status: 'checked' });
  });

  it('версия не менялась — так и сказано', async () => {
    const result = await runtime(async () =>
      checked({ changed: false, rounds: [], stopped: 'clean' }),
    ).checkLayout({
      identifier: 'mail',
    });
    expect(result.content).toContain('Версия осталась прежней.');
    expect(result.content).toContain(
      'Остановка: письмо совпало с макетом по замерам и по картинке.',
    );
  });

  it('цикл оборвался: причина названа, лучшая версия всё равно показана тегом', async () => {
    const result = await runtime(async () =>
      checked({ problem: 'правщик не ответил: Недостаточно средств', stopped: 'editor_failed' }),
    ).checkLayout({ identifier: 'mail' });
    expect(result.content).toContain(
      'Не вышло до конца: правщик не ответил: Недостаточно средств.',
    );
    expect(result.content).toContain(TAG);
  });

  it('сверка недоступна: честный текст, без тега и без повторного вызова', async () => {
    const result = await runtime(async () => ({
      changed: false,
      file: 'new.pdf',
      identifier: 'mail',
      remaining: [],
      rounds: [],
      status: 'unavailable' as const,
      title: 'Письмо',
      unavailableReason: 'лимит отрисовок исчерпан (60 в час)',
    })).checkLayout({ identifier: 'mail' });
    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'Сверка с макетом сейчас недоступна: лимит отрисовок исчерпан (60 в час).',
    );
    expect(result.content).toContain('Письмо не проверено.');
    expect(result.content).toMatch(/checkLayout в этом ответе повторно не вызывай/);
    expect(result.content).not.toContain('<lobeArtifact');
  });

  it('ожидаемая неудача (нет макета, нет артефакта) — success: false с текстом причины', async () => {
    const result = await runtime(async () => {
      throw new Error('в теме нет PDF-макета: сверять не с чем.');
    }).checkLayout({ identifier: 'mail' });
    expect(result).toEqual({
      content: 'Сверка не выполнена: в теме нет PDF-макета: сверять не с чем.',
      success: false,
    });
  });
});

describe('ответ модели после editArtifact', () => {
  const edited = (extra: Partial<EditArtifactResult> = {}): EditArtifactResult => ({
    applied: [{ find: '<a class="btn">', index: 1 }],
    fileId: 'file_NEW',
    identifier: 'mail',
    rejected: [{ find: 'нет такого', index: 2, reason: 'не найдено в тексте' }],
    src: 'https://arckep.ru/chat/f/file_NEW/',
    tag: TAG,
    title: 'Письмо',
    ...extra,
  });

  it('применено N из M, причины отказов и тег', async () => {
    const editArtifact = vi.fn(async () => edited());
    const result = await runtime(async () => checked(), editArtifact).editArtifact({
      edits: [
        { find: '<a class="btn">', replace: '<a class="btn blue">' },
        { find: 'нет такого', replace: 'x' },
      ],
      identifier: 'mail',
    });
    expect(editArtifact).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.content).toContain('Правки применены: 1 из 2. Версия сохранена в файле чата.');
    expect(result.content).toContain('• №1 «<a class="btn">»');
    expect(result.content).toContain('• №2 «нет такого»: не найдено в тексте');
    expect(result.content).toMatch(/не пересобирай письмо/);
    expect(result.content).toContain(TAG);
  });

  it('все правки применены — без блока отказов', async () => {
    const result = await runtime(
      async () => checked(),
      vi.fn(async () => edited({ rejected: [] })),
    ).editArtifact({
      edits: [{ find: 'a', replace: 'b' }],
      identifier: 'mail',
    });
    expect(result.content).toContain('Правки применены: 1 из 1.');
    expect(result.content).not.toContain('Не применены');
  });

  it('ни одна не применилась — success: false и причины (версия не менялась)', async () => {
    const result = await runtime(
      async () => checked(),
      vi.fn(async () => {
        throw new Error('ни одна правка не применилась, версия не менялась');
      }),
    ).editArtifact({ edits: [{ find: 'a', replace: 'b' }], identifier: 'mail' });
    expect(result.success).toBe(false);
    expect(result.content).toBe(
      'Не удалось применить правки: ни одна правка не применилась, версия не менялась',
    );
  });
});

describe('ответ модели: приёмы, которые выбросит почта', () => {
  const position = {
    count: 77,
    example: 'position: absolute; left: 20px',
    kind: 'position' as const,
    label: 'position:absolute/fixed',
  };

  it('остались: ВАЖНО, перечень, как переписать, «вызови checkLayout ещё раз»; тег — только запасной', async () => {
    const result = await runtime(async () =>
      checked({ techniques: { before: [position], left: [position] } }),
    ).checkLayout({ identifier: 'mail' });

    expect(result.success).toBe(true);
    expect(result.content).toContain(
      'ВАЖНО: в письме остались приёмы, которые выбросит почта (Gmail, Outlook): position:absolute/fixed ×77 (пример: position: absolute; left: 20px).',
    );
    expect(result.content).toContain(
      'Такое письмо в почте развалится, даже если на экране похоже на макет.',
    );
    expect(result.content).toContain(
      'Перепиши письмо обычным потоком: вложенные таблицы, стили в style, без position:absolute/fixed, flex, grid, float, <script> и <link rel=stylesheet>',
    );
    expect(result.content).toContain(
      'новым <lobeArtifact> с тем же identifier и вызови checkLayout ещё раз',
    );
    // обычного «покажи ТОЛЬКО этим тегом» нет: письмо в таком виде показывать нельзя
    expect(result.content).not.toContain('Покажи письмо ТОЛЬКО этим тегом');
    expect(result.content).toContain('Если переписать никак нельзя — покажи этот тег');
    expect(result.content).toContain(TAG);
  });

  it('убраны правщиком: сказано, что было, и тег показывается как обычно', async () => {
    const result = await runtime(async () =>
      checked({ techniques: { before: [position], left: [] } }),
    ).checkLayout({ identifier: 'mail' });
    expect(result.content).toContain(
      'Приёмы, которые выбросит почта, убраны (было: position:absolute/fixed ×77 (пример: position: absolute; left: 20px)).',
    );
    expect(result.content).toContain('Покажи письмо ТОЛЬКО этим тегом');
    expect(result.content).not.toContain('ВАЖНО');
  });

  it('приёмов не было — ни слова про них', async () => {
    const result = await runtime(async () =>
      checked({ techniques: { before: [], left: [] } }),
    ).checkLayout({
      identifier: 'mail',
    });
    expect(result.content).not.toContain('выбросит почта');
    expect(result.content).toContain('Покажи письмо ТОЛЬКО этим тегом');
  });

  it('сверка недоступна, но приёмы видны по тексту: переписать письмо, checkLayout в этом ответе не звать', async () => {
    const result = await runtime(async () => ({
      changed: false,
      file: 'new.pdf',
      identifier: 'mail',
      remaining: [],
      rounds: [],
      status: 'unavailable' as const,
      techniques: { before: [position], left: [position] },
      title: 'Письмо',
      unavailableReason: 'лимит отрисовок исчерпан (60 в час)',
    })).checkLayout({ identifier: 'mail' });
    expect(result.content).toContain('Сверка с макетом сейчас недоступна');
    expect(result.content).toContain(
      'Но и без отрисовки видно: в письме приёмы, которые выбросит почта (Gmail, Outlook): position:absolute/fixed ×77',
    );
    expect(result.content).toContain('Перепиши письмо обычным потоком');
    expect(result.content).toMatch(/checkLayout в этом ответе повторно не вызывай/);
  });
});
