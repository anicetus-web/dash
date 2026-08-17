// Периоды дашборда и часовой пояс портала.
//
// Единственное место в системе, где считаются календарные границы (инвариант 11).
// Правило: начало и конец суток, недели, месяца, квартала и года определяются настенными
// часами портала, а не UTC. Для Москвы сутки начинаются в 21:00 UTC предыдущего дня;
// если считать границы в UTC, вечерние события уезжают в соседние сутки, и число на ступени
// расходится с тем, что заказчик видит в карточке Битрикса.
//
// Часовой пояс — параметр, а не константа модуля. Портал может стоять в любой зоне,
// а проверки обязаны считать несколько зон в одном процессе.
//
// Сдвиг зоны нигде не «прошит числом часов»: он берётся у Intl на каждый конкретный момент.
// Поэтому зоны с переводом стрелок считаются верно — в такие сутки 23 или 25 часов,
// и фиксированный сдвиг дал бы неправильную границу дня дважды в год.
import { dateOrNull } from '../lib/records.js';

const MS_IN_DAY = 24 * 60 * 60 * 1000;
const QUARTER_MONTHS = 3;

// Поддерживаемые типы периода. 'custom' — произвольный диапазон дат,
// 'allHistory' — «Вся история выбранных баз» (доступна только Статике, это решает расчётный модуль).
export const PERIOD_TYPES = Object.freeze(['day', 'week', 'month', 'quarter', 'year', 'custom', 'allHistory']);

// Дефолт по спеке: текущий календарный квартал.
export const DEFAULT_PERIOD_TYPE = 'quarter';

// Зона, на которую откатываемся, если переданная неизвестна. UTC выбран сознательно:
// он всегда доступен в Intl и не притворяется зоной заказчика.
const FALLBACK_TIME_ZONE = 'UTC';

const MONTHS_RU = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
];
const QUARTERS_RU = ['I', 'II', 'III', 'IV'];

// Написания типа периода, которые могут прийти из строки запроса. Ключ — только латинские
// буквы в нижнем регистре, поэтому 'all-history', 'allHistory' и 'ALL_HISTORY' — одно и то же.
const TYPE_ALIASES = new Map([
  ['day', 'day'],
  ['week', 'week'],
  ['month', 'month'],
  ['quarter', 'quarter'],
  ['year', 'year'],
  ['custom', 'custom'],
  ['range', 'custom'],
  ['allhistory', 'allHistory'],
  ['all', 'allHistory']
]);

// ── Работа с зоной ───────────────────────────────────────────────────────────

// Intl.DateTimeFormat дорог в создании, а границы считаются на каждый запрос — кэшируем.
const formatterCache = new Map();

function formatterFor(timeZone) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

// Известна ли зона этой сборке Node. Проверяем через сам Intl: список зон меняется от версии
// к версии, и держать свой перечень означало бы отвергать валидные зоны.
function isKnownTimeZone(timeZone) {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function safeZone(timeZone) {
  const value = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (value === '' || !isKnownTimeZone(value)) return FALLBACK_TIME_ZONE;
  return value;
}

function normalizeTimeZone(timeZone, notes) {
  const value = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (value === '') {
    notes.push(`Часовой пояс портала не передан — границы посчитаны в ${FALLBACK_TIME_ZONE}.`);
    return FALLBACK_TIME_ZONE;
  }
  if (!isKnownTimeZone(value)) {
    notes.push(`Неизвестный часовой пояс «${value}» — границы посчитаны в ${FALLBACK_TIME_ZONE}.`);
    return FALLBACK_TIME_ZONE;
  }
  return value;
}

// Date.UTC ломается на годах 0–99 (мапит их в 1900+): нормализуем явно.
// Месяц здесь человеческий, 1–12, и переполнение допустимо: utcMs(2026, 13, 0) — это 31 декабря 2026.
function utcMs(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const value = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (year >= 0 && year < 100) {
    const shifted = new Date(value);
    shifted.setUTCFullYear(year);
    return shifted.getTime();
  }
  return value;
}

// Разложение момента по настенным часам зоны.
function partsInZone(instantMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const found = {};
  for (const part of parts) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  return {
    year: Number(found.year),
    month: Number(found.month),
    day: Number(found.day),
    // Некоторые сборки отдают 24 вместо 0 для полуночи — приводим к 0..23.
    hour: Number(found.hour) % 24,
    minute: Number(found.minute),
    second: Number(found.second)
  };
}

// Сдвиг зоны в миллисекундах на конкретный момент: настенное время минус сам момент.
// Миллисекунды момента в расчёте не участвуют (Intl их не отдаёт), но они одинаковы
// по обе стороны вычитания, поэтому результат точен даже для зон со сдвигом в секундах.
function offsetAt(instantMs, timeZone) {
  const parts = partsInZone(instantMs, timeZone);
  const wall = utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
  return wall - Math.floor(instantMs / 1000) * 1000;
}

// Обратный переход: настенное время зоны → момент времени.
//
// Сдвиг зависит от момента, а момент — от сдвига, поэтому решаем перебором двух кандидатов:
// берём сдвиг за сутки до и через сутки после (любой перевод стрелок внутри суток попадёт между).
// Настенное время может существовать дважды (осенний перевод) — берём первое вхождение,
// или не существовать вовсе (весенний перевод) — берём первый существующий момент после провала.
function instantFromWall(wallMs, timeZone) {
  const offsetBefore = offsetAt(wallMs - MS_IN_DAY, timeZone);
  const offsetAfter = offsetAt(wallMs + MS_IN_DAY, timeZone);
  const offsets = offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter];
  const candidates = [];
  for (const offset of offsets) {
    const candidate = wallMs - offset;
    if (offsetAt(candidate, timeZone) === offset) candidates.push(candidate);
  }
  if (candidates.length > 0) return Math.min(...candidates);
  return Math.max(wallMs - offsetBefore, wallMs - offsetAfter);
}

