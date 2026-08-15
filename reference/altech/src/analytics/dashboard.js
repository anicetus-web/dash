import { RUB } from '../config.js';
import { STAGES, STAGE_BY_ID, STAGE_IDS, PRE_FUNNEL_STAGES, PRE_FUNNEL_STAGE_BY_ID, isSelectableStartStage, canonicalStageId, capReachedIndexByCurrentStage, stageIndex } from '../domain/stages.js';
import { dateOrNull } from '../lib/records.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const QUARTER_MONTHS = 3;
const PERIOD_TYPES = new Set(['day', 'week', 'month', 'quarter', 'year']);

const SALES_DEPARTMENT_MANAGER_IDS = new Set([
  '462',
  '1974',
  '1104',
  '1616',
  '442'
]);

function clampPeriod(from, to, now = new Date()) {
  const fromDate = dateOrNull(`${from}T00:00:00.000Z`) || new Date(now.getFullYear(), now.getMonth(), 1);
  const requestedTo = dateOrNull(`${to}T23:59:59.999Z`) || now;
  const toDate = requestedTo > now ? now : requestedTo;
  return { fromDate, toDate };
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function endOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

function quarterKeyFromDate(date) {
  const quarter = Math.floor(date.getUTCMonth() / QUARTER_MONTHS) + 1;
  return `${date.getUTCFullYear()}-Q${quarter}`;
}

function quarterBounds(quarterKey) {
  const match = /^(\d{4})-Q([1-4])$/.exec(String(quarterKey || ''));
  const now = new Date();
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const quarter = match ? Number(match[2]) : Math.floor(now.getUTCMonth() / QUARTER_MONTHS) + 1;
  const startMonth = (quarter - 1) * QUARTER_MONTHS;
  return {
    key: `${year}-Q${quarter}`,
    fromDate: new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0)),
    toDate: new Date(Date.UTC(year, startMonth + QUARTER_MONTHS, 0, 23, 59, 59, 999))
  };
}

function monthKeyFromDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isoWeekParts(date) {
  const target = startOfUtcDay(date);
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / DAY_MS) + 1) / 7);
  return { year: target.getUTCFullYear(), week };
}

function weekKeyFromDate(date) {
  const { year, week } = isoWeekParts(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function isoWeekStart(year, week) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const day = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  monday.setUTCDate(simple.getUTCDate() - day + 1);
  return startOfUtcDay(monday);
}

function periodKeyFromDate(type, date) {
  if (type === 'day') return date.toISOString().slice(0, 10);
  if (type === 'week') return weekKeyFromDate(date);
  if (type === 'month') return monthKeyFromDate(date);
  if (type === 'year') return String(date.getUTCFullYear());
  return quarterKeyFromDate(date);
}

function boundsForPeriod(type, value, now = new Date()) {
  const periodType = PERIOD_TYPES.has(type) ? type : 'quarter';
  if (periodType === 'day') {
    const base = dateOrNull(`${value}T00:00:00.000Z`) || now;
    return {
      type: periodType,
      key: periodKeyFromDate(periodType, base),
      fromDate: startOfUtcDay(base),
      toDate: endOfUtcDay(base)
    };
  }
  if (periodType === 'week') {
    const match = /^(\d{4})-W(\d{2})$/.exec(String(value || ''));
    const parts = match ? { year: Number(match[1]), week: Number(match[2]) } : isoWeekParts(now);
    const fromDate = isoWeekStart(parts.year, parts.week);
    return {
      type: periodType,
      key: weekKeyFromDate(fromDate),
      fromDate,
      toDate: endOfUtcDay(addDays(fromDate, 6))
    };
  }
  if (periodType === 'month') {
    const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
    const year = match ? Number(match[1]) : now.getUTCFullYear();
    const month = match ? Number(match[2]) - 1 : now.getUTCMonth();
    return {
      type: periodType,
      key: `${year}-${String(month + 1).padStart(2, '0')}`,
      fromDate: new Date(Date.UTC(year, month, 1)),
      toDate: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999))
    };
  }
  if (periodType === 'year') {
    const year = /^\d{4}$/.test(String(value || '')) ? Number(value) : now.getUTCFullYear();
    return {
      type: periodType,
      key: String(year),
      fromDate: new Date(Date.UTC(year, 0, 1)),
      toDate: new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999))
    };
  }
  return { type: periodType, ...quarterBounds(value || quarterKeyFromDate(now)) };
}

function shiftPeriod(period, offset = -1) {
  if (period.type === 'day') return boundsForPeriod('day', periodKeyFromDate('day', addDays(period.fromDate, offset)));
  if (period.type === 'week') return boundsForPeriod('week', weekKeyFromDate(addDays(period.fromDate, offset * 7)));
  if (period.type === 'month') return boundsForPeriod('month', monthKeyFromDate(addMonths(period.fromDate, offset)));
  if (period.type === 'year') return boundsForPeriod('year', String(period.fromDate.getUTCFullYear() + offset));
  return boundsForPeriod('quarter', quarterKeyFromDate(addMonths(period.fromDate, offset * QUARTER_MONTHS)));
}

function previousQuarterKey(quarterKey) {
  const current = quarterBounds(quarterKey);
  const previous = new Date(Date.UTC(current.fromDate.getUTCFullYear(), current.fromDate.getUTCMonth() - QUARTER_MONTHS, 1));
  return quarterKeyFromDate(previous);
}

function periodFromFilters(filters, now) {
  const type = PERIOD_TYPES.has(filters.periodType) ? filters.periodType : 'quarter';
  const value = filters.periodValue || filters.quarter || periodKeyFromDate(type, now);
  if (!filters.from && !filters.to) {
    const bounds = boundsForPeriod(type, value, now);
    return {
      ...bounds,
      toDate: bounds.toDate > now ? now : bounds.toDate
    };
  }
  const period = clampPeriod(filters.from, filters.to, now);
  return {
    type,
    key: periodKeyFromDate(type, period.fromDate),
    ...period
  };
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function addMonths(date, months) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function makeBuckets(period, granularity = 'week') {
  const mode = ['day', 'month', 'week'].includes(granularity) ? granularity : 'week';
  const buckets = [];
  let cursor = startOfUtcDay(period.fromDate);
  const end = period.toDate;
  let index = 0;

  while (cursor <= end) {
    const bucketStart = cursor;
    let next;
    if (mode === 'month') next = addMonths(bucketStart, 1);
    else if (mode === 'day') next = addDays(bucketStart, 1);
    else next = addDays(bucketStart, 7);

    const bucketEnd = new Date(Math.min(next.getTime() - 1, end.getTime()));
    buckets.push({
      index,
      from: bucketStart,
      to: bucketEnd,
      label: mode === 'month'
        ? bucketStart.toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' })
        : mode === 'day'
          ? bucketStart.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
          : `${index + 1} нед`
    });
    index += 1;
    cursor = next;
  }
  return buckets;
}

function defaultGranularity(periodType, requested) {
  if (['day', 'week', 'month'].includes(requested)) return requested;
  if (periodType === 'year') return 'month';
  if (periodType === 'quarter') return 'week';
  if (periodType === 'month') return 'week';
  if (periodType === 'week') return 'day';
  if (periodType === 'day') return 'day';
  return 'week';
}

function bucketIndexForDate(date, buckets) {
  return buckets.findIndex((bucket) => date >= bucket.from && date <= bucket.to);
}

function inPeriod(value, period) {
  const date = dateOrNull(value);
  return Boolean(date && date >= period.fromDate && date <= period.toDate);
}

// Итерация 2 (В2-В4): шесть доп-фильтров по нормализованным полям сделки. Значения берём из УЖЕ
// нормализованных полей (итерация 1 резолвит enum ID→текст, город из address) — НЕ из raw, где enum
// лежат числовыми ID. NOT_SPECIFIED = пустое поле («Не указано»). Многозначные поля (need, projectRole)
// матчатся по «содержит выбранное значение».
export const NOT_SPECIFIED = '__none__';
export const EXTRA_FILTER_KEYS = ['objectType', 'clientType', 'need', 'projectRole', 'city', 'turnover'];

function asValueList(value) {
  if (value === null || value === undefined || value === '') return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim()).filter(Boolean);
}

// Нормализованные значения поля-фильтра сделки (массив строк; пустой = «Не указано»).
export function dealFilterValues(deal, key) {
  return asValueList(deal[key]);
}

// Значения доп-фильтров из входных параметров запроса ('' = фильтр не активен).
export function extraFilterSlice(filters) {
  return Object.fromEntries(EXTRA_FILTER_KEYS.map((key) => [key, filters[key] || '']));
}

export function matchesFilters(deal, filters) {
  if (filters.managerId && String(deal.managerId) !== String(filters.managerId)) return false;
  if (filters.sourceId && String(deal.sourceId) !== String(filters.sourceId)) return false;
  for (const key of EXTRA_FILTER_KEYS) {
    if (!filters[key]) continue;
    const values = dealFilterValues(deal, key);
    if (filters[key] === NOT_SPECIFIED) {
      if (values.length) return false;
    } else if (!values.includes(String(filters[key]))) {
      return false;
    }
  }
  return true;
}

// Город из address-поля бывает мусорным («-», «?», почтовый индекс) — в фильтр берём только строки с буквами.
function isRealCity(value) {
  return /[a-zа-яё]/i.test(value);
}

// Достадийные этапы для селектов «от…»: имя из справочника стадий снапшота (итерация 1: массив {id,name}),
// фолбэк — из реестра PRE_FUNNEL_STAGES.
function preFunnelStagesReference(snapshot) {
  const byId = new Map((snapshot.stages || []).map((stage) => [stage.id, stage.name]));
  return PRE_FUNNEL_STAGES.map((stage) => ({ ...stage, name: byId.get(stage.id) || stage.name }));
}

