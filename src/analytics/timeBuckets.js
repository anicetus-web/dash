/**
 * Разбиение периода на бакеты для графиков динамики (звонки, обе конверсии).
 *
 * Масштаб зависит от типа периода, а не от его точной длины — заказчик задал
 * это явно: неделя показывает свои 7 дней, день — свои часы, а месяц и квартал
 * НАМЕРЕННО показывают куда более длинный тренд — последние 12 недель, — чтобы
 * узкий выбор одного месяца не превращался в график из 4 точек без контекста.
 * Год показывает 12 месяцев самого года. Единственное место в системе, где
 * решается этот масштаб — как period.js для границ; отдельный расчёт сюда
 * формулу не тащит.
 *
 * Границы бакетов ВСЕГДА строятся через resolvePeriod, то есть по настенным
 * часам портала. Наивная арифметика «+N часов» здесь недопустима: в сутки
 * перевода стрелок их 23 или 25, и шаг ровно по 3600000 мс либо теряет час
 * данных, либо сдвигает подписи всех бакетов после перевода (инвариант 11).
 */
import { resolvePeriod } from '../domain/period.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
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

/** День недели по ISO (1 = понедельник, 7 = воскресенье) для 'YYYY-MM-DD'. */
function isoWeekday(dayString) {
  const [year, month, day] = dayString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
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

/**
 * Часы суток по настенным часам портала.
 *
 * Шагаем не «+3600000 мс от начала», а календарным часом: следующий бакет
 * начинается там, где кончился предыдущий, а подпись берётся из самой зоны.
 * В сутки перевода стрелок бакетов получается 23 или 25 — столько, сколько
 * часов в этих сутках на самом деле, и подписи совпадают с часами портала.
 */
function hourlyBuckets(period, timeZone) {
  const zone = timeZone || period.timeZone || 'UTC';
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', hour: '2-digit' });
  const endMs = period.to.getTime();
  const buckets = [];
  let fromMs = period.from.getTime();
  // Предел итераций — страховка от экзотической зоны: суток длиннее 26 часов не бывает.
  for (let guard = 0; guard < 26 && fromMs <= endMs; guard += 1) {
    const nextMs = fromMs + HOUR_MS;
    buckets.push({
      label: `${formatter.format(new Date(fromMs))}:00`,
      fromMs,
      toMs: Math.min(nextMs - 1, endMs)
    });
    fromMs = nextMs;
  }
  return buckets;
}

/**
 * Календарные дни подряд. Ограничены и количеством, и КОНЦОМ ПЕРИОДА:
 * без второго ограничения диапазон из трёх дней рисовал бы четвёртый бакет
 * за пределами выбранного периода — всегда нулевой, и на графике это читалось
 * бы как реальный обрыв показателя в последний день.
 */
function dailyBuckets(startDayString, count, now, timeZone, limitMs) {
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const dayString = shiftDayString(startDayString, i);
    const day = resolvePeriod({ type: 'day', value: dayString }, { now, timeZone });
    if (day.from.getTime() > now.getTime()) break;
    if (limitMs !== undefined && day.from.getTime() > limitMs) break;
    buckets.push({ label: dayShortLabel(dayString), fromMs: day.from.getTime(), toMs: day.to.getTime() });
  }
  return buckets;
}

/**
 * Последние `count` недель, считая от недели, в которую попал `anchorDayString`.
 *
 * Якорь ПРИВОДИТСЯ к воскресенью своей ISO-недели: без этого «недели» были бы
 * произвольными семидневками, кончающимися сегодня, и два человека, открывшие
 * один и тот же месяц в разные дни, увидели бы разные границы недель и разные
 * числа в столбцах. Везде в приложении неделя — понедельник–воскресенье
 * (period.js, ISO), график обязан говорить тем же словом.
 */
function trailingWeeklyBuckets(anchorDayString, count, now, timeZone) {
  const anchorSunday = shiftDayString(anchorDayString, 7 - isoWeekday(anchorDayString));
  const buckets = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const endDay = shiftDayString(anchorSunday, -7 * i);
    const startDay = shiftDayString(endDay, -6);
    const window = resolvePeriod({ type: 'custom', from: startDay, to: endDay }, { now, timeZone });
    if (window.from.getTime() > now.getTime()) continue;
    buckets.push({ label: weekShortLabel(startDay, endDay), fromMs: window.from.getTime(), toMs: window.to.getTime() });
  }
  return buckets;
}

/** Календарные месяцы подряд, начиная с `startMonthString`. Будущие месяцы отбрасываются. */
function monthlyBuckets(startMonthString, count, now, timeZone) {
  const buckets = [];
  for (let i = 0; i < count; i += 1) {
    const monthString = shiftMonthString(startMonthString, i);
    const window = resolvePeriod({ type: 'month', value: monthString }, { now, timeZone });
    if (window.from.getTime() > now.getTime()) break;
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
  const zone = timeZone || period.timeZone;
  const type = period.type;

  if (type === 'day') return hourlyBuckets(period, zone);
  if (type === 'week') return dailyBuckets(period.fromDay, 7, clockNow, zone, period.naturalTo?.getTime());
  if (type === 'month' || type === 'quarter') return trailingWeeklyBuckets(period.toDay, 12, clockNow, zone);
  // Год — двенадцать месяцев ИМЕННО этого года, а не последние двенадцать от
  // сегодня: иначе выбранный «2026 год» рисовал бы сен 2025 — авг 2026, то есть
  // график двух разных лет под заголовком одного.
  if (type === 'year') return monthlyBuckets(`${period.fromDay.slice(0, 4)}-01`, 12, clockNow, zone);

  // custom / allHistory — масштаб не задан явно: выбираем по длине диапазона,
  // повторяя правило одного из стандартных типов той же протяжённости.
  //
  // Длина считается по ЕСТЕСТВЕННОМУ концу (naturalTo), а не по обрезанному
  // текущим моментом `to`: неделя, выбранная сегодня в среду, остаётся неделей
  // и обязана рисоваться по дням, а не «превращаться» в 12-недельный тренд
  // из-за того, что четыре её дня ещё не наступили.
  const endForSpan = period.naturalTo || period.to;
  const spanDays = period.from
    // +1 мс, потому что граница периода — ПОСЛЕДНЯЯ миллисекунда суток
    // (period.js), а не полночь следующих: без этого ровно 7 суток дают 6.99999.
    ? Math.round((endForSpan.getTime() - period.from.getTime() + 1) / DAY_MS)
    : 366;
  const limitMs = period.naturalTo ? period.naturalTo.getTime() : undefined;
  if (spanDays <= 1) return hourlyBuckets(period, zone);
  if (spanDays <= 7) return dailyBuckets(period.fromDay, spanDays, clockNow, zone, limitMs);
  if (spanDays <= 120) return trailingWeeklyBuckets(period.toDay, 12, clockNow, zone);
  return monthlyBuckets(shiftMonthString(period.toDay.slice(0, 7), -11), 12, clockNow, zone);
}