// ── Календарные сутки без зоны ───────────────────────────────────────────────
// «День» здесь — тройка чисел {year, month, day}, а не момент времени. Арифметика над ней
// не зависит от зоны, поэтому переводы стрелок ей не мешают: зона подключается только
// в момент превращения дня в границу (startOfDayInZone).

function plainDay(year, month, day) {
  const date = new Date(utcMs(year, month, day));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(day, amount) {
  return plainDay(day.year, day.month, day.day + amount);
}

function dayMs(day) {
  return utcMs(day.year, day.month, day.day);
}

function compareDays(left, right) {
  return dayMs(left) - dayMs(right);
}

function dayInZone(instantMs, timeZone) {
  const parts = partsInZone(instantMs, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function startOfDayInZone(day, timeZone) {
  return instantFromWall(utcMs(day.year, day.month, day.day), timeZone);
}

// Конец суток — это миллисекунда до начала следующих. Так соседние периоды стыкуются
// без зазора и без нахлёста даже в сутки с переводом стрелок, где 23:59:59.999
// может существовать дважды или не существовать вовсе.
function endOfDayInZone(day, timeZone) {
  return startOfDayInZone(addDays(day, 1), timeZone) - 1;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function dayString(day) {
  return `${day.year}-${pad2(day.month)}-${pad2(day.day)}`;
}

function dayLabel(day) {
  return `${pad2(day.day)}.${pad2(day.month)}.${day.year}`;
}

// ── Номер недели по ISO ──────────────────────────────────────────────────────
// Неделя начинается с понедельника, первая неделя года — та, в которой 4 января.
// Из-за этого 1 января может относиться к последней неделе прошлого года: 2027-01-01
// лежит в неделе 2026-W53. Это не ошибка, а определение ISO.

function isoWeekOf(day) {
  const ms = dayMs(day);
  const weekday = new Date(ms).getUTCDay() || 7;
  const thursdayMs = ms + (4 - weekday) * MS_IN_DAY;
  const thursday = new Date(thursdayMs);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursdayMs - utcMs(year, 1, 1)) / (7 * MS_IN_DAY)) + 1;
  return { year, week };
}

function isoWeekStartDay(year, week) {
  const jan4 = utcMs(year, 1, 4);
  const weekday = new Date(jan4).getUTCDay() || 7;
  const firstMonday = jan4 - (weekday - 1) * MS_IN_DAY;
  const monday = new Date(firstMonday + (week - 1) * 7 * MS_IN_DAY);
  return { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
}

// ── Разбор входных значений ──────────────────────────────────────────────────

function asText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeType(value, notes) {
  const raw = asText(value);
  if (raw === '') return DEFAULT_PERIOD_TYPE;
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  const type = TYPE_ALIASES.get(key);
  if (type) return type;
  notes.push(`Неизвестный тип периода «${raw}» — показан текущий квартал.`);
  return DEFAULT_PERIOD_TYPE;
}

// Момент «сейчас». Битое значение не роняет расчёт: считаем от реального текущего момента
// и говорим об этом вслух. Проверки всегда передают now явно — иначе они недетерминированы.
function normalizeNow(value, notes) {
  if (value === undefined || value === null) return new Date();
  const date = dateOrNull(value);
  if (date) return date;
  notes.push('Параметр «сейчас» не похож на дату — расчёт идёт от текущего момента.');
  return new Date();
}

function parseDay(value, notes) {
  const raw = asText(value);
  if (raw === '') return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  const year = match ? Number(match[1]) : 0;
  const month = match ? Number(match[2]) : 0;
  const day = match ? Number(match[3]) : 0;
  const normalized = match ? plainDay(year, month, day) : null;
  // Несуществующая дата вроде '2026-02-31' меняет месяц при нормализации — это битый ввод.
  if (!normalized || normalized.month !== month || normalized.day !== day) {
    notes.push(`Значение дня «${raw}» не разобрано — показан сегодняшний день.`);
    return null;
  }
  return normalized;
}

function parseWeek(value, notes) {
  const raw = asText(value);
  if (raw === '') return null;
  const match = /^(\d{4})-?W(\d{1,2})$/i.exec(raw);
  const week = match ? Number(match[2]) : 0;
  if (!match || week < 1 || week > 53) {
    notes.push(`Значение недели «${raw}» не разобрано — показана текущая неделя.`);
    return null;
  }
  return { year: Number(match[1]), week };
}

function parseMonth(value, notes) {
  const raw = asText(value);
  if (raw === '') return null;
  const match = /^(\d{4})-(\d{1,2})$/.exec(raw);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    notes.push(`Значение месяца «${raw}» не разобрано — показан текущий месяц.`);
    return null;
  }
  return { year: Number(match[1]), month };
}

function parseQuarter(value, notes) {
  const raw = asText(value);
  if (raw === '') return null;
  const match = /^(\d{4})-?Q([1-4])$/i.exec(raw);
  if (!match) {
    notes.push(`Значение квартала «${raw}» не разобрано — показан текущий квартал.`);
    return null;
  }
  return { year: Number(match[1]), quarter: Number(match[2]) };
}

function parseYear(value, notes) {
  const raw = asText(value);
  if (raw === '') return null;
  if (!/^\d{4}$/.test(raw)) {
    notes.push(`Значение года «${raw}» не разобрано — показан текущий год.`);
    return null;
  }
  return Number(raw);
}

// Границу произвольного диапазона принимаем и как календарный день '2026-08-15',
// и как момент времени. Календарный день НЕ разбираем через Date: '2026-08-15' по стандарту
// читается как полночь UTC, и в зоне с отрицательным сдвигом это был бы предыдущий день —
// пользователь выбрал день по календарю портала, а не момент времени.
function dayFromInput(value, timeZone) {
  if (typeof value === 'string') {
    const plain = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
    if (plain) {
      const year = Number(plain[1]);
      const month = Number(plain[2]);
      const day = Number(plain[3]);
      const normalized = plainDay(year, month, day);
      // Несуществующая дата вроде '2026-02-31' после нормализации меняет месяц — это не опечатка,
      // которую можно исправить за пользователя, а битый ввод.
      if (normalized.month !== month || normalized.day !== day) return null;
      return normalized;
    }
  }
  const date = dateOrNull(value);
  return date ? dayInZone(date.getTime(), timeZone) : null;
}

// ── Сборка периода ───────────────────────────────────────────────────────────

function standardDays(type, value, nowDay, notes) {
  if (type === 'day') {
    const parsed = parseDay(value, notes) || nowDay;
    return { startDay: parsed, endDay: parsed };
  }
  if (type === 'week') {
    const parsed = parseWeek(value, notes) || isoWeekOf(nowDay);
    const startDay = isoWeekStartDay(parsed.year, parsed.week);
    return { startDay, endDay: addDays(startDay, 6) };
  }
  if (type === 'month') {
    const parsed = parseMonth(value, notes);
    const year = parsed ? parsed.year : nowDay.year;
    const month = parsed ? parsed.month : nowDay.month;
    // Последний день месяца — «нулевой день» следующего. Високосный февраль получается сам собой.
    return { startDay: plainDay(year, month, 1), endDay: plainDay(year, month + 1, 0) };
  }
  if (type === 'year') {
    const parsed = parseYear(value, notes);
    const year = parsed === null ? nowDay.year : parsed;
    return { startDay: plainDay(year, 1, 1), endDay: plainDay(year, 12, 31) };
  }
  const parsed = parseQuarter(value, notes);
  const year = parsed ? parsed.year : nowDay.year;
  const quarter = parsed ? parsed.quarter : Math.floor((nowDay.month - 1) / QUARTER_MONTHS) + 1;
  const startMonth = (quarter - 1) * QUARTER_MONTHS + 1;
  return { startDay: plainDay(year, startMonth, 1), endDay: plainDay(year, startMonth + QUARTER_MONTHS, 0) };
}

// Ключ и подпись считаем от фактически полученных границ, а не от того, что прислал клиент:
// период обязан описывать сам себя, даже если значение пришло битым и мы откатились к дефолту.
function keyFor(type, startDay, endDay) {
  if (type === 'day') return dayString(startDay);
  if (type === 'week') {
    const week = isoWeekOf(startDay);
    return `${week.year}-W${pad2(week.week)}`;
  }
  if (type === 'month') return `${startDay.year}-${pad2(startDay.month)}`;
  if (type === 'year') return String(startDay.year);
  if (type === 'custom') return `${dayString(startDay)}..${dayString(endDay)}`;
  return `${startDay.year}-Q${Math.floor((startDay.month - 1) / QUARTER_MONTHS) + 1}`;
}

function labelFor(type, startDay, endDay) {
  if (type === 'day') return dayLabel(startDay);
  if (type === 'week') {
    const week = isoWeekOf(startDay);
    return `Неделя ${week.week} (${dayLabel(startDay)} — ${dayLabel(endDay)})`;
  }
  if (type === 'month') return `${MONTHS_RU[startDay.month - 1]} ${startDay.year}`;
  if (type === 'year') return `${startDay.year} год`;
  if (type === 'custom') {
    if (compareDays(startDay, endDay) === 0) return dayLabel(startDay);
    return `${dayLabel(startDay)} — ${dayLabel(endDay)}`;
  }
  return `${QUARTERS_RU[Math.floor((startDay.month - 1) / QUARTER_MONTHS)]} квартал ${startDay.year}`;
}

// Обрезка будущего (инвариант 10) живёт ровно здесь. Естественные границы сохраняются
// отдельными полями: подпись показывает период целиком, расчёт — обрезанный кусок,
// иначе текущий квартал выглядел бы в интерфейсе укороченным.
function freezePeriod({ type, key, label, timeZone, naturalFrom, naturalTo, now, notes }) {
  const to = naturalTo.getTime() > now.getTime() ? new Date(now.getTime()) : naturalTo;
  return Object.freeze({
    type,
    key,
    label,
    timeZone,
    from: naturalFrom,
    to,
    naturalFrom,
    naturalTo,
    clamped: to.getTime() < naturalTo.getTime(),
    // Период целиком в будущем: считать нечего, но это не ошибка и не пустой фильтр.
    empty: naturalFrom !== null && to.getTime() < naturalFrom.getTime(),
    fromDay: naturalFrom ? dayString(dayInZone(naturalFrom.getTime(), timeZone)) : null,
    toDay: dayString(dayInZone(to.getTime(), timeZone)),
    naturalToDay: dayString(dayInZone(naturalTo.getTime(), timeZone)),
    notes: Object.freeze(notes)
  });
}

/**
 * Границы периода в часовом поясе портала.
 *
 * @param {object} request       {type|periodType, value|periodValue, from, to}
 * @param {object} options       {now, timeZone}
 * @returns замороженный период: from/to (расчётные, будущее обрезано),
 *          naturalFrom/naturalTo (естественные, для подписей), key, label, notes.
 *
 * Ничто внутри не бросает исключений: битый тип, битое значение и неизвестная зона
 * дают рабочий период и замечание в notes. Дашборд, упавший из-за строки в адресе, бесполезен.
 */
export function resolvePeriod(request = {}, options = {}) {
  const source = request && typeof request === 'object' ? request : {};
  const notes = [];
  const timeZone = normalizeTimeZone(options.timeZone, notes);
  const now = normalizeNow(options.now, notes);
  const requestedType = normalizeType(source.type ?? source.periodType, notes);
  const value = source.value ?? source.periodValue;
  const nowDay = dayInZone(now.getTime(), timeZone);

  // «Вся история»: нижней границы нет, верхняя — текущий момент.
  if (requestedType === 'allHistory') {
    return freezePeriod({
      type: 'allHistory',
      key: 'all',
      label: 'Вся история',
      timeZone,
      naturalFrom: null,
      naturalTo: new Date(now.getTime()),
      now,
      notes
    });
  }

  let type = requestedType;
  let days = null;

  if (type === 'custom') {
    const startDay = dayFromInput(source.from, timeZone);
    const endDay = dayFromInput(source.to, timeZone);
    if (!startDay || !endDay) {
      notes.push('Границы произвольного диапазона не разобраны — показан текущий квартал.');
      type = DEFAULT_PERIOD_TYPE;
    } else if (compareDays(startDay, endDay) > 0) {
      // Перевёрнутый диапазон — обычная описка в адресной строке. Меняем границы местами
      // и говорим об этом: отказ считать оставил бы пользователя с пустым экраном.
      notes.push('Конец диапазона раньше начала — границы переставлены местами.');
      days = { startDay: endDay, endDay: startDay };
    } else {
      days = { startDay, endDay };
    }
  }

  if (!days) days = standardDays(type, type === requestedType ? value : undefined, nowDay, notes);

  return freezePeriod({
    type,
    key: keyFor(type, days.startDay, days.endDay),
    label: labelFor(type, days.startDay, days.endDay),
    timeZone,
    // Обе даты включаются полностью: от первой миллисекунды первого дня
    // до последней миллисекунды последнего.
    naturalFrom: new Date(startOfDayInZone(days.startDay, timeZone)),
    naturalTo: new Date(endOfDayInZone(days.endDay, timeZone)),
    now,
    notes
  });
}

/**
 * Попадает ли момент в период. Включительно с обеих сторон: событие ровно на границе
 * принадлежит периоду, иначе сущность потерялась бы между соседними периодами.
 * У «Всей истории» нижней границы нет.
 */
export function inPeriod(value, period) {
  if (!period || !(period.to instanceof Date)) return false;
  const date = dateOrNull(value);
  if (!date) return false;
  if (period.from instanceof Date && date.getTime() < period.from.getTime()) return false;
  return date.getTime() <= period.to.getTime();
}

/**
 * Ключ периода указанного типа, в который попадает момент, — в часовом поясе портала.
 * Нужен интерфейсу, чтобы открыться на текущем периоде без запроса к серверу.
 */
export function periodKeyFromDate(type, value, timeZone) {
  const zone = safeZone(timeZone);
  const date = dateOrNull(value);
  if (!date) return '';
  const normalizedType = TYPE_ALIASES.get(String(type ?? '').toLowerCase().replace(/[^a-z]/g, '')) || DEFAULT_PERIOD_TYPE;
  if (normalizedType === 'allHistory') return 'all';
  const day = dayInZone(date.getTime(), zone);
  if (normalizedType === 'custom') return `${dayString(day)}..${dayString(day)}`;
  const days = standardDays(normalizedType, undefined, day, []);
  return keyFor(normalizedType, days.startDay, days.endDay);
}

/** Календарный день момента в часовом поясе портала: '2026-08-15'. */
export function formatDayInZone(value, timeZone) {
  const date = dateOrNull(value);
  if (!date) return '';
  return dayString(dayInZone(date.getTime(), safeZone(timeZone)));
}

/** Момент по часам портала для показа человеку: '15.08.2026 23:30'. */
export function formatDateTimeInZone(value, timeZone) {
  const date = dateOrNull(value);
  if (!date) return '';
  const parts = partsInZone(date.getTime(), safeZone(timeZone));
  return `${dayLabel(parts)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * Момент как «настенное» время портала, упакованное в Date с теми же полями
 * по UTC-геттерам. Excel не хранит часовой пояс — сериал строится из
 * getUTCHours/getUTCDate и т.д. (xlsx.js, excelSerial). Передать туда настоящий
 * UTC-момент напрямую значит показать в файле сдвинутое на офсет портала время
 * (а рядом полуночи — вообще другой календарный день). Эта функция даёт xlsx.js
 * ровно то, что он ожидает по контракту: обёртку, чьи UTC-поля читаются как
 * часы портала.
 */
export function wallClockAsUtc(value, timeZone) {
  const date = dateOrNull(value);
  if (!date) return null;
  const parts = partsInZone(date.getTime(), safeZone(timeZone));
  return new Date(utcMs(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, date.getUTCMilliseconds()));
}