// Списки доступных значений доп-фильтров (+ «Не указано» последним).
// Enum-поля (objectType/clientType/need/projectRole/turnover) — в КАНОНИЧЕСКОМ порядке справочника
// (dictionaries из итерации 1: оборот идёт по возрастанию сумм, а не по частоте), плюс добор фактических
// значений вне справочника (легаси-ID) по убыванию частоты. Город — свободный текст, по алфавиту.
export function buildFilterReference(deals, dictionaries = {}) {
  const result = {};
  for (const key of EXTRA_FILTER_KEYS) {
    const counts = new Map();
    for (const deal of deals) {
      for (const value of new Set(dealFilterValues(deal, key))) {
        if (key === 'city' && !isRealCity(value)) continue;
        counts.set(value, (counts.get(value) || 0) + 1);
      }
    }
    let names;
    if (key === 'city') {
      names = [...counts.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
    } else {
      const canonical = (dictionaries[key] || []).filter((value) => counts.has(value));
      // Чисто числовые значения enum — нерезолвленные легаси-ID (метки справочника всегда с буквами):
      // прячем из выпадашки, чтобы в «Обороте» не висели «175», «183» и т.п.
      const extra = [...counts.keys()]
        .filter((value) => !canonical.includes(value) && !/^\d+$/.test(value))
        .sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b, 'ru'));
      names = [...canonical, ...extra];
    }
    const rows = names.map((value) => ({ id: value, name: value }));
    rows.push({ id: NOT_SPECIFIED, name: 'Не указано' });
    result[key] = rows;
  }
  return result;
}

function managerName(manager) {
  const raw = manager.raw || {};
  return [raw.lastName || raw.LAST_NAME, raw.name || raw.NAME, raw.secondName || raw.SECOND_NAME]
    .filter(Boolean)
    .join(' ')
    || manager.name
    || `ID ${manager.id}`;
}

function buildManagerReference(deals, managers) {
  const userManagers = new Map((managers || []).map((manager) => [String(manager.id), manager]));
  const dealsByManager = new Map();
  for (const deal of deals) {
    const id = String(deal.managerId || '');
    if (!id) continue;
    dealsByManager.set(id, (dealsByManager.get(id) || 0) + 1);
  }

  const ids = new Set([...SALES_DEPARTMENT_MANAGER_IDS, ...dealsByManager.keys()]);
  return [...ids]
    .map((id) => {
      const userManager = userManagers.get(id);
      const inSalesDepartment = SALES_DEPARTMENT_MANAGER_IDS.has(id);
      return {
        id,
        name: userManager?.demoName || (userManager ? managerName(userManager) : `ID ${id}`),
        inSalesDepartment,
        responsibleDeals: dealsByManager.get(id) || 0,
        raw: userManager?.raw || null
      };
    })
    .sort((a, b) => {
      if (a.inSalesDepartment !== b.inSalesDepartment) return a.inSalesDepartment ? -1 : 1;
      if (a.responsibleDeals !== b.responsibleDeals) return b.responsibleDeals - a.responsibleDeals;
      return a.name.localeCompare(b.name, 'ru');
    });
}

function rubAmount(deal) {
  return String(deal.currency || RUB).toUpperCase() === RUB ? Number(deal.amount || 0) : 0;
}

function eventsByDeal(stageEvents) {
  const map = new Map();
  for (const event of stageEvents) {
    const stageId = canonicalStageId(event.stageId);
    // Впускаем события воронки И достадийного «Заявки маркетинг» (для конверсии/цикла «от NEW», итерация 8).
    // NEW имеет stageIndex === -1, поэтому в математику воронки не вмешивается (отсекается reached<0).
    if (!STAGE_BY_ID.has(stageId) && !PRE_FUNNEL_STAGE_BY_ID.has(stageId)) continue;
    if (!map.has(event.dealId)) map.set(event.dealId, []);
    map.get(event.dealId).push({ ...event, stageId });
  }
  for (const rows of map.values()) {
    rows.sort((a, b) => (dateOrNull(a.createdAt)?.getTime() || 0) - (dateOrNull(b.createdAt)?.getTime() || 0));
  }
  return map;
}

function reachedIndexFromEvents(events, currentStageId) {
  const maxEventIndex = Math.max(...events.map((event) => stageIndex(event.stageId)), -1);
  if (maxEventIndex < 0) return -1;
  return capReachedIndexByCurrentStage(maxEventIndex, currentStageId);
}

function uniqueDealsForStage(events, targetStageId, period, allowedDealIds) {
  const ids = new Set();
  const canonicalTargetStageId = canonicalStageId(targetStageId);
  for (const event of events) {
    if (canonicalStageId(event.stageId) !== canonicalTargetStageId) continue;
    if (!allowedDealIds.has(event.dealId)) continue;
    if (!inPeriod(event.createdAt, period)) continue;
    ids.add(event.dealId);
  }
  return ids;
}

function buildFunnelFromCounts(counts) {
  return STAGES.map((stage) => {
    const previous = stage.index === 0 ? counts[0] : counts[stage.index - 1];
    return {
      ...stage,
      count: counts[stage.index],
      conversion: stage.index === 0 ? 100 : previous ? Math.round((counts[stage.index] / previous) * 1000) / 10 : 0,
      previousCount: stage.index === 0 ? null : previous
    };
  });
}

function addRangeToSets(sets, dealId, fromIndex, toIndex) {
  const start = Math.max(0, fromIndex);
  const end = Math.min(sets.length - 1, toIndex);
  if (end < start) return;
  for (let index = start; index <= end; index += 1) sets[index].add(dealId);
}

function staticFunnelSets(deals, stageEvents, period, filters) {
  const byDeal = eventsByDeal(stageEvents);
  const cohort = uniqueDealsForStage(
    stageEvents,
    STAGE_IDS.preparation,
    period,
    new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id))
  );
  const countSets = STAGES.map(() => new Set());

  for (const deal of deals) {
    if (!cohort.has(deal.id)) continue;
    const reached = reachedIndexFromEvents(byDeal.get(deal.id) || [], deal.stageId);
    if (reached < 0) continue;
    addRangeToSets(countSets, deal.id, 0, reached);
  }

  return { countSets, cohort };
}

function previousStageIndex(events, eventIndex) {
  for (let index = eventIndex - 1; index >= 0; index -= 1) {
    const previous = stageIndex(events[index].stageId);
    if (previous >= 0) return previous;
  }
  return -1;
}

// Наборы сделок по ступеням (динамический режим) — единый отбор для воронки и drill-down (итерация 9).
function dynamicFunnelSets(deals, stageEvents, period, filters) {
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const allowedDealIds = new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id));
  const byDeal = eventsByDeal(stageEvents);
  const { countSets, cohort } = staticFunnelSets(deals, stageEvents, period, filters);

  for (const [dealId, events] of byDeal.entries()) {
    if (!allowedDealIds.has(dealId)) continue;
    if (cohort.has(dealId)) continue;
    const deal = dealById.get(dealId);
    if (!deal) continue;

    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      if (!inPeriod(event.createdAt, period)) continue;
      const reached = capReachedIndexByCurrentStage(stageIndex(event.stageId), deal.stageId);
      if (reached <= 0) continue;
      const previous = previousStageIndex(events, eventIndex);
      const start = Math.max(1, previous >= 0 ? previous : reached);
      if (reached < start) continue;
      addRangeToSets(countSets, dealId, start, reached);
    }
  }

  return countSets;
}

function dynamicFunnel(deals, stageEvents, period, filters) {
  return buildFunnelFromCounts(dynamicFunnelSets(deals, stageEvents, period, filters).map((ids) => ids.size));
}

function staticFunnel(deals, stageEvents, period, filters) {
  const { countSets } = staticFunnelSets(deals, stageEvents, period, filters);
  return buildFunnelFromCounts(countSets.map((ids) => ids.size));
}

// Год заключения договора: нормализованное поле (итерация 1); фолбэк на raw для ещё не пересинканного кэша.
const CONTRACT_YEAR_FIELD = 'ufCrm_1770125160081';
export function dealContractYear(deal) {
  if (deal.contractYear !== undefined) return deal.contractYear;
  const value = String(deal.raw?.[CONTRACT_YEAR_FIELD] || '').trim();
  return /^\d{4}$/.test(value) ? Number(value) : null;
}

// Годы, покрываемые периодом (обычно один; неделя/произвольный период могут пересекать границу года).
function periodYears(period) {
  const years = new Set();
  const from = period.fromDate?.getUTCFullYear?.();
  const to = period.toDate?.getUTCFullYear?.();
  if (from === undefined || to === undefined) return years;
  for (let year = from; year <= to; year += 1) years.add(year);
  return years;
}

// Отбор договоров периода (В6 + уточнение пользователя 07.07): договор = сделка с ТЕКУЩЕЙ стадией «Договор
// подписан» (LOSE и «в работе» НЕ считаем, даже если год проставлен). Принадлежность периоду: поле «Год
// заключения» приоритетно — годовой срез включает сделку по совпадению года (даже без события истории,
// т.к. история старых сделок неполна); срез мельче года использует поле как «ворота» по году, а дату внутри
// года берёт из события «Договор подписан». Пустое поле — фолбэк на событие в периоде (прежнее поведение).
export function contractDealsInPeriod(deals, stageEvents, period, filters) {
  const allowedDealIds = new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id));
  const byEvent = uniqueDealsForStage(stageEvents, STAGE_IDS.contractSigned, period, allowedDealIds);
  const years = periodYears(period);
  const result = [];
  for (const deal of deals) {
    if (!allowedDealIds.has(deal.id)) continue;
    if (canonicalStageId(deal.stageId) !== STAGE_IDS.contractSigned) continue;
    const year = dealContractYear(deal);
    if (year !== null) {
      if (!years.has(year)) continue;
      if (period.type === 'year' || byEvent.has(deal.id)) result.push(deal);
      continue;
    }
    if (byEvent.has(deal.id)) result.push(deal);
  }
  return result;
}

