import { describe, expect, it } from 'vitest';

import {
  ARCKEP_CRON_DEFAULT_TIMEZONE,
  CronScheduleError,
  normalizeCronPattern,
  normalizeTimezone,
  validateSchedule,
} from '../schedule';

// arckep (19.10.2026, задачи помощника по расписанию): общая проверка расписания для REST и инструмента lobe-cron.

describe('normalizeCronPattern — макросы', () => {
  it.each([
    ['@hourly', '0 * * * *'],
    ['@daily', '0 0 * * *'],
    ['@midnight', '0 0 * * *'],
    ['@weekly', '0 0 * * 0'],
    ['@monthly', '0 0 1 * *'],
    ['@yearly', '0 0 1 1 *'],
    ['@annually', '0 0 1 1 *'],
    ['  @Daily  ', '0 0 * * *'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCronPattern(input)).toBe(expected);
  });

  it.each(['@every 1h', '@every 5m', '@reboot', '@hourly2', '@'])('%s отклоняется', (input) => {
    expect(() => normalizeCronPattern(input)).toThrow(CronScheduleError);
  });
});

describe('normalizeCronPattern — число полей', () => {
  it('обрезает края и схлопывает пробелы', () => {
    expect(normalizeCronPattern('  0   9  *\t* 1-5 ')).toBe('0 9 * * 1-5');
  });

  it.each([
    '',
    '   ',
    '0 9 * *',
    '0 9 *',
    '0 0 9 * * *', // шесть полей — с секундами
    '0 0 9 * * * 2026', // семь полей
  ])('"%s" — не 5 полей', (input) => {
    expect(() => normalizeCronPattern(input)).toThrow(CronScheduleError);
  });

  it('в тексте ошибки называет число полей', () => {
    expect(() => normalizeCronPattern('0 0 9 * * *')).toThrow(/exactly 5 fields.*got 6/);
  });
});

describe('normalizeCronPattern — поля', () => {
  it.each([
    '0 9 * * *',
    '30 9 * * *',
    '0 */2 * * *',
    '30 */2 * * *',
    '0 9 * * 1-5',
    '0 9 * * 1,3,5',
    '0 9 * * 0',
    '0 9 * * 7',
    '0 9-18 * * 1-5',
    '0 9-18/3 * * *',
    '0 0 1,15 * *',
    '0 0 31 12 *',
    '0 23 * 1-12 *',
  ])('%s подходит', (input) => {
    expect(normalizeCronPattern(input)).toBe(input);
  });

  it.each([
    ['60 * * * *', /minute value 60/],
    ['0 24 * * *', /hour value 24/],
    ['0 0 0 * *', /day-of-month value 0/],
    ['0 0 32 * *', /day-of-month value 32/],
    ['0 0 * 0 *', /month value 0/],
    ['0 0 * 13 *', /month value 13/],
    ['0 0 * * 8', /day-of-week value 8/],
    ['0 18-9 * * *', /start is after the end/],
    ['0 */0 * * *', /positive number/],
    ['0 */x * * *', /positive number/],
    ['0 */25 * * *', /larger than the whole range/],
    ['0 */100 * * *', /positive number/],
    ['0 5/2 * * *', /a step needs/],
    ['0 9 * * MON', /day-of-week field/],
    ['0 9 * JAN *', /month field/],
    ['0 9 ? * *', /day-of-month field/],
    ['0 9 * * 1-2-3', /day-of-week field/],
    ['0 9 * * -1', /day-of-week field/],
    ['0 9, * * *', /hour field/],
    ['0 9 * * +1', /day-of-week field/],
  ])('%s — неверное поле', (input, message) => {
    expect(() => normalizeCronPattern(input)).toThrow(message);
  });
});

