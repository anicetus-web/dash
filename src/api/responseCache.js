/**
 * Кэш рассчитанных ответов дашборда.
 *
 * Зачем. Расчёт среза — чистая функция снимка и параметров запроса, но на
 * портале в 5000 компаний он стоит ~45 мс процессорного времени ДАЖЕ с
 * кэшем индекса, и Node выполняет их по одному: 50 одновременных читателей
 * упираются в секунду ожидания. При этом 200 сотрудников смотрят в основном
 * ОДИН И ТОТ ЖЕ экран — период по умолчанию без фильтров. Второй и все
 * последующие такие запросы не должны считаться заново.
 *
 * Где живёт. На HTTP-слое, а не внутри расчётного модуля: инвариант 9
 * («формулы только в одном месте») этим не нарушается — здесь не считают,
 * здесь запоминают уже посчитанное. Расчётный модуль остаётся чистым и
 * ничего не знает ни про кэш, ни про время жизни записи.
 *
 * Ключ — три части:
 *   1. Сам объект снимка (WeakMap). `JsonStore` заменяет снимок НОВЫМ
 *      объектом при каждой успешной синхронизации, поэтому свежие данные
 *      промахиваются мимо кэша автоматически, без ручной инвалидации, а
 *      записи от прежнего снимка собираются сборщиком мусора вместе с ним.
 *   2. Нормализованные параметры среза.
 *   3. Округлённое время (см. BUCKET_MS). Границы незакрытого периода и
 *      признак устаревания данных зависят от «сейчас»: без этой части ключа
 *      пользователь увидел бы конец периода, застывший на моменте первого
 *      расчёта. Округление ограничивает расхождение сверху — оно заведомо
 *      меньше и минуты, тогда как порог устаревания снимка исчисляется
 *      десятками минут, а конец периода показывается с точностью до минуты.
 */

/** Шаг округления «сейчас» в ключе. Верхняя граница расхождения кэша с реальностью. */
const BUCKET_MS = 15_000;

/**
 * Предел числа записей на один снимок. Комбинаций фильтров у 200 человек
 * может быть много, и кэш без предела рос бы до следующей синхронизации.
 * При переполнении вытесняется самая старая запись (обычные Map в JS
 * сохраняют порядок вставки, поэтому первый ключ итерации — он и есть).
 */
const MAX_ENTRIES_PER_SNAPSHOT = 240;

const cache = new WeakMap();

/** Ключ среза: только то, что реально влияет на результат расчёта. */
function requestKey(request, bucket) {
  return JSON.stringify([
    request.mode ?? null,
    request.periodType ?? null,
    request.periodValue ?? null,
    request.from ?? null,
    request.to ?? null,
    request.sourceIds ?? null,
    request.managerIds ?? null,
    request.kevFormats ?? null,
    request.conversionFrom ?? null,
    request.conversionTo ?? null,
    bucket
  ]);
}

/**
 * Отдаёт готовый ответ из кэша либо считает его через `compute` и запоминает.
 *
 * @param {object} snapshot снимок из хранилища — он же ключ инвалидации
 * @param {object} request   параметры среза из строки запроса
 * @param {Function} compute () => результат расчёта
 * @param {number} [nowMs]   инъекция времени для проверок
 */
export function cachedDashboard(snapshot, request, compute, nowMs = Date.now()) {
  if (!snapshot || typeof snapshot !== 'object') return compute();

  const bucket = Math.floor(nowMs / BUCKET_MS);
  const key = requestKey(request, bucket);

  let entries = cache.get(snapshot);
  if (!entries) {
    entries = new Map();
    cache.set(snapshot, entries);
  }

  if (entries.has(key)) return entries.get(key);

  const value = compute();

  // Записи с прошлым временным окном уже никогда не будут запрошены —
  // чистим их, чтобы предел вытеснял реальные варианты фильтров, а не мусор.
  for (const existing of entries.keys()) {
    if (!existing.endsWith(`,${bucket}]`)) entries.delete(existing);
  }
  if (entries.size >= MAX_ENTRIES_PER_SNAPSHOT) {
    entries.delete(entries.keys().next().value);
  }

  entries.set(key, value);
  return value;
}

/** Число записей для данного снимка. Только для проверок. */
export function cacheSizeFor(snapshot) {
  return cache.get(snapshot)?.size ?? 0;
}
