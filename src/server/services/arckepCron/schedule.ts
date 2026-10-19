/**
 * arckep (19.10.2026, задачи помощника по расписанию): проверка расписания задачи.
 *
 * Одна проверка на все входы — REST `/api/v1/arckep/cron-jobs` и инструмент `lobe-cron` в чате
 * (`ServerCronService`). Сама по себе таблица `agent_cron_jobs` любой текст принимает, а запускающий цикл
 * живёт в студии и разбирает расписание по тем же правилам, поэтому здесь жёстко:
 *
 * - только 5 полей (минуты, часы, дни, месяцы, дни недели); секунды, `@every`, `@reboot` — отказ;
 * - макросы `@hourly/@daily/@midnight/@weekly/@monthly/@yearly/@annually` переводятся в 5 полей;
 * - чаще раза в 30 минут нельзя: решает поле минут (одно число, два числа ровно через 30 или шаг 30 от звёздочки);
 * - часовой пояс по умолчанию `Europe/Moscow`, существование пояса проверяется.
 *
 * Тексты ошибок английские: инструмент отдаёт их модели как есть.
 */

export const ARCKEP_CRON_DEFAULT_TIMEZONE = 'Europe/Moscow';
export const ARCKEP_CRON_MIN_INTERVAL_MINUTES = 30;

const MACROS: Record<string, string> = {
  '@annually': '0 0 1 1 *',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
  '@midnight': '0 0 * * *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@yearly': '0 0 1 1 *',
};

/** Поля шаблона: название для текста ошибки и допустимые пределы. */
const FIELDS = [
  { max: 59, min: 0, name: 'minute' },
  { max: 23, min: 0, name: 'hour' },
  { max: 31, min: 1, name: 'day-of-month' },
  { max: 12, min: 1, name: 'month' },
  { max: 7, min: 0, name: 'day-of-week' },
] as const;

const MIN_INTERVAL_MESSAGE =
  `Minimum interval is ${ARCKEP_CRON_MIN_INTERVAL_MINUTES} minutes: the minute field must be a single ` +
  'minute (e.g. "0"), two minutes exactly 30 apart (e.g. "0,30" or "15,45") or "*/30"';

/** Ошибка проверки расписания: текст можно показывать человеку и модели как есть. */
export class CronScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronScheduleError';
  }
}

const NUMBER_RE = /^\d{1,2}$/;

const parseNumber = (raw: string, field: (typeof FIELDS)[number], pattern: string): number => {
  if (!NUMBER_RE.test(raw)) {
    throw new CronScheduleError(
      `Invalid ${field.name} field "${pattern}": only numbers, lists (1,2), ranges (1-5) and steps (*/2) are supported`,
    );
  }
  const value = Number(raw);
  if (value < field.min || value > field.max) {
    throw new CronScheduleError(
      `Invalid ${field.name} value ${value}: allowed range is ${field.min}-${field.max}`,
    );
  }
  return value;
};

/** Один элемент списка поля: звёздочка, звёздочка с шагом, число, диапазон, диапазон с шагом. */
type Item =
  | { kind: 'any' }
  | { kind: 'number'; value: number }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'step'; step: number; from?: number; to?: number };

const parseItem = (rawItem: string, field: (typeof FIELDS)[number], fieldText: string): Item => {
  if (rawItem === '*') return { kind: 'any' };

  const [base, stepRaw, ...rest] = rawItem.split('/');
  if (rest.length > 0 || base === undefined || base === '') {
    throw new CronScheduleError(
      `Invalid ${field.name} field "${fieldText}": only numbers, lists (1,2), ranges (1-5) and steps (*/2) are supported`,
    );
  }

  let step: number | undefined;
  if (stepRaw !== undefined) {
    if (!/^\d{1,2}$/.test(stepRaw) || Number(stepRaw) < 1) {
      throw new CronScheduleError(
        `Invalid step "${stepRaw}" in ${field.name} field: the step must be a positive number`,
      );
    }
    step = Number(stepRaw);
    if (step > field.max - field.min + 1) {
      throw new CronScheduleError(
        `Invalid step ${step} in ${field.name} field: it is larger than the whole range ${field.min}-${field.max}`,
      );
    }
  }

  if (base === '*') {
    return { kind: 'step', step: step! };
  }

  const bounds = base.split('-');
  if (bounds.length === 1) {
    if (step !== undefined) {
      throw new CronScheduleError(
        `Invalid ${field.name} field "${fieldText}": a step needs "*" or a range ("*/2" or "1-10/2")`,
      );
    }
    return { kind: 'number', value: parseNumber(bounds[0], field, fieldText) };
  }
  if (bounds.length !== 2) {
    throw new CronScheduleError(
      `Invalid ${field.name} field "${fieldText}": only numbers, lists (1,2), ranges (1-5) and steps (*/2) are supported`,
    );
  }

  const from = parseNumber(bounds[0], field, fieldText);
  const to = parseNumber(bounds[1], field, fieldText);
  if (from > to) {
    throw new CronScheduleError(`Invalid ${field.name} range ${from}-${to}: the start is after the end`);
  }
  return step === undefined ? { from, kind: 'range', to } : { from, kind: 'step', step, to };
};