describe('normalizeCronPattern — не чаще раза в 30 минут', () => {
  it.each([
    '0 * * * *',
    '5 * * * *',
    '59 * * * *',
    '*/30 * * * *',
    '0,30 * * * *',
    '30,0 * * * *',
    '15,45 * * * *',
    '10,40 8-20 * * *',
    '0 */1 * * *',
    '0 */4 * * *',
  ])('%s подходит', (input) => {
    expect(normalizeCronPattern(input)).toBe(input);
  });

  it.each([
    '* * * * *',
    '*/5 * * * *',
    '*/15 * * * *',
    '*/29 * * * *',
    '*/31 * * * *',
    '*/60 * * * *',
    '0,10 * * * *',
    '0,15,30,45 * * * *',
    '0,29 * * * *',
    '0,31 * * * *',
    '0,0 * * * *',
    '0-59 * * * *',
    '0-30 * * * *',
    '5-5 * * * *',
    '0-59/30 * * * *',
    '0-30/15 * * * *',
    '0,30,45 * * * *',
  ])('%s — чаще или не по правилу, «Minimum interval is 30 minutes»', (input) => {
    expect(() => normalizeCronPattern(input)).toThrow(/Minimum interval is 30 minutes/);
  });

  it('макрос @hourly проходит правило', () => {
    expect(normalizeCronPattern('@hourly')).toBe('0 * * * *');
  });

  it('поле часов не спасает частые минуты', () => {
    expect(() => normalizeCronPattern('*/10 9-18 * * *')).toThrow(/Minimum interval/);
  });
});

describe('normalizeTimezone', () => {
  it('без значения — Europe/Moscow', () => {
    expect(ARCKEP_CRON_DEFAULT_TIMEZONE).toBe('Europe/Moscow');
    expect(normalizeTimezone()).toBe('Europe/Moscow');
    expect(normalizeTimezone(null)).toBe('Europe/Moscow');
    expect(normalizeTimezone('')).toBe('Europe/Moscow');
    expect(normalizeTimezone('   ')).toBe('Europe/Moscow');
  });

  it('существующие пояса принимаются', () => {
    expect(normalizeTimezone('Europe/Moscow')).toBe('Europe/Moscow');
    expect(normalizeTimezone(' Asia/Yekaterinburg ')).toBe('Asia/Yekaterinburg');
    expect(normalizeTimezone('America/Argentina/Buenos_Aires')).toBe(
      'America/Argentina/Buenos_Aires',
    );
    expect(normalizeTimezone('UTC')).toBe('UTC');
  });

  it('регистр приводится к каноническому', () => {
    expect(normalizeTimezone('europe/moscow')).toBe('Europe/Moscow');
  });

  it.each(['Mars/Phobos', 'Europe/Moskva', 'Moscow', '+03:00', 'Europe/Moscow; drop', '../etc/passwd'])(
    '%s — неизвестный пояс',
    (input) => {
      expect(() => normalizeTimezone(input)).toThrow(CronScheduleError);
      expect(() => normalizeTimezone(input)).toThrow(/Unknown timezone/);
    },
  );
});

describe('validateSchedule', () => {
  it('возвращает шаблон из 5 полей и пояс по умолчанию', () => {
    expect(validateSchedule({ cronPattern: '@daily' })).toEqual({
      cronPattern: '0 0 * * *',
      timezone: 'Europe/Moscow',
    });
  });

  it('пояс задачи сохраняется', () => {
    expect(validateSchedule({ cronPattern: '0 9 * * 1-5', timezone: 'Asia/Tokyo' })).toEqual({
      cronPattern: '0 9 * * 1-5',
      timezone: 'Asia/Tokyo',
    });
  });

  it('ошибка шаблона и ошибка пояса — CronScheduleError', () => {
    expect(() => validateSchedule({ cronPattern: '* * * * *' })).toThrow(CronScheduleError);
    expect(() => validateSchedule({ cronPattern: '0 9 * * *', timezone: 'Nowhere/City' })).toThrow(
      CronScheduleError,
    );
  });
});
