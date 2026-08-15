// Безопасное чтение разнородных полей CRM.
//
// Битрикс отдаёт одно и то же поле то строкой, то числом, то массивом, а имена полей
// встречаются в разном регистре (`ASSIGNED_BY_ID`, `assignedById`). Нормализация собрана здесь,
// чтобы нормализаторы компании и сделки не изобретали её каждый по-своему: расхождение в чтении
// ID или даты означает разные числа на ступени и в детализации.

// Ключ поля без регистра и разделителей: ASSIGNED_BY_ID и assignedById — одно и то же поле,
// портал отдаёт его по-разному в разных методах.
function fieldKey(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9а-яё]/g, '');
}

// Первое непустое значение среди нескольких написаний имени поля.
// Сначала точное совпадение (быстрый путь), затем — нестрогое сравнение имён.
export function valueOf(record, keys, fallback = undefined) {
  if (!record || typeof record !== 'object') return fallback;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  const wanted = keys.map(fieldKey);
  for (const key of Object.keys(record)) {
    if (!wanted.includes(fieldKey(key))) continue;
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

// Текстовое поле: всегда строка без хвостовых пробелов.
export function textOf(record, keys, fallback = '') {
  const value = valueOf(record, keys);
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return fallback;
  const result = String(value).trim();
  return result === '' ? fallback : result;
}

// Строгая нормализация идентификатора: всё, что не похоже на ID, превращается в ''.
// Дедупликация держится на этом (инвариант 1): «12», 12 и « 12 » обязаны быть одним ключом,
// иначе одна сущность посчитается дважды. Нулевой и отрицательный ID Битрикса не бывает —
// такое значение означает «связи нет», и его нельзя путать с настоящим ID.
export function idOf(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return '';
    return String(value);
  }
  if (typeof value === 'bigint') return value > 0n ? String(value) : '';
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  // Числовой ID приводим к канонической форме: '007' и '7' — один и тот же ID.
  if (/^\d+$/.test(trimmed)) {
    const normalized = trimmed.replace(/^0+(?=\d)/, '');
    return normalized === '0' ? '' : normalized;
  }
  // Нечисловые ID (например, строковые ID стадий вида 'C78:NEW') оставляем как есть.
  return trimmed;
}

// Список ID: принимает скаляр или массив, выкидывает мусор, снимает дубли, сохраняет порядок.
export function idsOf(value) {
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  for (const item of source) {
    const id = idOf(item);
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

// Число из поля CRM: '1 234,50|RUB' → 1234.5. Непонятное значение — 0, не NaN.
export function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const clean = value.split('|')[0].replace(/\s/g, '').replace(',', '.');
    if (clean === '') return 0;
    const parsed = Number(clean);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

// Булево поле Битрикса: 'Y'/'N', 1/0, 'true'/'false'. Непонятное значение — fallback.
export function boolOf(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return fallback;
  if (['y', '1', 'true', 'yes', 'да'].includes(normalized)) return true;
  if (['n', '0', 'false', 'no', 'нет'].includes(normalized)) return false;
  return fallback;
}

// Текст для сравнения и поиска: регистр, «ё» и пунктуация не должны разводить одинаковые значения.
export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Секунды и миллисекунды эпохи различаем по порядку величины:
// 1e11 мс — это 1973 год, столько же секунд — 5138 год. Реальных дат по обе стороны границы нет.
const EPOCH_SECONDS_LIMIT = 1e11;

// Дата события. Всё, что не разбирается, — null: невалидная дата обязана исчезнуть на входе,
// а не превратиться в Invalid Date и молча выпасть из сравнений периода посреди расчёта.
export function dateOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    const ms = value < EPOCH_SECONDS_LIMIT ? value * 1000 : value;
    const fromNumber = new Date(ms);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return dateOrNull(Number(trimmed));
  // Дата без указания зоны ('2026-08-15 10:30:00') трактуется как UTC.
  // Это осознанный выбор ради детерминизма: иначе результат зависел бы от часового пояса
  // машины, на которой запущен сервер, и проверки давали бы разный ответ на разных машинах.
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(:\d{2})?(\.\d+)?)$/.exec(trimmed);
  const iso = naive ? `${naive[1]}T${naive[2]}Z` : trimmed;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Дата в каноническом виде для хранения в снимке.
export function isoOrNull(value) {
  const date = dateOrNull(value);
  return date ? date.toISOString() : null;
}
