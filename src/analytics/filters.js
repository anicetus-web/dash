/**
 * Фильтры среза.
 *
 * Правила комбинирования (спека, раздел «Фильтры»):
 *   - несколько значений ОДНОГО фильтра — по ИЛИ;
 *   - разные фильтры — по И;
 *   - пустой выбор означает «все значения», а не «ничего».
 *
 * Фильтр менеджера здесь НЕ применяется: он относится к исполнителю конкретной
 * ступени, а не к сущности целиком, и живёт в `funnel.js` (инвариант 7).
 */

import { NOT_SPECIFIED } from './snapshot.js';

/** Разбор списка значений из строки запроса или массива. `null` — фильтр выключен. */
export function parseList(value) {
  if (value === null || value === undefined) return null;
  const items = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = items
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '');
  return cleaned.length > 0 ? new Set(cleaned) : null;
}

/**
 * Нормализованный набор фильтров.
 * Каждое поле — `Set` выбранных значений или `null`, если фильтр выключен.
 */
export function normalizeFilters(raw = {}) {
  return {
    sourceIds: parseList(raw.sourceIds),
    managerIds: parseList(raw.managerIds),
    kevFormats: parseList(raw.kevFormats)
  };
}

/**
 * Проверка значения по фильтру.
 * Незаполненное значение сущности сведено к `NOT_SPECIFIED` ещё при индексации,
 * поэтому «Источник не указан» выбирается наравне с обычными значениями —
 * и НЕ попадает в выборку, когда выбрана конкретная база.
 */
function matches(selected, value) {
  if (!selected) return true;
  return selected.has(value || NOT_SPECIFIED);
}

/** Компания проходит фильтры уровня сущности. КЭВ к компаниям неприменим (приложение А1). */
export function companyPasses(company, filters) {
  return matches(filters.sourceIds, company.sourceId);
}

/**
 * Сделка проходит фильтры уровня сущности.
 *
 * Фильтр КЭВ применяется ТОЛЬКО здесь — то есть только ко второй воронке.
 * Приложение А1 спеки: у компаний, не дошедших до «Потребность выявлена»,
 * формата КЭВ не существует в принципе, и обнулять из-за него верх воронки неверно.
 */
export function dealPasses(deal, filters) {
  return matches(filters.sourceIds, deal.sourceId) && matches(filters.kevFormats, deal.kevFormatId);
}

/** Описание применённых фильтров для ответа API. Множества разворачиваются в массивы. */
export function describeFilters(filters) {
  return {
    sourceIds: filters.sourceIds ? [...filters.sourceIds] : [],
    managerIds: filters.managerIds ? [...filters.managerIds] : [],
    kevFormats: filters.kevFormats ? [...filters.kevFormats] : []
  };
}

/** Хотя бы один фильтр активен. Нужно, чтобы отличить «пусто из-за фильтров» от «пустой снимок». */
export function anyActive(filters) {
  return Boolean(filters.sourceIds || filters.managerIds || filters.kevFormats);
}
