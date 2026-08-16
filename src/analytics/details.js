/**
 * Детализация ступени: список конкретных сущностей, сформировавших её число.
 *
 * Инвариант 8: детализация НЕ имеет собственного отбора. Она берёт те же
 * множества, что и агрегат, из `computeSlice`. Поэтому число ступени и количество
 * уникальных строк совпадают по построению, а не по совпадению — разойтись
 * они могут только вместе.
 */

import {
  CROSS_FUNNEL_SEQUENCE,
  FUNNELS,
  JUNCTION,
  UNITS,
  capReachedIndexByCurrentStage,
  funnelStages,
  isLostStageId,
  isServiceStageId,
  stageById
} from '../domain/funnels.js';
import { computeSlice } from './dashboard.js';
import { parseList } from './filters.js';
import { NOT_SPECIFIED } from './snapshot.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

function nameFrom(dictionary, id, fallback) {
  if (!id || id === NOT_SPECIFIED) return fallback;
  return dictionary.get(id) || id;
}

/** Ссылка на карточку портала. Строится на сервере: браузер адрес портала не знает. */
function cardUrl(portalUrl, entityType, id) {
  if (!portalUrl) return null;
  const base = String(portalUrl).replace(/\/+$/, '');
  const path = entityType === 'company' ? 'company' : 'deal';
  return `${base}/crm/${path}/details/${encodeURIComponent(id)}/`;
}

/**
 * Даты прохождения этапов сущности — для проверки происхождения показателя.
 *
 * Кэп текущей стадией — тот же, что применяет агрегат (инвариант 4): иначе для
 * откатившейся сделки строка показывала бы дату этапа, в число которого сама
 * сделка уже не засчитана — даты противоречили бы счётчику, а не объясняли его.
 */
function stageDates(slice, entityType, entityId, currentStageId) {
  const funnel = entityType === 'company' ? FUNNELS.companies : FUNNELS.deals;
  const events = entityType === 'company'
    ? slice.index.companyEvents.get(entityId) || []
    : slice.index.dealEvents.get(entityId) || [];

  const cap = capReachedIndexByCurrentStage(funnel, funnelStages(funnel).length - 1, currentStageId);

  const seen = new Set();
  const dates = [];
  for (const event of events) {
    const stage = stageById(funnel, event.stageId);
    // Повторные переходы одной сущности не создают повторных строк:
    // показывается первое прохождение каждого этапа. Этапы выше кэпа отката
    // отбрасываются — агрегат их этой сущности тоже не засчитывает.
    if (!stage || stage.index > cap || seen.has(stage.role)) continue;
    seen.add(stage.role);
    dates.push({ role: stage.role, name: stage.name, at: new Date(event.at).toISOString() });
  }
  return dates;
}

function currentStageName(entityType, currentStageId, isLost = false) {
  const funnel = entityType === 'company' ? FUNNELS.companies : FUNNELS.deals;
  const stage = stageById(funnel, currentStageId);
  if (stage) return stage.name;
  // Отказ — не этап воронки, но пользователю нужно видеть именно «Отказ»,
  // а не техническое «вне воронки»: сделка на ступени осталась осознанно,
  // она сохраняет путь, пройденный до отказа.
  if (isLost || isLostStageId(currentStageId)) return 'Отказ';
  if (isServiceStageId(currentStageId)) return 'Создана';
  return currentStageId ? 'Вне воронки' : 'Не указан';
}

/**
 * Строка реестра.
 * Контактные данные — телефоны, email, комментарии — сюда не попадают никогда:
 * выгрузка и детализация обезличены по требованию спеки.
 */
function buildRow(slice, entityType, entityId, attribution, portalUrl) {
  const { index } = slice;

  if (entityType === UNITS.company) {
    const company = index.companies.get(entityId);
    if (!company) return null;
    return {
      entityType: 'company',
      id: company.id,
      title: company.title,
      sourceId: company.sourceId,
      sourceName: nameFrom(index.sources, company.sourceId, 'Источник не указан'),
      managerId: attribution?.managerId ?? company.assignedById,
      managerName: nameFrom(index.managers, attribution?.managerId ?? company.assignedById, 'Не назначен'),
      currentStageName: currentStageName('company', company.currentStageId),
      stageAt: attribution?.at ? new Date(attribution.at).toISOString() : null,
      stageDates: stageDates(slice, 'company', company.id, company.currentStageId),
      url: cardUrl(portalUrl, 'company', company.id)
    };
  }

  const deal = index.deals.get(entityId);
  if (!deal) return null;
  const company = deal.companyId ? index.companies.get(deal.companyId) : null;
  return {
    entityType: 'deal',
    id: deal.id,
    title: deal.title,
    companyId: deal.companyId,
    companyTitle: company ? company.title : null,
    sourceId: deal.sourceId,
    sourceName: nameFrom(index.sources, deal.sourceId, 'Источник не указан'),
    managerId: attribution?.managerId ?? deal.assignedById,
    managerName: nameFrom(index.managers, attribution?.managerId ?? deal.assignedById, 'Не назначен'),
    kevFormatId: deal.kevFormatId,
    kevFormatName: nameFrom(index.kevFormats, deal.kevFormatId, 'Не указано'),
    currentStageName: currentStageName('deal', deal.currentStageId, deal.isLost),
    isLost: deal.isLost,
    stageAt: attribution?.at ? new Date(attribution.at).toISOString() : null,
    stageDates: stageDates(slice, 'deal', deal.id, deal.currentStageId),
    url: cardUrl(portalUrl, 'deal', deal.id)
  };
}