function stageMovementSetsByBucket(deals, stageEvents, period, filters, buckets) {
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const allowedDealIds = new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id));
  const byDeal = eventsByDeal(stageEvents);
  const bucketSets = buckets.map(() => STAGES.map(() => new Set()));

  for (const [dealId, events] of byDeal.entries()) {
    if (!allowedDealIds.has(dealId)) continue;
    const deal = dealById.get(dealId);
    if (!deal) continue;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex];
      const date = dateOrNull(event.createdAt);
      if (!date || date < period.fromDate || date > period.toDate) continue;
      const bucketIndex = bucketIndexForDate(date, buckets);
      if (bucketIndex < 0) continue;
      const reached = capReachedIndexByCurrentStage(stageIndex(event.stageId), deal.stageId);
      if (reached < 0) continue;
      const previous = previousStageIndex(events, eventIndex);
      const start = canonicalStageId(event.stageId) === STAGE_IDS.preparation
        ? 0
        : Math.max(1, previous >= 0 ? previous : reached);
      addRangeToSets(bucketSets[bucketIndex], dealId, start, reached);
    }
  }

  return bucketSets;
}

function stageTrend(deals, stageEvents, period, filters, granularity, stageId) {
  const buckets = makeBuckets(period, granularity);
  const bucketSets = stageMovementSetsByBucket(deals, stageEvents, period, filters, buckets);
  const targetIndex = stageIndex(stageId);
  return buckets.map((bucket, index) => ({
    label: bucket.label,
    value: targetIndex >= 0 ? bucketSets[index][targetIndex].size : 0
  }));
}

function revenueTrend(deals, stageEvents, period, filters, granularity) {
  const buckets = makeBuckets(period, granularity);
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const allowedDealIds = new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id));
  const byDeal = eventsByDeal(stageEvents);
  const totals = buckets.map(() => ({ value: 0, count: 0 }));
  const years = periodYears(period);

  for (const [dealId, events] of byDeal.entries()) {
    if (!allowedDealIds.has(dealId)) continue;
    const deal = dealById.get(dealId);
    if (!deal) continue;
    // Год-гейт (В6) + текущая-стадия-гейт: график выручки согласован с KPI договоров периода.
    if (canonicalStageId(deal.stageId) !== STAGE_IDS.contractSigned) continue;
    const fieldYear = dealContractYear(deal);
    if (fieldYear !== null && !years.has(fieldYear)) continue;
    const date = firstEventDateInPeriod(events, STAGE_IDS.contractSigned, period);
    if (!date) continue;
    const bucketIndex = bucketIndexForDate(date, buckets);
    if (bucketIndex < 0) continue;
    const amount = rubAmount(deal);
    if (amount <= 0) continue;
    totals[bucketIndex].value += amount;
    totals[bucketIndex].count += 1;
  }

  return buckets.map((bucket, index) => ({
    label: bucket.label,
    value: Math.round(totals[index].value),
    count: totals[index].count
  }));
}

function trendForStage(deals, stageEvents, period, filters, granularity, stageId) {
  return canonicalStageId(stageId) === STAGE_IDS.contractSigned
    ? revenueTrend(deals, stageEvents, period, filters, granularity)
    : stageTrend(deals, stageEvents, period, filters, granularity, stageId);
}

function compareTrend(current, previous) {
  const size = Math.max(current.length, previous.length);
  return Array.from({ length: size }, (_, index) => ({
    label: current[index]?.label || previous[index]?.label || `${index + 1}`,
    current: current[index]?.value || 0,
    previous: previous[index]?.value || 0,
    count: current[index]?.count || 0
  }));
}

function sumDeals(deals) {
  return Math.round(deals.reduce((sum, deal) => sum + rubAmount(deal), 0));
}

// Медиана массива чисел: пусто → 0, чётное число элементов → среднее двух центральных (округляем до рубля).
function medianValue(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw);
}

// Относительная дельта к предыдущему периоду, %: нет базы (0 или не число) → null (бейдж не показываем).
function percentDelta(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return Math.round(((Number(current) || 0) - previous) / previous * 1000) / 10;
}

function moneyMetric(deals) {
  const positive = deals.filter((deal) => rubAmount(deal) > 0);
  const value = sumDeals(positive);

  return {
    value,
    median: medianValue(positive.map((deal) => rubAmount(deal))),
    count: positive.length,
    available: positive.length > 0
  };
}

function workRevenueMetric(deals, filters) {
  const workStageIds = new Set([STAGE_IDS.meetingDone, STAGE_IDS.requisites]);
  return moneyMetric(deals.filter((deal) => (
    matchesFilters(deal, filters)
    && workStageIds.has(canonicalStageId(deal.stageId))
  )));
}

// Конверсия между двумя произвольными этапами: доля дошедших до toStage среди вошедших в fromStage.
function stageConversion(deals, stageEvents, fromStageId, toStageId, period, filters) {
  const byDeal = eventsByDeal(stageEvents);
  const cohortIds = uniqueDealsForStage(
    stageEvents,
    fromStageId,
    period,
    new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id))
  );
  const toIndex = stageIndex(toStageId);
  let reached = 0;
  for (const deal of deals) {
    if (!cohortIds.has(deal.id)) continue;
    const reachedIndex = reachedIndexFromEvents(byDeal.get(deal.id) || [], deal.stageId);
    if (reachedIndex >= toIndex) reached += 1;
  }
  return {
    value: cohortIds.size ? Math.round((reached / cohortIds.size) * 1000) / 10 : 0,
    count: reached,
    base: cohortIds.size,
    fromStageId: canonicalStageId(fromStageId),
    toStageId: canonicalStageId(toStageId),
    available: cohortIds.size > 0
  };
}

function funnelTotalConversion(funnel) {
  const base = funnel[0]?.count || 0;
  const count = funnel[funnel.length - 1]?.count || 0;
  return {
    value: base ? Math.round((count / base) * 1000) / 10 : 0,
    count,
    base,
    available: base > 0
  };
}

function firstEventDate(events, stageId) {
  const canonicalTargetStageId = canonicalStageId(stageId);
  for (const event of events) {
    if (canonicalStageId(event.stageId) !== canonicalTargetStageId) continue;
    const date = dateOrNull(event.createdAt);
    if (date) return date;
  }
  return null;
}

function firstEventDateInPeriod(events, stageId, period) {
  const canonicalTargetStageId = canonicalStageId(stageId);
  for (const event of events) {
    if (canonicalStageId(event.stageId) !== canonicalTargetStageId) continue;
    const date = dateOrNull(event.createdAt);
    if (date && date >= period.fromDate && date <= period.toDate) return date;
  }
  return null;
}

// Цикл сделки: средние дни от перехода на выбранный стартовый этап до «Договор подписан» (финал фиксирован).
// Считаем только сделки, реально дошедшие до старт-этапа и закрытые договором в периоде; без отката на дату создания.
function dealCycle(deals, stageEvents, period, filters, startStageId = STAGE_IDS.preparation) {
  const byDeal = eventsByDeal(stageEvents);
  const contractDeals = contractDealsInPeriod(deals, stageEvents, period, filters)
    .filter((deal) => rubAmount(deal) > 0);
  const cycles = [];
  for (const deal of contractDeals) {
    const events = byDeal.get(deal.id) || [];
    const contractDate = firstEventDateInPeriod(events, STAGE_IDS.contractSigned, period);
    if (!contractDate) continue;
    const startDate = firstEventDate(events, startStageId);
    if (!startDate) continue;
    const boundedStart = startDate > contractDate ? contractDate : startDate;
    cycles.push((contractDate.getTime() - boundedStart.getTime()) / DAY_MS);
  }
  return {
    value: cycles.length ? Math.round((cycles.reduce((sum, item) => sum + item, 0) / cycles.length) * 10) / 10 : 0,
    count: cycles.length,
    startStageId: canonicalStageId(startStageId),
    available: cycles.length > 0
  };
}

function sourceName(sourceId, sources) {
  return sources.find((source) => String(source.id) === String(sourceId))?.name || sourceId || 'Без источника';
}

function revenueBySources(contractDeals, sources) {
  const map = new Map();
  for (const deal of contractDeals) {
    const amount = rubAmount(deal);
    if (amount <= 0) continue;
    const key = String(deal.sourceId || 'unknown');
    const row = map.get(key) || { id: key, name: sourceName(key, sources), revenue: 0, count: 0 };
    row.revenue += amount;
    row.count += 1;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.revenue - a.revenue);
}

function sourcePaymentShare(contractDeals, sources) {
  // В11: база — сортировка по выручке (revenueBySources уже отсортирован), топ-7 + «Прочие» считаются
  // ОДИН раз → состав и порядок строк не зависят от режима тумблера «Сумма | Кол-во» (ничего не «прыгает»).
  const rows = revenueBySources(contractDeals, sources);
  const totalCount = rows.reduce((sum, row) => sum + row.count, 0);
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const top = rows.slice(0, 7);
  const rest = rows.slice(7);
  if (rest.length) {
    top.push({
      id: 'other',
      name: 'Прочие',
      revenue: rest.reduce((sum, row) => sum + row.revenue, 0),
      count: rest.reduce((sum, row) => sum + row.count, 0)
    });
  }
  return top.map((row) => {
    const percentByCount = totalCount ? Math.round((row.count / totalCount) * 1000) / 10 : 0;
    const percentByRevenue = totalRevenue ? Math.round((row.revenue / totalRevenue) * 1000) / 10 : 0;
    // percent — алиас percentByCount для обратной совместимости (check-analytics, старый фронт на раскатке)
    return { ...row, percent: percentByCount, percentByCount, percentByRevenue };
  });
}

function dealClosedDate(deal) {
  return dateOrNull(deal.closedAt || deal.raw?.closedAt || deal.raw?.CLOSEDATE || deal.raw?.closedate || deal.updatedAt);
}

function isLostStage(stageId) {
  return String(stageId || '').toUpperCase().includes('LOSE');
}

