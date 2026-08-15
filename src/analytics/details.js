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
  funnelStages,
  stageById
} from '../domain/funnels.js';
import { computeSlice } from './dashboard.js';
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

/** Даты прохождения этапов сущности — для проверки происхождения показателя. */
function stageDates(slice, entityType, entityId) {
  const funnel = entityType === 'company' ? FUNNELS.companies : FUNNELS.deals;
  const events = entityType === 'company'
    ? slice.index.companyEvents.get(entityId) || []
    : slice.index.dealEvents.get(entityId) || [];

  const seen = new Set();
  const dates = [];
  for (const event of events) {
    const stage = stageById(funnel, event.stageId);
    // Повторные переходы одной сущности не создают повторных строк:
    // показывается первое прохождение каждого этапа.
    if (!stage || seen.has(stage.role)) continue;
    seen.add(stage.role);
    dates.push({ role: stage.role, name: stage.name, at: new Date(event.at).toISOString() });
  }
  return dates;
}

function currentStageName(entityType, currentStageId) {
  const funnel = entityType === 'company' ? FUNNELS.companies : FUNNELS.deals;
  const stage = stageById(funnel, currentStageId);
  if (stage) return stage.name;
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
      stageDates: stageDates(slice, 'company', company.id),
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
    currentStageName: currentStageName('deal', deal.currentStageId),
    isLost: deal.isLost,
    stageAt: attribution?.at ? new Date(attribution.at).toISOString() : null,
    stageDates: stageDates(slice, 'deal', deal.id),
    url: cardUrl(portalUrl, 'deal', deal.id)
  };
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
 * Детализация ступени.
 *
 * @param {object} snapshot нормализованный снимок
 * @param {object} request  тот же срез, что у дашборда, плюс stageRole/page/pageSize
 * @param {object} options  {now, timeZone, portalUrl}
 */
export function getStageDetails(snapshot, request = {}, options = {}) {
  const step = CROSS_FUNNEL_SEQUENCE.find((item) => item.role === request.stageRole);
  if (!step) {
    const error = new Error(`Неизвестная ступень: ${String(request.stageRole)}`);
    error.code = 'BAD_STAGE';
    error.status = 400;
    throw error;
  }

  const slice = computeSlice(snapshot, request, options);
  const selection = stageSelection(slice, step);

  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(request.pageSize, 10) || DEFAULT_PAGE_SIZE)
  );
  const ids = [...selection.ids];
  // Общее количество считается ДО постраничной обрезки: шапка списка обязана
  // совпадать с числом ступени даже на первой странице из десяти.
  const count = ids.length;
  const pageCount = Math.max(1, Math.ceil(count / pageSize));
  const page = Math.min(pageCount, Math.max(1, Number.parseInt(request.page, 10) || 1));

  // Устойчивый порядок: сначала по дате прохождения, затем по идентификатору.
  // Без него страницы «плавали» бы между запросами и часть сущностей терялась.
  ids.sort((a, b) => {
    const left = selection.attribution.get(a)?.at ?? 0;
    const right = selection.attribution.get(b)?.at ?? 0;
    return left - right || String(a).localeCompare(String(b), 'ru');
  });

  const slicedIds = ids.slice((page - 1) * pageSize, page * pageSize);
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