/**
 * Фильтры ВНУТРИ модалки детализации — отдельные от фильтров дашборда сверху.
 * Те уже применены на уровне `computeSlice`, до попадания сюда (сужают, какие
 * компании/сделки вообще участвуют в срезе). Эти сужают уже отобранный список
 * КОНКРЕТНОЙ ступени ещё раз, без изменения фильтров всего дашборда — «покажи
 * из этих 188 компаний на этой ступени только тех, что на менеджере Иванове».
 */
function normalizeDetailFilters(raw = {}) {
  return {
    sourceIds: parseList(raw.detailSourceIds),
    managerIds: parseList(raw.detailManagerIds),
    kevFormats: parseList(raw.detailKevFormats),
    // По ИМЕНИ текущего этапа, не по техническому ID: currentStageName() уже
    // разворачивает «Отказ»/«Вне воронки»/«Создана» из служебных случаев —
    // фильтр обязан бить по тому же значению, что видно в колонке таблицы.
    currentStageNames: parseList(raw.detailCurrentStage),
    // Поиск по ID — подстрокой, не точным совпадением: искать «543», не
    // дописывая полный номер, привычнее, чем строгое равенство.
    search: String(raw.detailSearch ?? '').trim()
  };
}

function detailFiltersActive(filters) {
  return Boolean(
    filters.sourceIds || filters.managerIds || filters.kevFormats || filters.currentStageNames || filters.search
  );
}

function entityOf(slice, unit, id) {
  return unit === UNITS.company ? slice.index.companies.get(id) : slice.index.deals.get(id);
}

function entityCurrentStageName(unit, entity) {
  return unit === UNITS.company
    ? currentStageName('company', entity.currentStageId)
    : currentStageName('deal', entity.currentStageId, entity.isLost);
}

function passesDetailFilters(slice, unit, id, attribution, filters) {
  const entity = entityOf(slice, unit, id);
  if (!entity) return false;
  if (filters.sourceIds && !filters.sourceIds.has(entity.sourceId || NOT_SPECIFIED)) return false;
  const managerId = attribution?.managerId ?? entity.assignedById;
  if (filters.managerIds && !filters.managerIds.has(managerId || NOT_SPECIFIED)) return false;
  // КЭВ применим только к сделкам (приложение А1 спеки, dealPasses в filters.js) —
  // у компаний фильтр просто ничего не режет, как и в фильтрах дашборда сверху.
  if (filters.kevFormats && unit === UNITS.deal && !filters.kevFormats.has(entity.kevFormatId || NOT_SPECIFIED)) return false;
  if (filters.currentStageNames && !filters.currentStageNames.has(entityCurrentStageName(unit, entity))) return false;
  if (filters.search && !String(id).includes(filters.search)) return false;
  return true;
}

/**
 * Множество и атрибуция для ступени сквозной последовательности.
 * Возвращает ровно то, что посчитал агрегат.
 */
function stageSelection(slice, step) {
  if (step.junction) {
    // На стыке единица учёта — сделка, как и в агрегате.
    return {
      unit: UNITS.deal,
      ids: slice.dealResult.sets[JUNCTION.dealIndex],
      attribution: slice.dealResult.attribution[JUNCTION.dealIndex]
    };
  }
  if (step.units[0] === UNITS.company) {
    return {
      unit: UNITS.company,
      ids: slice.companyResult.sets[step.position],
      attribution: slice.companyResult.attribution[step.position]
    };
  }
  const dealIndex = step.position - JUNCTION.companyIndex;
  return {
    unit: UNITS.deal,
    ids: slice.dealResult.sets[dealIndex],
    attribution: slice.dealResult.attribution[dealIndex]
  };
}

/**
 * Множество ступени и её сущности в устойчивом порядке (сначала по дате
 * прохождения, затем по идентификатору) — общая часть между интерактивной
 * детализации и полной выгрузкой без обрезки страницей.
 */