const parseField = (text: string, index: number): Item[] => {
  const field = FIELDS[index];
  if (!text) {
    throw new CronScheduleError(`Empty ${field.name} field`);
  }
  return text.split(',').map((item) => parseItem(item, field, text));
};

/**
 * Поле минут → допустимо ли по правилу «не чаще раза в 30 минут». Ошибка про интервал — одна и та же для
 * звёздочки, шага 5, «0,10» или «0-59»: человеку/модели нужно сказать, что делать, а не какой именно разбор сработал.
 */
const assertMinuteFieldAllowed = (minuteField: string, items: Item[]) => {
  if (items.length === 1) {
    const [item] = items;
    if (item.kind === 'number') return;
    if (item.kind === 'step' && item.from === undefined && item.step === 30) return;
  }
  if (items.length === 2 && items.every((item) => item.kind === 'number')) {
    const [a, b] = items as Array<{ kind: 'number'; value: number }>;
    if (Math.abs(a.value - b.value) === 30) return;
  }
  throw new CronScheduleError(`${MIN_INTERVAL_MESSAGE} (got "${minuteField}")`);
};

/**
 * Привести шаблон к виду из 5 полей через пробел и проверить его. Макросы разворачиваются, лишние пробелы
 * схлопываются. Бросает `CronScheduleError`.
 */
export const normalizeCronPattern = (raw: string): string => {
  if (typeof raw !== 'string') {
    throw new CronScheduleError('Cron pattern must be a string');
  }
  let pattern = raw.trim();
  if (!pattern) throw new CronScheduleError('Cron pattern is empty');

  if (pattern.startsWith('@')) {
    const macro = MACROS[pattern.toLowerCase()];
    if (!macro) {
      throw new CronScheduleError(
        `Unsupported cron macro "${pattern}": use a 5-field pattern like "0 9 * * *" ` +
          `(minute hour day month weekday), or one of @hourly, @daily, @weekly, @monthly, @yearly`,
      );
    }
    pattern = macro;
  }

  const fields = pattern.split(/\s+/);
  if (fields.length !== 5) {
    throw new CronScheduleError(
      `Cron pattern must have exactly 5 fields (minute hour day month weekday), got ${fields.length}: "${pattern}". ` +
        'Seconds and years are not supported',
    );
  }

  const parsed = fields.map((text, index) => parseField(text, index));
  assertMinuteFieldAllowed(fields[0], parsed[0]);

  return fields.join(' ');
};

/** Часовой пояс: пусто → `Europe/Moscow`; несуществующий пояс — ошибка. */
export const normalizeTimezone = (raw?: string | null): string => {
  const timezone = (raw ?? '').trim();
  if (!timezone) return ARCKEP_CRON_DEFAULT_TIMEZONE;

  // Только имена базы IANA (Europe/Moscow, UTC): смещения вида "+03:00" Intl принимает, а студия — нет.
  if (!/^[A-Z][\w+-]*(?:\/[\w+-]+){0,2}$/i.test(timezone)) {
    throw new CronScheduleError(
      `Unknown timezone "${timezone}": use an IANA name like "Europe/Moscow" or "UTC"`,
    );
  }
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions()
      .timeZone;
    // «europe/moscow» → «Europe/Moscow»: студия читает пояс с учётом регистра.
    return resolved.toLowerCase() === timezone.toLowerCase() ? resolved : timezone;
  } catch {
    throw new CronScheduleError(
      `Unknown timezone "${timezone}": use an IANA name like "Europe/Moscow" or "UTC"`,
    );
  }
};

export interface ValidatedSchedule {
  cronPattern: string;
  timezone: string;
}

/** Расписание целиком: шаблон из 5 полей и пояс (по умолчанию Europe/Moscow). */
export const validateSchedule = (input: {
  cronPattern: string;
  timezone?: string | null;
}): ValidatedSchedule => ({
  cronPattern: normalizeCronPattern(input.cronPattern),
  timezone: normalizeTimezone(input.timezone),
});