function lostDealIdsInPeriod(deals, stageEvents, period, filters) {
  const allowedDealIds = new Set(deals.filter((deal) => matchesFilters(deal, filters)).map((deal) => deal.id));
  const ids = new Set();
  for (const event of stageEvents) {
    if (!isLostStage(event.stageId)) continue;
    if (!allowedDealIds.has(event.dealId)) continue;
    if (inPeriod(event.createdAt, period)) ids.add(event.dealId);
  }
  for (const deal of deals) {
    if (!allowedDealIds.has(deal.id)) continue;
    if (!isLostStage(deal.stageId)) continue;
    const closedAt = dealClosedDate(deal);
    if (closedAt && closedAt >= period.fromDate && closedAt <= period.toDate) ids.add(deal.id);
  }
  return ids;
}

function failureReasonOf(deal) {
  const fromDeal = String(deal.failureReason || '').trim();
  if (fromDeal) return fromDeal;
  const raw = deal.raw || {};
  const candidates = [
    raw.failureReason,
    raw.FAILURE_REASON,
    raw.lossReason,
    raw.LOSS_REASON,
    raw.ufCrmFailureReason,
    raw.UF_CRM_FAILURE_REASON
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return candidates[0] || 'Не указана';
}

// В10: отказ учитывается только если сделка дошла до «Выявлена потребность» (index 2+).
const NEED_STAGE_INDEX = stageIndex('C78:PREPAYMENT_INVOIC');

// В10: фиксированный список «мусорных» причин → всегда сворачиваются в «Прочие» (не топ-7).
// Строки точные, как в данных Битрикса. «Узкая специализация…» в справочнике с ОДНОЙ закрывающей
// скобкой (опечатка) — держим оба варианта на случай исправления.
export const OTHER_FAILURE_REASONS = new Set([
  'Не связан с проектированием',
  'Реклама/СПАМ',
  'Узкая специализация (узкая ниша (разделы, типы объектов)',
  'Узкая специализация (узкая ниша (разделы, типы объектов))',
  'Не вышел на ЛПР (Начало воронки)',
  'Дубликат'
]);

// Карта dealId → максимальный достигнутый индекс этапа (вся история + текущая стадия).
// Строится один раз на сборку; сам предикат — O(1) на сделку. LOSE/NEW дают -1 (не поднимают индекс).
export function makeReachedStage(deals, stageEvents) {
  const reached = new Map();
  const bump = (dealId, index) => {
    if (index < 0) return;
    const prev = reached.get(dealId);
    if (prev === undefined || index > prev) reached.set(dealId, index);
  };
  for (const event of stageEvents) bump(event.dealId, stageIndex(event.stageId));
  for (const deal of deals) bump(deal.id, stageIndex(deal.stageId));
  return (dealId, minIndex) => (reached.get(dealId) ?? -1) >= minIndex;
}

function failureReasons(deals, stageEvents, period, filters, reachedStage) {
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const map = new Map();
  let otherCount = 0;
  for (const id of lostDealIdsInPeriod(deals, stageEvents, period, filters)) {
    if (!reachedStage(id, NEED_STAGE_INDEX)) continue; // В10: не дошла до «Выявлена потребность»
    const deal = dealById.get(id);
    if (!deal) continue;
    const reason = failureReasonOf(deal);
    if (OTHER_FAILURE_REASONS.has(reason)) {
      otherCount += 1;
      continue;
    }
    const row = map.get(reason) || { id: reason, name: reason, count: 0 };
    row.count += 1;
    map.set(reason, row);
  }
  // В10: явные причины — ВСЕ строки без обрезания топ-7; «Прочие» — только фиксированный список.
  const rows = [...map.values()].sort((a, b) => b.count - a.count);
  if (otherCount) rows.push({ id: 'other', name: 'Прочие', count: otherCount });
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return rows.map((row) => ({
    ...row,
    percent: total ? Math.round((row.count / total) * 1000) / 10 : 0
  }));
}

// ——— Динамика метрик за последние N периодов (этапы 2–5) ———
const TREND_POINTS = 5;

function periodTrendLabel(period) {
  const date = period.fromDate;
  const yy = String(date.getUTCFullYear()).slice(2);
  if (period.type === 'quarter') return `${period.key.split('-Q')[1]}кв'${yy}`;
  if (period.type === 'month') return `${date.toLocaleDateString('ru-RU', { month: 'short', timeZone: 'UTC' }).replace('.', '')} ${yy}`;
  if (period.type === 'year') return period.key;
  if (period.type === 'week') return period.key.replace('-', ' ');
  return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
}

// Последние N периодов того же типа, заканчивая текущим (старые → новые).
function lastPeriods(current, count = TREND_POINTS) {
  const out = [current];
  let period = current;
  for (let i = 1; i < count; i += 1) {
    period = shiftPeriod(period, -1);
    out.unshift(period);
  }
  return out;
}

// Самая ранняя дата данных — чтобы для года/квартала рисовать только периоды, по которым есть данные.
function snapshotMinDate(deals, stageEvents) {
  let min = null;
  const consider = (value) => { const date = dateOrNull(value); if (date && (!min || date < min)) min = date; };
  for (const event of stageEvents) consider(event.createdAt);
  for (const deal of deals) consider(deal.createdAt);
  return min;
}

function metricTrend(current, minDate, valueFn, count = TREND_POINTS) {
  return lastPeriods(current, count)
    .filter((period) => !minDate || period.toDate >= minDate)
    .map((period) => ({ key: period.key, label: periodTrendLabel(period), value: valueFn(period) }));
}

// Динамика топ-причин отказов за последние N периодов: единый набор причин (топ по сумме) на всех точках.
function failureReasonsTrend(deals, stageEvents, current, filters, minDate, reachedStage, topN = 4) {
  const periods = lastPeriods(current).filter((period) => !minDate || period.toDate >= minDate);
  const dealById = new Map(deals.map((deal) => [deal.id, deal]));
  const perPeriod = periods.map((period) => {
    const counts = new Map();
    for (const id of lostDealIdsInPeriod(deals, stageEvents, period, filters)) {
      if (!reachedStage(id, NEED_STAGE_INDEX)) continue; // В10: тот же фильтр «Выявлена потребность»
      const deal = dealById.get(id);
      if (!deal) continue;
      const reason = failureReasonOf(deal);
      counts.set(reason, (counts.get(reason) || 0) + 1);
    }
    return { label: periodTrendLabel(period), counts };
  });
  const totals = new Map();
  for (const point of perPeriod) {
    for (const [reason, count] of point.counts) totals.set(reason, (totals.get(reason) || 0) + count);
  }
  // Тренд — топ-4 из ЯВНЫХ причин; фиксированные «Прочие» в серии не показываем.
  const topReasons = [...totals.entries()]
    .filter(([reason]) => !OTHER_FAILURE_REASONS.has(reason))
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([reason]) => reason);
  return {
    labels: perPeriod.map((point) => point.label),
    series: topReasons.map((reason) => ({
      name: reason,
      values: perPeriod.map((point) => point.counts.get(reason) || 0)
    }))
  };
}

// Динамика топ-источников оплат за последние N периодов: метрика — число подписанных договоров по источнику.
function sourcesTrend(deals, stageEvents, sources, current, filters, minDate, topN = 4) {
  const periods = lastPeriods(current).filter((period) => !minDate || period.toDate >= minDate);
  const perPeriod = periods.map((period) => {
    const counts = new Map();
    for (const deal of contractDealsInPeriod(deals, stageEvents, period, filters)) {
      if (rubAmount(deal) <= 0) continue;
      const key = String(deal.sourceId || 'unknown');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return { label: periodTrendLabel(period), counts };
  });
  const totals = new Map();
  for (const point of perPeriod) {
    for (const [id, count] of point.counts) totals.set(id, (totals.get(id) || 0) + count);
  }
  const topIds = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([id]) => id);
  return {
    labels: perPeriod.map((point) => point.label),
    series: topIds.map((id) => ({
      id,
      name: sourceName(id, sources),
      values: perPeriod.map((point) => point.counts.get(id) || 0)
    }))
  };
}

// Этапы конверсии из настроек: [from, to], по умолчанию «Взят в работу» → «Договор подписан».
// «from» может быть достадийным («Заявки маркетинг», В7), «to» — только этап воронки. Валидация
// позиционная: невалидный from не сдвигает to (в отличие от прежнего filter+compact).
function normalizeConversionStages(value) {
  const raw = Array.isArray(value) ? value.map(canonicalStageId) : [];
  const from = raw[0] && isSelectableStartStage(raw[0]) ? raw[0] : STAGE_IDS.preparation;
  const to = raw[1] && STAGE_BY_ID.has(raw[1]) ? raw[1] : STAGE_IDS.contractSigned;
  return [from, to];
}

function planMetric(deals, stageEvents, period, filters, managerPlans, managers) {
  const contractDeals = contractDealsInPeriod(deals, stageEvents, period, filters);
  const fact = sumDeals(contractDeals);
  const selectedManagerId = filters.managerId || '';
  const plan = selectedManagerId
    ? Number(managerPlans[selectedManagerId] || 0)
    : managers.reduce((sum, manager) => sum + Number(managerPlans[manager.id] || 0), 0);
  return {
    plan,
    fact,
    remaining: Math.max(0, plan - fact),
    progress: plan ? Math.min(999, Math.round((fact / plan) * 1000) / 10) : 0,
    available: plan > 0
  };
}