function resolveStage(snapshot, request, options, precomputedSlice) {
  const step = CROSS_FUNNEL_SEQUENCE.find((item) => item.role === request.stageRole);
  if (!step) {
    const error = new Error(`Неизвестная ступень: ${String(request.stageRole)}`);
    error.code = 'BAD_STAGE';
    error.status = 400;
    throw error;
  }

  // Выгрузка XLSX вызывает getFullStageRows один раз НА КАЖДУЮ ступень (их ~16) для
  // одного и того же snapshot/request/options — без общего среза это ~16 независимых
  // полных пересчётов воронки вместо одного. precomputedSlice пропускает пересчёт,
  // когда вызывающий (report.js) уже посчитал срез сам.
  const slice = precomputedSlice || computeSlice(snapshot, request, options);
  const selection = stageSelection(slice, step);
  const ids = [...selection.ids];

  // Без устойчивого порядка страницы «плавали» бы между запросами интерфейса
  // и часть сущностей терялась при перелистывании.
  ids.sort((a, b) => {
    const left = selection.attribution.get(a)?.at ?? 0;
    const right = selection.attribution.get(b)?.at ?? 0;
    return left - right || String(a).localeCompare(String(b), 'ru');
  });

  return { slice, step, selection, ids };
}

/**
 * Детализация ступени. Используется интерфейсом — результат постранично обрезан.
 *
 * @param {object} snapshot нормализованный снимок
 * @param {object} request  тот же срез, что у дашборда, плюс stageRole/page/pageSize
 * @param {object} options  {now, timeZone, portalUrl}
 */
export function getStageDetails(snapshot, request = {}, options = {}) {
  const { slice, step, selection, ids } = resolveStage(snapshot, request, options);

  // Варианты «Текущего этапа» — из ПОЛНОГО списка ступени, ДО фильтров детализации:
  // иначе после первого же выбора в этом самом фильтре список вариантов схлопнулся
  // бы сам под себя, и переключиться на другое значение стало бы нельзя.
  const stageOptions = [...new Set(
    ids.map((id) => {
      const entity = entityOf(slice, selection.unit, id);
      return entity ? entityCurrentStageName(selection.unit, entity) : null;
    }).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ru'));

  const detailFilters = normalizeDetailFilters(request);
  const filteredIds = detailFiltersActive(detailFilters)
    ? ids.filter((id) => passesDetailFilters(slice, selection.unit, id, selection.attribution.get(id), detailFilters))
    : ids;

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(request.pageSize, 10) || DEFAULT_PAGE_SIZE)
  );
  // Общее количество считается ДО постраничной обрезки: шапка списка обязана
  // совпадать с числом ступени даже на первой странице из десяти.
  const count = filteredIds.length;
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.parseInt(request.page, 10) || 1));

  const slicedIds = filteredIds.slice((page - 1) * pageSize, page * pageSize);
  const rows = slicedIds
    .map((id) => buildRow(slice, selection.unit, id, selection.attribution.get(id), options.portalUrl))
    .filter(Boolean);

  return {
    stage: {
      position: step.position,
      role: step.role,
      name: step.junction ? JUNCTION.pluralName : step.name,
      unit: selection.unit,
      junction: step.junction === true
    },
    count,
    totalCount: ids.length,
    stageOptions,
    page,
    pageSize,
    pageCount,
    appliedRequest: {
      mode: slice.mode,
      period: { type: slice.period.type, key: slice.period.key, label: slice.period.label }
    },
    rows
  };
}

/**
 * Полный, НЕобрезанный список сущностей ступени. Только для выгрузки: интерфейс
 * ограничивает страницу 500 строками ради отзывчивости браузера, но выгрузка
 * обязана содержать все сущности среза — иначе она незаметно расходится с тем,
 * что показывает дашборд на большом портале.
 *
 * @param {object} snapshot нормализованный снимок
 * @param {object} request  тот же срез, что у дашборда, плюс stageRole
 * @param {object} options  {now, timeZone, portalUrl}
 * @param {object} [precomputedSlice] срез, уже посчитанный вызывающим (см. resolveStage) —
 *   для выгрузки всех ступеней подряд экономит ~16 полных пересчётов воронки на один запрос
 * @returns {{stage: object, count: number, rows: Array}}
 */
export function getFullStageRows(snapshot, request = {}, options = {}, precomputedSlice) {
  const { slice, step, selection, ids } = resolveStage(snapshot, request, options, precomputedSlice);
  const rows = ids
    .map((id) => buildRow(slice, selection.unit, id, selection.attribution.get(id), options.portalUrl))
    .filter(Boolean);

  return {
    stage: {
      position: step.position,
      role: step.role,
      name: step.junction ? JUNCTION.pluralName : step.name,
      unit: selection.unit,
      junction: step.junction === true
    },
    count: rows.length,
    rows
  };
}

/** Сквозная последовательность ступеней для справочника интерфейса. */
export function stageReference() {
  return CROSS_FUNNEL_SEQUENCE.map((step) => {
    const funnelId = step.junction
      ? FUNNELS.deals.id
      : (step.units[0] === UNITS.company ? FUNNELS.companies.id : FUNNELS.deals.id);
    const definition = step.junction
      ? null
      : funnelStages(funnelId).find((item) => item.role === step.role);
    return {
      position: step.position,
      role: step.role,
      name: step.junction ? JUNCTION.pluralName : step.name,
      funnelId,
      unit: step.junction ? UNITS.deal : step.units[0],
      junction: step.junction === true,
      operational: definition?.operational === true,
      commercialResult: definition?.commercialResult === true
    };
  });
}
