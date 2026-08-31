export const SEO_AGENT_MARKET_ID = 'arckep-seo-marketing';

export interface CapabilityCube {
  description: string;
  id: string;
  prompt: string;
  title: string;
}

/**
 * Clickable jobs on empty chat / home. Copy is Russian — chat.arckep.ru is RU-first.
 * Prompts are sent (agent chat) or inserted into the composer (home).
 */
export const ARCKEP_CAPABILITY_CUBES: CapabilityCube[] = [
  {
    id: 'seo',
    title: 'SEO и спрос',
    description:
      'Wordstat: частоты, похожие запросы, темы статей. Директ — методика, без кабинета. Для вас бесплатно.',
    prompt:
      'Проверь спрос в Яндекс Wordstat и подскажи темы статей и логику рекламы в Директе. Если я ещё не назвал продукт, цель и гео — сначала спроси это одной короткой репликой, не сыпь общими советами.',
  },
  {
    id: 'image',
    title: 'Нарисовать картинку',
    description: 'Иллюстрация, обложка, товар — прямо в этом чате, цена в рублях.',
    prompt:
      'Нарисуй картинку в этом чате (через генерацию изображения, не переключай модель чата). Если не хватает деталей — задай 1–2 уточнения, иначе сразу сгенерируй и напиши стоимость в ₽.',
  },
  {
    id: 'site',
    title: 'Собрать сайт',
    description: 'Лендинг с предпросмотром и публикацией на своём адресе.',
    prompt:
      'Собери лендинг прямо здесь. Сначала уточни, для какого бизнеса, покажи стили и собери страницу с предпросмотром и кнопкой публикации.',
  },
  {
    id: 'dashboard',
    title: 'Дашборд из таблицы',
    description: 'Excel или открытая Google-таблица → отчёт с графиками.',
    prompt:
      'Собери дашборд из моих данных. Скажи, что загрузить: Excel, CSV или ссылку на открытую Google-таблицу.',
  },
  {
    id: 'search',
    title: 'Найти в интернете',
    description: 'Актуальные факты с источниками.',
    prompt:
      'Найди в интернете актуальную информацию и дай ответ с источниками. Если тему я ещё не назвал — спроси одной фразой, о чём искать.',
  },
  {
    id: 'crm',
    title: 'Своя CRM или база',
    description: 'Битрикс24, amoCRM, Postgres, MySQL, ClickHouse — нужны ваши доступы.',
    prompt:
      'Хочу подключить свою CRM или базу, чтобы ты отвечал по живым данным. Объясни простыми словами, что нужно дать и как включить (Битрикс24, amoCRM или SQL).',
  },
];

/** Awareness chips — not jobs. Jobs live in the cubes. */
export const ARCKEP_ALSO_CAN: string[] = [
  'Помнит прошлые разговоры',
  'Отвечает по вашим PDF',
  'Считает файлы в песочнице',
  'Бот в Telegram — в «Мои боты» на arckep.ru',
];

export const ARCKEP_EMPTY_INTRO =
  'Могу сделать это **прямо в чате**. Нажмите кубик или напишите задачу своими словами.';

export const cubesForAgent = (marketIdentifier?: string | null): CapabilityCube[] => {
  if (marketIdentifier === SEO_AGENT_MARKET_ID) {
    return ARCKEP_CAPABILITY_CUBES.filter((cube) => cube.id !== 'seo');
  }
  return ARCKEP_CAPABILITY_CUBES;
};