function managerPlanRows(deals, stageEvents, period, filters, managerPlans, managers, convFrom, convTo, convForIds) {
  // Конверсию по сотруднику считаем лениво — только для выбранных в карточки id (их максимум 12),
  // иначе лишний проход stageConversion по всем десяткам менеджеров на каждый запрос дашборда.
  const wanted = convForIds instanceof Set ? convForIds : new Set();
  return managers.map((manager) => {
    const managerFilters = { ...filters, managerId: manager.id };
    const contractDeals = contractDealsInPeriod(deals, stageEvents, period, managerFilters);
    const fact = sumDeals(contractDeals);
    const money = moneyMetric(contractDeals);
    const avgCheck = money.count ? Math.round(money.value / money.count) : 0;
    // В8: «в работе» — открытые сделки этапов 3..6 по текущей стадии (без учёта периода, как workRevenueMetric).
    const inWork = inWorkDeals(deals, managerFilters);
    const plan = Number(managerPlans[manager.id] || 0);
    const conv = wanted.has(String(manager.id))
      ? stageConversion(deals, stageEvents, convFrom, convTo, period, managerFilters)
      : { value: 0, count: 0, base: 0 };
    return {
      id: manager.id,
      name: manager.name,
      inSalesDepartment: manager.inSalesDepartment,
      responsibleDeals: manager.responsibleDeals,
      plan,
      fact,
      remaining: Math.max(0, plan - fact),
      progress: plan ? Math.min(999, Math.round((fact / plan) * 1000) / 10) : 0,
      conversion: conv.value,
      conversionCount: conv.count,
      conversionBase: conv.base,
      avgCheck,
      avgContractCount: money.count,
      inWorkAmount: sumDeals(inWork),
      inWorkCount: inWork.length
    };
  });
}

export function buildDashboardFromCache(snapshot, filters, options = {}) {
  const now = options.now || new Date();
  const mode = filters.mode === 'static' ? 'static' : 'dynamic';
  const period = periodFromFilters(filters, now);
  const planQuarter = quarterKeyFromDate(period.fromDate);
  const granularity = defaultGranularity(period.type, filters.granularity);
  const dashboardFilters = {
    from: period.fromDate.toISOString().slice(0, 10),
    to: period.toDate.toISOString().slice(0, 10),
    periodType: period.type,
    periodValue: period.key,
    quarter: planQuarter,
    granularity,
    managerId: filters.managerId || '',
    sourceId: filters.sourceId || '',
    ...extraFilterSlice(filters),
    mode
  };

  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const funnel = mode === 'static'
    ? staticFunnel(deals, stageEvents, period, dashboardFilters)
    : dynamicFunnel(deals, stageEvents, period, dashboardFilters);

  const contractDeals = contractDealsInPeriod(deals, stageEvents, period, dashboardFilters);
  const workRevenue = workRevenueMetric(deals, dashboardFilters);
  const contractMoney = moneyMetric(contractDeals);
  const historySync = snapshot.historySync || {};
  const conversion = funnelTotalConversion(funnel);
  const previousPeriod = shiftPeriod(period, -1);
  const managerPlans = options.plans?.managerPlans || {};
  const settings = options.settings || {};
  const stageCharts = (settings.stageCharts?.length ? settings.stageCharts : ['C78:EXECUTING', STAGE_IDS.requisites])
    .map(canonicalStageId)
    .slice(0, 2);
  const salesPlan = planMetric(deals, stageEvents, period, dashboardFilters, managerPlans, managers);
  const trendFilters = dashboardFilters;

  // Настраиваемые этапы конверсии/цикла + динамика метрик за последние 5 периодов (этапы 2–5).
  const minDate = snapshotMinDate(deals, stageEvents);
  const reachedStage = makeReachedStage(deals, stageEvents); // В10: предикат «дошла до этапа», строится 1 раз
  const [convFrom, convTo] = normalizeConversionStages(settings.conversionStages);
  const cycleStart = canonicalStageId(settings.cycleStartStage && isSelectableStartStage(settings.cycleStartStage)
    ? settings.cycleStartStage
    : STAGE_IDS.preparation);
  const conversionKpi = stageConversion(deals, stageEvents, convFrom, convTo, period, dashboardFilters);
  const dealCycleKpi = dealCycle(deals, stageEvents, period, dashboardFilters, cycleStart);
  // В9: те же метрики за предыдущий период → дельты на KPI-карточках (тот же отбор договоров, что и «Факт»).
  const prevContractMoney = moneyMetric(contractDealsInPeriod(deals, stageEvents, previousPeriod, dashboardFilters));
  const prevConversion = stageConversion(deals, stageEvents, convFrom, convTo, previousPeriod, dashboardFilters);
  const prevDealCycle = dealCycle(deals, stageEvents, previousPeriod, dashboardFilters, cycleStart);
  // В13: тренд-спарклайн среднего чека считаем по МЕДИАНЕ (крупная цифра карточки).
  const averageCheckTrend = metricTrend(period, minDate, (p) => (
    moneyMetric(contractDealsInPeriod(deals, stageEvents, p, dashboardFilters)).median
  ));
  // Тумблер медиана/среднее: тренд по среднему арифметическому (сумма ÷ количество договоров).
  const averageCheckMeanTrend = metricTrend(period, minDate, (p) => {
    const m = moneyMetric(contractDealsInPeriod(deals, stageEvents, p, dashboardFilters));
    return m.count ? Math.round(m.value / m.count) : 0;
  });
  const conversionTrend = metricTrend(period, minDate, (p) => stageConversion(deals, stageEvents, convFrom, convTo, p, dashboardFilters).value);
  const dealCycleTrend = metricTrend(period, minDate, (p) => dealCycle(deals, stageEvents, p, dashboardFilters, cycleStart).value);
  const failureReasonsDynamics = failureReasonsTrend(deals, stageEvents, period, dashboardFilters, minDate, reachedStage);
  const sourcesDynamics = sourcesTrend(deals, stageEvents, sources, period, dashboardFilters, minDate);
  const customStageTrends = stageCharts.map((stageId) => {
    const stage = STAGE_BY_ID.get(canonicalStageId(stageId));
    return {
      stageId: stage?.id || stageId,
      name: stage?.name || stageId,
      metric: canonicalStageId(stageId) === STAGE_IDS.contractSigned ? 'money' : 'count',
      rows: compareTrend(
        trendForStage(deals, stageEvents, period, trendFilters, granularity, stageId),
        trendForStage(deals, stageEvents, previousPeriod, trendFilters, granularity, stageId)
      )
    };
  });

  return {
    reference: {
      managers,
      sources,
      stages: STAGES,
      preFunnelStages: preFunnelStagesReference(snapshot),
      filterOptions: buildFilterReference(deals, snapshot.enumDictionaries)
    },
    filters: dashboardFilters,
    freshness: {
      lastSyncAt: snapshot.sync?.lastSuccessAt || snapshot.updatedAt || null,
      cacheUpdatedAt: snapshot.updatedAt || null,
      historySync: {
        complete: Boolean(historySync.complete),
        syncedDeals: historySync.syncedDealIds?.length || 0,
        lastBatchAt: historySync.lastBatchAt || null
      }
    },
    totals: {
      deals: deals.length,
      stageEvents: stageEvents.length,
      managers: managers.length,
      sources: sources.length
    },
    kpis: {
      potential: workRevenue,
      workRevenue,
      contractSigned: { ...contractMoney, delta: percentDelta(contractMoney.value, prevContractMoney.value) },
      advanceReceived: contractMoney,
      averageCheck: {
        value: contractMoney.count ? Math.round(contractMoney.value / contractMoney.count) : 0,
        median: contractMoney.median,
        count: contractMoney.count,
        available: contractMoney.count > 0,
        delta: percentDelta(contractMoney.median, prevContractMoney.median),
        trend: averageCheckTrend,
        meanDelta: percentDelta(
          contractMoney.count ? Math.round(contractMoney.value / contractMoney.count) : 0,
          prevContractMoney.count ? Math.round(prevContractMoney.value / prevContractMoney.count) : 0
        ),
        meanTrend: averageCheckMeanTrend
      },
      advanceConversion: conversion,
      contractConversion: { ...conversionKpi, delta: percentDelta(conversionKpi.value, prevConversion.value), trend: conversionTrend },
      dealCycle: { ...dealCycleKpi, delta: percentDelta(dealCycleKpi.value, prevDealCycle.value), trend: dealCycleTrend }
    },
    quarter: {
      key: planQuarter,
      previousKey: previousQuarterKey(planQuarter),
      granularity
    },
    period: {
      type: period.type,
      key: period.key,
      previousKey: previousPeriod.key,
      from: dashboardFilters.from,
      to: dashboardFilters.to,
      granularity
    },
    salesPlan,
    managerPlanRows: managerPlanRows(deals, stageEvents, period, dashboardFilters, managerPlans, managers, convFrom, convTo, new Set((settings.employeeCards || []).map(String))),
    trends: {
      revenue: compareTrend(
        revenueTrend(deals, stageEvents, period, trendFilters, granularity),
        revenueTrend(deals, stageEvents, previousPeriod, trendFilters, granularity)
      ),
      preparation: compareTrend(
        stageTrend(deals, stageEvents, period, trendFilters, granularity, STAGE_IDS.preparation),
        stageTrend(deals, stageEvents, previousPeriod, trendFilters, granularity, STAGE_IDS.preparation)
      ),
      inputs: compareTrend(
        stageTrend(deals, stageEvents, period, trendFilters, granularity, 'C78:EXECUTING'),
        stageTrend(deals, stageEvents, previousPeriod, trendFilters, granularity, 'C78:EXECUTING')
      ),
      requisites: compareTrend(
        stageTrend(deals, stageEvents, period, trendFilters, granularity, STAGE_IDS.requisites),
        stageTrend(deals, stageEvents, previousPeriod, trendFilters, granularity, STAGE_IDS.requisites)
      ),
      custom: customStageTrends
    },
    funnel,
    revenueBySources: revenueBySources(contractDeals, sources),
    sourcePaymentShare: sourcePaymentShare(contractDeals, sources),
    sourcesTrend: sourcesDynamics,
    failureReasons: failureReasons(deals, stageEvents, period, dashboardFilters, reachedStage),
    failureReasonsTrend: failureReasonsDynamics,
    settings: {
      stageCharts,
      conversionStages: [convFrom, convTo],
      cycleStartStage: cycleStart,
      employeeCards: settings.employeeCards || []
    },
    warnings: snapshot.sync?.warnings || []
  };
}

