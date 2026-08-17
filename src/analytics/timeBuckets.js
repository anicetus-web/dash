/**
 * Разбиение периода на бакеты для графиков динамики (звонки, обе конверсии).
 *
 * Масштаб зависит от типа периода, а не от его точной длины — заказчик задал
 * это явно: неделя показывает свои 7 дней, день — свои часы, а месяц и квартал
 * НАМЕРЕННО показывают куда более длинный тренд — последние 12 недель, — чтобы
 * узкий выбор одного месяца не превращался в график из 4 точек без контекста.
 * Год показывает последние 12 месяцев. Единственное место в системе, где решается
 * этот масштаб — как period.js для границ, отдельный расчёт сюда формулу не тащит.
 */
import { resolvePeriod } from '../domain/period.js';

const HOUR_MS = 60 * 60 * 1000;
const MONTHS_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 'YYYY-MM-DD' + N дней → 'YYYY-MM-DD'. Только календарная арифметика, без зоны и без часов —
 *  зону подключает resolvePeriod при превращении дня в границу. */
function shiftDayString(dayString, deltaDays) {
  const [year, month, day] = dayString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** 'YYYY-MM' + N месяцев → 'YYYY-MM'. */
function shiftMonthString(monthString, deltaMonths) {
  const [year, month] = monthString.split('-').map(Number);
  const total = year * 12 + (month - 1) + deltaMonths;
  const normalizedYear = Math.floor(total / 12);
  const normalizedMonth = ((total % 12) + 12) % 12 + 1;
  return `${normalizedYear}-${pad2(normalizedMonth)}`;
}

function dayShortLabel(dayString) {
  const [, month, day] = dayString.split('-');
  return `${day}.${month}`;
}

function weekShortLabel(startDayString, endDayString) {
  return `${dayShortLabel(startDayString)}–${dayShortLabel(endDayString)}`;
}

function monthShortLabel(monthString) {
  const [year, month] = monthString.split('-').map(Number);
  return `${MONTHS_SHORT_RU[month - 1]} ${year}`;
}

function hourlyBuckets(period) {
  const startMs = period.from.getTime();
  const endMs = period.to.getTime();
  const buckets = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const fromMs = startMs + hour * HOUR_MS;
    if (fromMs > endMs) break;
    const toMs = Math.min(fromMs + HOUR_MS - 1, endMs);
    buckets.push({ label: `${pad2(hour)}:00`, fromMs, toMs });
  }
  return buckets;
}

function dailyBuckets(startDayString, count, now, timeZone) {
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const dayString = shiftDayString(startDayString, i);
    const day = resolvePeriod({ type: 'day', value: dayString }, { now, timeZone });
    if (day.from.getTime() > now.getTime()) break;
    buckets.push({ label: dayShortLabel(dayString), fromMs: day.from.getTime(), toMs: day.to.getTime() });
  }
  return buckets;
}

function trailingWeeklyBuckets(anchorDayString, count, now, timeZone) {
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const endDay = shiftDayString(anchorDayString, -7 * i);
    const startDay = shiftDayString(endDay, -6);
    const window = resolvePeriod({ type: 'custom', from: startDay, to: endDay }, { now, timeZone });
    if (window.from.getTime() > now.getTime()) continue;
    buckets.push({ label: weekShortLabel(startDay, endDay), fromMs: window.from.getTime(), toMs: window.to.getTime() });
  }
  return buckets;
}

function trailingMonthlyBuckets(anchorDayString, count, now, timeZone) {
  const anchorMonth = anchorDayString.slice(0, 7);
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const monthString = shiftMonthString(anchorMonth, -i);
    const window = resolvePeriod({ type: 'month', value: monthString }, { now, timeZone });
    if (window.from.getTime() > now.getTime()) continue;
    buckets.push({ label: monthShortLabel(monthString), fromMs: window.from.getTime(), toMs: window.to.getTime() });
  }
  return buckets;
}

/**
 * Бакеты графика для уже разрешённого периода (`resolvePeriod()`).
 *
 * @returns {{label: string, fromMs: number, toMs: number}[]}
 */
export function resolveBucketWindows(period, { now, timeZone } = {}) {
  const clockNow = now instanceof Date ? now : new Date();
  const type = period.type;

  if (type === 'day') return hourlyBuckets(period);
  if (type === 'week') return dailyBuckets(period.fromDay, 7, clockNow, timeZone);
  if (type === 'month' || type === 'quarter') return trailingWeeklyBuckets(period.toDay, 12, clockNow, timeZone);
  if (type === 'year') return trailingMonthlyBuckets(period.toDay, 12, clockNow, timeZone);

  // custom / allHistory — масштаб не задан явно: выбираем по длине диапазона,
  // повторяя правило одного из стандартных типов той же протяжённости.
  const spanDays = period.from
    ? Math.round((period.to.getTime() - period.from.getTime()) / (24 * HOUR_MS)) + 1
    : 366;
  if (spanDays <= 1) return hourlyBuckets(period);
  if (spanDays <= 7) return dailyBuckets(period.fromDay, spanDays, clockNow, timeZone);
  if (spanDays <= 120) return trailingWeeklyBuckets(period.toDay, 12, clockNow, timeZone);
  return trailingMonthlyBuckets(period.toDay, 12, clockNow, timeZone);
}