// Список подписанных договоров периода (формируют факт выручки) — для модалки по клику на факт.
export function periodContractDeals(snapshot, filters, options = {}) {
  const now = options.now || new Date();
  const period = periodFromFilters(filters, now);
  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const dashboardFilters = {
    managerId: filters.managerId || '',
    sourceId: filters.sourceId || '',
    ...extraFilterSlice(filters),
    mode: filters.mode === 'static' ? 'static' : 'dynamic'
  };
  return contractDealsInPeriod(deals, stageEvents, period, dashboardFilters)
    .filter((deal) => rubAmount(deal) > 0)
    .sort((a, b) => rubAmount(b) - rubAmount(a))
    .map((deal) => ({
      id: deal.id,
      company: deal.title || `Сделка ${deal.id}`,
      clientType: deal.clientType || '',
      amount: rubAmount(deal)
    }));
}

// В8: «в работе» — открытые сделки на этапах «Получены исходники»…«Реквизиты получены» (индексы 3..6).
// LOSE-стадии и подписанные отсекаются самим диапазоном (stageIndex у них -1 или 7).
export function inWorkDeals(deals, filters) {
  return deals.filter((deal) => {
    if (!matchesFilters(deal, filters)) return false;
    const index = stageIndex(deal.stageId);
    return index >= 3 && index <= 6;
  });
}

// Лимит строк drill-down: защита ответа от гигантских срезов (год, ступень 0).
const SLICE_LIMIT = 500;

// В5: сделки среза для универсальной модалки. КРИТИЧНО: каждый срез использует ту же функцию отбора,
// что и агрегат виджета — число в модалке = числу на виджете. null для неизвестного среза (сервер → 400).
export function sliceDeals(snapshot, filters, options = {}) {
  const now = options.now || new Date();
  const limit = options.limit || SLICE_LIMIT;
  const period = periodFromFilters(filters, now);
  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const dashboardFilters = {
    managerId: filters.managerId || '',
    sourceId: filters.sourceId || '',
    ...extraFilterSlice(filters),
    mode: filters.mode === 'static' ? 'static' : 'dynamic'
  };
  const byDeal = eventsByDeal(stageEvents);
  const slice = String(options.slice || '');
  const sliceValue = String(options.sliceValue || '');
  const stageDate = (deal, stageId) => firstEventDateInPeriod(byDeal.get(deal.id) || [], stageId, period);
  const signedList = (extraFilters) => contractDealsInPeriod(deals, stageEvents, period, extraFilters || dashboardFilters);

  let picked; // [{ deal, eventDate }]
  if (slice === 'contracts') {
    // тот же отбор, что periodContractDeals и kpis.contractSigned
    picked = signedList().filter((deal) => rubAmount(deal) > 0)
      .map((deal) => ({ deal, eventDate: stageDate(deal, STAGE_IDS.contractSigned) }));
  } else if (slice === 'funnelStage') {
    // тот же набор, что счётчик ступени воронки (static/dynamic)
    const index = stageIndex(sliceValue);
    if (index < 0) return null;
    const sets = dashboardFilters.mode === 'static'
      ? staticFunnelSets(deals, stageEvents, period, dashboardFilters).countSets
      : dynamicFunnelSets(deals, stageEvents, period, dashboardFilters);
    const dealById = new Map(deals.map((deal) => [deal.id, deal]));
    picked = [...sets[index]]
      .map((id) => dealById.get(id))
      .filter(Boolean)
      .map((deal) => ({ deal, eventDate: stageDate(deal, STAGES[index].id) }));
  } else if (slice === 'manager') {
    // тот же отбор, что «Факт» карточки менеджера (managerPlanRows)
    if (!sliceValue) return null;
    picked = signedList({ ...dashboardFilters, managerId: sliceValue })
      .map((deal) => ({ deal, eventDate: stageDate(deal, STAGE_IDS.contractSigned) }));
  } else if (slice === 'source') {
    // тот же отбор и группировка, что revenueBySources/sourcePaymentShare (включая «Прочие» вне топ-7)
    const contracts = signedList().filter((deal) => rubAmount(deal) > 0);
    let match;
    if (sliceValue === 'other') {
      const topIds = new Set(revenueBySources(contracts, sources).slice(0, 7).map((row) => row.id));
      match = (deal) => !topIds.has(String(deal.sourceId || 'unknown'));
    } else {
      match = (deal) => String(deal.sourceId || 'unknown') === sliceValue;
    }
    picked = contracts.filter(match).map((deal) => ({ deal, eventDate: stageDate(deal, STAGE_IDS.contractSigned) }));
  } else if (slice === 'failureReason') {
    // тот же отбор, что failureReasons (В10): проигранные периода, дошедшие до «Выявлена потребность», + причина
    const reachedStage = makeReachedStage(deals, stageEvents);
    const matchReason = sliceValue === 'other'
      ? (deal) => OTHER_FAILURE_REASONS.has(failureReasonOf(deal))
      : (deal) => failureReasonOf(deal) === sliceValue;
    const dealById = new Map(deals.map((deal) => [deal.id, deal]));
    picked = [...lostDealIdsInPeriod(deals, stageEvents, period, dashboardFilters)]
      .filter((id) => reachedStage(id, NEED_STAGE_INDEX))
      .map((id) => dealById.get(id))
      .filter((deal) => deal && matchReason(deal))
      .map((deal) => ({ deal, eventDate: dealClosedDate(deal) }));
  } else if (slice === 'stagePass') {
    // сделки с событием перехода на этап в периоде (для графиков этапов)
    const index = stageIndex(sliceValue);
    if (index < 0) return null;
    const allowed = new Set(deals.filter((deal) => matchesFilters(deal, dashboardFilters)).map((deal) => deal.id));
    const dealById = new Map(deals.map((deal) => [deal.id, deal]));
    picked = [...uniqueDealsForStage(stageEvents, sliceValue, period, allowed)]
      .map((id) => dealById.get(id))
      .filter(Boolean)
      .map((deal) => ({ deal, eventDate: stageDate(deal, canonicalStageId(sliceValue)) }));
  } else if (slice === 'inWork') {
    // «в работе» (В8): открытые сделки этапов 3..6; sliceValue — id менеджера (опционально)
    const workFilters = sliceValue ? { ...dashboardFilters, managerId: sliceValue } : dashboardFilters;
    picked = inWorkDeals(deals, workFilters).map((deal) => ({ deal, eventDate: dateOrNull(deal.updatedAt) }));
  } else {
    return null;
  }

  picked.sort((a, b) => rubAmount(b.deal) - rubAmount(a.deal));
  const managerNameById = new Map(managers.map((manager) => [String(manager.id), manager.name]));
  const rows = picked.slice(0, limit).map(({ deal, eventDate }) => {
    const stage = STAGE_BY_ID.get(canonicalStageId(deal.stageId));
    return {
      id: deal.id,
      company: deal.title || `Сделка ${deal.id}`,
      amount: rubAmount(deal),
      stage: stage ? stage.name : (isLostStage(deal.stageId) ? 'Проигрыш' : (deal.stageId || '')),
      manager: managerNameById.get(String(deal.managerId)) || '',
      source: sourceName(deal.sourceId, sources),
      eventDate: eventDate ? eventDate.toISOString().slice(0, 10) : null
    };
  });
  return {
    slice, sliceValue, rows,
    count: picked.length,
    total: Math.round(picked.reduce((sum, item) => sum + rubAmount(item.deal), 0)),
    truncated: picked.length > rows.length
  };
}

function aiFunnelFor(deals, stageEvents, period, filters) {
  return filters.mode === 'static'
    ? staticFunnel(deals, stageEvents, period, filters)
    : dynamicFunnel(deals, stageEvents, period, filters);
}

function aiSliceMetrics(deals, stageEvents, period, filters) {
  const funnel = aiFunnelFor(deals, stageEvents, period, filters);
  const contractDeals = contractDealsInPeriod(deals, stageEvents, period, filters);
  const money = moneyMetric(contractDeals);
  return {
    entered: funnel[0]?.count || 0,
    contracts: money.count,
    conversion: funnelTotalConversion(funnel).value,
    revenue: money.value,
    avgCheck: money.count ? Math.round(money.value / money.count) : 0,
    funnel
  };
}

// Loss-reason text is free-form in Bitrix and may contain client PII (names/phones/emails).
// Strip contact-like patterns and cap length before it is sent to the model.
function sanitizeReason(name) {
  return String(name || '')
    .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '[email]')
    .replace(/\+?\d[\d()\s-]{6,}\d/g, '[номер]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Не указана';
}

function sanitizeLossReasons(rows) {
  return (rows || []).map((row) => ({ reason: sanitizeReason(row.name), count: row.count, percent: row.percent }));
}

// Список сделок среза для ИИ-чата: сделки с событием этапа в выбранном периоде (по фильтрам),
// ключевые поля, отсортировано по сумме и ограничено по количеству (бюджет токенов).
export function aiDealsForPeriod(snapshot, filters, options = {}) {
  const limit = options.limit || 120;
  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const period = periodFromFilters(filters, options.now || new Date());
  const slice = { managerId: filters.managerId || '', sourceId: filters.sourceId || '', ...extraFilterSlice(filters) };
  const byDeal = eventsByDeal(stageEvents);
  const mgrName = new Map(managers.map((m) => [String(m.id), m.name]));
  const rows = [];
  for (const deal of deals) {
    if (!matchesFilters(deal, slice)) continue;
    const events = byDeal.get(deal.id) || [];
    const active = events.some((event) => {
      const date = dateOrNull(event.createdAt);
      return date && date >= period.fromDate && date <= period.toDate;
    });
    if (!active) continue;
    const stage = STAGE_BY_ID.get(canonicalStageId(deal.stageId));
    rows.push({
      company: deal.title || '',
      amount: rubAmount(deal),
      stage: stage ? stage.name : (deal.stageId || ''),
      manager: mgrName.get(String(deal.managerId)) || '',
      source: sourceName(deal.sourceId, sources),
      clientType: deal.clientType || ''
    });
  }
  rows.sort((a, b) => b.amount - a.amount);
  return { total: rows.length, deals: rows.slice(0, limit) };
}

// Поиск сделок по названию (для «Разбора сделки») — локально по кэшу, без вызова Битрикса.
// Возвращает краткие карточки совпадений, отсортированные по сумме.
export function searchDealsByTitle(snapshot, query, options = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const limit = options.limit || 15;
  const deals = snapshot.deals || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const mgrName = new Map(managers.map((m) => [String(m.id), m.name]));
  const matches = [];
  for (const deal of deals) {
    const title = String(deal.title || '');
    if (!title.toLowerCase().includes(q)) continue;
    const stage = STAGE_BY_ID.get(canonicalStageId(deal.stageId));
    matches.push({
      id: String(deal.id),
      title,
      amount: rubAmount(deal),
      stage: stage ? stage.name : (deal.stageId || ''),
      manager: mgrName.get(String(deal.managerId)) || '',
      source: sourceName(deal.sourceId, sources),
      clientType: deal.clientType || ''
    });
  }
  matches.sort((a, b) => b.amount - a.amount);
  return matches.slice(0, limit);
}

// Краткая сводка одной сделки из кэша для контекста разбора (нормализованные, человекочитаемые поля).
export function dealSummaryFromCache(snapshot, dealId) {
  const deals = snapshot.deals || [];
  const deal = deals.find((d) => String(d.id) === String(dealId));
  if (!deal) return null;
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const mgrName = new Map(managers.map((m) => [String(m.id), m.name]));
  const stage = STAGE_BY_ID.get(canonicalStageId(deal.stageId));
  const events = (snapshot.stageEvents || []).filter((e) => String(e.dealId) === String(deal.id));
  return {
    deal,
    summary: {
      id: String(deal.id),
      title: deal.title || '',
      amount: rubAmount(deal),
      stage: stage ? stage.name : (deal.stageId || ''),
      manager: mgrName.get(String(deal.managerId)) || '',
      source: sourceName(deal.sourceId, sources),
      clientType: deal.clientType || '',
      createdAt: deal.createdAt || null,
      stageEventsCount: events.length
    }
  };
}

// Compact, model-friendly aggregation for the AI sales analyst: current vs previous
// period, top managers (with manager x source split), top sources, loss reasons.
// Aggregates only — no client PII.
export function buildAiSnapshot(snapshot, filters, options = {}) {
  const now = options.now || new Date();
  const mode = filters.mode === 'static' ? 'static' : 'dynamic';
  const period = periodFromFilters(filters, now);
  const previous = shiftPeriod(period, -1);
  // managerId/sourceId сброшены намеренно (модель сама строит разрезы), доп-фильтры среза применяем.
  const baseFilters = { periodType: period.type, managerId: '', sourceId: '', ...extraFilterSlice(filters), mode };

  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const managerPlans = options.plans?.managerPlans || {};

  const reachedStage = makeReachedStage(deals, stageEvents); // В10: фильтр отказов «дошла до этапа»
  const MAX_MANAGERS = 8;
  const MAX_SOURCES = 6;

  const isQuarter = period.type === 'quarter';
  const dayCount = (a, b) => Math.max(1, Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1);
  const elapsedDays = dayCount(period.fromDate, period.toDate);
  const totalDays = dayCount(previous.fromDate, previous.toDate);
  const periodComplete = elapsedDays >= totalDays;

  const overallFor = (p) => {
    const m = aiSliceMetrics(deals, stageEvents, p, baseFilters);
    return {
      entered: m.entered,
      contracts: m.contracts,
      conversion: m.conversion,
      revenue: m.revenue,
      avgCheck: m.avgCheck,
      dealCycleDays: dealCycle(deals, stageEvents, p, baseFilters).value,
      funnel: m.funnel.map((stage) => ({ stage: stage.name, count: stage.count, stageConv: stage.conversion }))
    };
  };

  const rankedSources = sources
    .map((src) => ({ id: String(src.id), name: src.name, ...aiSliceMetrics(deals, stageEvents, period, { ...baseFilters, sourceId: String(src.id) }) }))
    .filter((s) => s.entered > 0 || s.contracts > 0)
    .sort((a, b) => b.entered - a.entered || b.contracts - a.contracts);
  const topSources = rankedSources.slice(0, MAX_SOURCES);

  const sourcesBlock = topSources.map((s) => {
    const prev = aiSliceMetrics(deals, stageEvents, previous, { ...baseFilters, sourceId: s.id });
    return {
      source: s.name,
      current: { entered: s.entered, contracts: s.contracts, conversion: s.conversion, revenue: s.revenue, avgCheck: s.avgCheck },
      previous: { entered: prev.entered, contracts: prev.contracts, conversion: prev.conversion }
    };
  });

  const rankedManagers = managers
    .map((mgr) => ({ mgr, ...aiSliceMetrics(deals, stageEvents, period, { ...baseFilters, managerId: mgr.id }) }))
    .filter((x) => x.entered > 0 || x.contracts > 0)
    .sort((a, b) => b.entered - a.entered || b.contracts - a.contracts);
  const topManagers = rankedManagers.slice(0, MAX_MANAGERS);

  const managersBlock = topManagers.map((x) => {
    const managerFilters = { ...baseFilters, managerId: x.mgr.id };
    const prev = aiSliceMetrics(deals, stageEvents, previous, managerFilters);
    const plan = Number(managerPlans[x.mgr.id] || 0);
    const bySource = sources
      .map((src) => {
        const ms = aiSliceMetrics(deals, stageEvents, period, { ...managerFilters, sourceId: String(src.id) });
        return { source: src.name, entered: ms.entered, conversion: ms.conversion, contracts: ms.contracts };
      })
      .filter((s) => s.entered > 0)
      .sort((a, b) => b.entered - a.entered)
      .slice(0, MAX_SOURCES);
    return {
      manager: x.mgr.name,
      inSalesDept: Boolean(x.mgr.inSalesDepartment),
      current: {
        entered: x.entered,
        contracts: x.contracts,
        conversion: x.conversion,
        revenue: x.revenue,
        avgCheck: x.avgCheck,
        plan: isQuarter ? plan : null,
        planProgress: isQuarter && plan ? Math.round((x.revenue / plan) * 1000) / 10 : null
      },
      previous: { contracts: prev.contracts, conversion: prev.conversion, avgCheck: prev.avgCheck },
      bySource
    };
  });

  return {
    generatedFor: 'РОП (руководитель отдела продаж)',
    currency: RUB,
    mode,
    note: 'conversion = доля дошедших до «Договор подписан» от вошедших в «Взят в работу» (%). entered = вошло в работу. avgCheck/revenue — рубли. Источник — поле «Источник ОП БИМ». bySource — топ источников самого менеджера за текущий период. plan/planProgress заполнены только для квартального периода (план квартальный), иначе null. Текущий период может быть неполным — см. period.current.complete / elapsedDays из totalDays; не считай меньшие абсолюты (entered/contracts/revenue) падением, если период ещё идёт.',
    period: {
      current: { from: period.fromDate.toISOString().slice(0, 10), to: period.toDate.toISOString().slice(0, 10), key: period.key, elapsedDays, totalDays, complete: periodComplete },
      previous: { from: previous.fromDate.toISOString().slice(0, 10), to: previous.toDate.toISOString().slice(0, 10), key: previous.key }
    },
    overall: { current: overallFor(period), previous: overallFor(previous) },
    sources: sourcesBlock,
    managers: managersBlock,
    lossReasons: {
      current: sanitizeLossReasons(failureReasons(deals, stageEvents, period, baseFilters, reachedStage)),
      previous: sanitizeLossReasons(failureReasons(deals, stageEvents, previous, baseFilters, reachedStage))
    }
  };
}

function inclusiveDayCount(a, b) {
  return Math.max(1, Math.round((startOfUtcDay(b).getTime() - startOfUtcDay(a).getTime()) / DAY_MS) + 1);
}

// Natural (uncapped) end of the period — periodFromFilters caps toDate at "now",
// but run-rate projection needs the full period length.
function naturalPeriodEnd(period, now) {
  return boundsForPeriod(period.type, period.key, now).toDate;
}

// Месяцы (YYYY-MM), которые покрывает натуральный период: месяц => 1, квартал => 3, год => 12.
// Источник истины для суммирования помесячных планов в план уровня периода.
function monthKeysForPeriod(periodType, periodValue, now = new Date()) {
  const bounds = boundsForPeriod(periodType, periodValue, now);
  const keys = [];
  let cursor = new Date(Date.UTC(bounds.fromDate.getUTCFullYear(), bounds.fromDate.getUTCMonth(), 1));
  while (cursor <= bounds.toDate) {
    keys.push(monthKeyFromDate(cursor));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return keys;
}

// Global average days from "being at stage X" to "Договор подписан", among signed deals.
// Feeds the per-manager forecast (which open deals can realistically close in time).
function avgDaysStageToContract(deals, stageEvents) {
  const byDeal = eventsByDeal(stageEvents);
  const contractIndex = stageIndex(STAGE_IDS.contractSigned);
  const acc = STAGES.map(() => ({ total: 0, count: 0 }));
  for (const deal of deals) {
    const events = byDeal.get(deal.id) || [];
    const contractDate = firstEventDate(events, STAGE_IDS.contractSigned);
    if (!contractDate) continue;
    for (const stage of STAGES) {
      if (stage.index >= contractIndex) continue;
      const startDate = firstEventDate(events, stage.id);
      if (!startDate || startDate > contractDate) continue;
      acc[stage.index].total += (contractDate.getTime() - startDate.getTime()) / DAY_MS;
      acc[stage.index].count += 1;
    }
  }
  return acc.map((row) => (row.count ? Math.round((row.total / row.count) * 10) / 10 : null));
}

// Predicts whether a manager risks missing the plan this period: open deals stuck early,
// and revenue of deals whose typical time-to-contract exceeds the days left.
function managerForecast(deals, stageEvents, avgStageToContract, managerId, daysRemaining, now) {
  const contractIndex = stageIndex(STAGE_IDS.contractSigned);
  const lateIndex = stageIndex(STAGE_IDS.meetingDone);
  const open = deals.filter((deal) => (
    String(deal.managerId) === String(managerId)
    && !isLostStage(deal.stageId)
    && stageIndex(deal.stageId) >= 0
    && stageIndex(deal.stageId) < contractIndex
  ));
  // Прогноз «не успеет закрыться до конца периода» имеет смысл только для идущего периода.
  // Для завершённого периода (daysRemaining = 0) at-risk не считаем — иначе все открытые сделки попадут в риск.
  const forecastable = daysRemaining > 0;
  let atRiskRevenue = 0;
  let atRiskCount = 0;
  let lateStageOpen = 0;
  for (const deal of open) {
    const index = stageIndex(deal.stageId);
    if (index >= lateIndex) lateStageOpen += 1;
    if (!forecastable) continue;
    const typical = avgStageToContract[index];
    if (typical != null && typical > daysRemaining) {
      atRiskRevenue += rubAmount(deal);
      atRiskCount += 1;
    }
  }
  const cycle = dealCycle(deals, stageEvents, { fromDate: new Date(0), toDate: now }, { managerId });
  return {
    avgCycleDays: cycle.value,
    openDeals: open.length,
    lateStageOpen,
    atRiskCount,
    atRiskRevenue: Math.round(atRiskRevenue),
    riskFlag: forecastable && open.length > 0 && lateStageOpen === 0
  };
}

// Rich, model-friendly snapshot for the deep AI report (week/month/quarter):
// plan/fact/gap, run-rate projection, both funnel modes, source/manager breakdowns,
// per-manager cycle forecast, loss reasons. Aggregates + internal ids only — no client PII.
export function buildReportMetrics(snapshot, filters, options = {}) {
  const now = options.now || new Date();
  const mode = filters.mode === 'static' ? 'static' : 'dynamic';
  const period = periodFromFilters(filters, now);
  const previous = shiftPeriod(period, -1);
  const baseFilters = { periodType: period.type, managerId: filters.managerId || '', sourceId: filters.sourceId || '', ...extraFilterSlice(filters), mode };

  const deals = snapshot.deals || [];
  const stageEvents = snapshot.stageEvents || [];
  const sources = snapshot.sources || [];
  const managers = buildManagerReference(deals, snapshot.managers || []);
  const managerPlans = options.plans?.managerPlans || {};

  const reachedStage = makeReachedStage(deals, stageEvents); // В10: фильтр отказов «дошла до этапа»
  const MAX_MANAGERS = 10;
  const MAX_SOURCES = 8;

  const naturalEnd = naturalPeriodEnd(period, now);
  const totalDays = inclusiveDayCount(period.fromDate, naturalEnd);
  const elapsedDays = inclusiveDayCount(period.fromDate, period.toDate);
  const complete = period.toDate.getTime() >= naturalEnd.getTime();
  const daysRemaining = Math.max(0, totalDays - elapsedDays);

  // Plan respects the manager filter; a source filter does not constrain the plan (plans are per-manager).
  const planManagers = filters.managerId
    ? managers.filter((manager) => String(manager.id) === String(filters.managerId))
    : managers;
  // План уровня периода = сумма помесячных планов (options.plans уже просуммирован по месяцам периода).
  const target = planManagers.reduce((sum, manager) => sum + Number(managerPlans[manager.id] || 0), 0);
  const fact = sumDeals(contractDealsInPeriod(deals, stageEvents, period, baseFilters));
  const plan = {
    target,
    fact,
    gap: Math.max(0, target - fact),
    percent: target ? Math.round((fact / target) * 1000) / 10 : null
  };

  const projectedFact = complete || elapsedDays <= 0 ? fact : Math.round((fact / elapsedDays) * totalDays);
  const projection = {
    projectedFact,
    gapToPlan: target ? Math.round(target - projectedFact) : null,
    willHitPlan: target ? projectedFact >= target : null,
    confidence: complete ? 'high' : elapsedDays < 3 ? 'low' : elapsedDays < totalDays / 2 ? 'medium' : 'high'
  };

  const overallFor = (p) => {
    const m = aiSliceMetrics(deals, stageEvents, p, baseFilters);
    return {
      entered: m.entered,
      contracts: m.contracts,
      conversion: m.conversion,
      revenue: m.revenue,
      avgCheck: m.avgCheck,
      dealCycleDays: dealCycle(deals, stageEvents, p, baseFilters).value
    };
  };

  const funnelStages = (funnel) => funnel.map((stage) => ({ stage: stage.name, count: stage.count, stageConv: stage.conversion }));
  const funnelCompare = {
    static: funnelStages(staticFunnel(deals, stageEvents, period, baseFilters)),
    dynamic: funnelStages(dynamicFunnel(deals, stageEvents, period, baseFilters))
  };

  const sourcesBlock = sources
    .map((src) => ({ id: String(src.id), name: src.name, ...aiSliceMetrics(deals, stageEvents, period, { ...baseFilters, sourceId: String(src.id) }) }))
    .filter((s) => s.entered > 0 || s.contracts > 0)
    .sort((a, b) => b.entered - a.entered || b.contracts - a.contracts)
    .slice(0, MAX_SOURCES)
    .map((s) => {
      const prev = aiSliceMetrics(deals, stageEvents, previous, { ...baseFilters, sourceId: s.id });
      return {
        source: s.name,
        current: { entered: s.entered, contracts: s.contracts, conversion: s.conversion, revenue: s.revenue, avgCheck: s.avgCheck },
        previous: { entered: prev.entered, contracts: prev.contracts, conversion: prev.conversion, avgCheck: prev.avgCheck }
      };
    });

  const avgStageToContract = avgDaysStageToContract(deals, stageEvents);
  const managersBlock = managers
    .map((mgr) => ({ mgr, ...aiSliceMetrics(deals, stageEvents, period, { ...baseFilters, managerId: mgr.id }) }))
    .filter((x) => x.entered > 0 || x.contracts > 0 || Number(managerPlans[x.mgr.id] || 0) > 0)
    .sort((a, b) => b.entered - a.entered || b.contracts - a.contracts)
    .slice(0, MAX_MANAGERS)
    .map((x) => {
      const managerFilters = { ...baseFilters, managerId: x.mgr.id };
      const prev = aiSliceMetrics(deals, stageEvents, previous, managerFilters);
      const bySource = sources
        .map((src) => {
          const ms = aiSliceMetrics(deals, stageEvents, period, { ...managerFilters, sourceId: String(src.id) });
          return { source: src.name, entered: ms.entered, conversion: ms.conversion, contracts: ms.contracts };
        })
        .filter((s) => s.entered > 0)
        .sort((a, b) => b.entered - a.entered)
        .slice(0, MAX_SOURCES);
      return {
        manager: x.mgr.name,
        inSalesDept: Boolean(x.mgr.inSalesDepartment),
        planQuarter: Number(managerPlans[x.mgr.id] || 0) || null,
        current: { entered: x.entered, contracts: x.contracts, conversion: x.conversion, revenue: x.revenue, avgCheck: x.avgCheck },
        previous: { contracts: prev.contracts, conversion: prev.conversion, avgCheck: prev.avgCheck },
        bySource,
        forecast: managerForecast(deals, stageEvents, avgStageToContract, x.mgr.id, daysRemaining, now)
      };
    });

  return {
    generatedFor: 'РОП (руководитель отдела продаж)',
    currency: RUB,
    mode,
    periodType: period.type,
    note: 'conversion = % дошедших до «Договор подписан» от вошедших в «Взят в работу». entered = вошло в работу. avgCheck/revenue/target/fact — рубли. funnelCompare: static = когорта периода, dynamic = с учётом дозревших сделок прошлых периодов; если dynamic-конверсия заметно выше static — текущий результат во многом за счёт нахлёста прошлых лидов. forecast.atRiskRevenue — выручка открытых сделок менеджера, которые по типовому циклу не успевают закрыться за daysRemaining. plan.target = сумма помесячных планов за период (квартал = 3 месяца). period.current.complete=false => период ещё идёт, меньшие абсолюты — не падение; используй projection и относительные показатели.',
    period: {
      current: { from: period.fromDate.toISOString().slice(0, 10), to: period.toDate.toISOString().slice(0, 10), key: period.key, elapsedDays, totalDays, daysRemaining, complete },
      previous: { from: previous.fromDate.toISOString().slice(0, 10), to: previous.toDate.toISOString().slice(0, 10), key: previous.key }
    },
    plan,
    projection,
    overall: { current: overallFor(period), previous: overallFor(previous) },
    funnelCompare,
    sources: sourcesBlock,
    managers: managersBlock,
    lossReasons: {
      current: sanitizeLossReasons(failureReasons(deals, stageEvents, period, baseFilters, reachedStage)),
      previous: sanitizeLossReasons(failureReasons(deals, stageEvents, previous, baseFilters, reachedStage))
    }
  };
}

// UTC-хелперы периодов — единый источник границ для бэкфилла и планировщика отчётов,
// чтобы ключи/границы совпадали с дашбордом (не вводить отдельную логику дат).
export { boundsForPeriod, shiftPeriod, periodKeyFromDate, quarterKeyFromDate, monthKeyFromDate, weekKeyFromDate, monthKeysForPeriod };
// Чистые метрик-хелперы — экспорт только для автотестов (scripts/check-median.mjs).
export { medianValue, percentDelta, moneyMetric };
