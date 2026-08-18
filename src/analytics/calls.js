/**
 * Агрегация звонков. Отдельный от воронок домен — у звонка нет стадии, поэтому
 * он не проходит через `computeSlice`/`stageSets`. Общее с расчётным модулем:
 * то же разрешение периода (`resolvePeriod`), те же фильтры источника/КЭВ через
 * компанию/сделку, к которой звонок привязан, и то же разбиение на бакеты графика
 * (`resolveBucketWindows`) — единый масштаб для звонков и обеих конверсий,
 * иначе графики на одном экране показывали бы разные окна времени.
 *
 * Фильтр по менеджеру проверяется по ТЕКУЩЕМУ ответственному связанной компании/сделки
 * (`assignedById`), не по историческому: у звонка нет «этапа», к которому применялась бы
 * атрибуция по истории ответственных, как для ступеней воронки.
 */
import { inPeriod, resolvePeriod } from '../domain/period.js';
import { companyPasses, dealPasses, normalizeFilters } from './filters.js';
import { NOT_SPECIFIED, buildIndex } from './snapshot.js';
import { resolveBucketWindows } from './timeBuckets.js';

function round1(value) {
  return Math.round(value * 10) / 10;
}

function inScopeIds(index, filters) {
  const companyIds = new Set();
  for (const company of index.companies.values()) {
    if (!companyPasses(company, filters)) continue;
    if (filters.managerIds && !filters.managerIds.has(company.assignedById || NOT_SPECIFIED)) continue;
    companyIds.add(company.id);
  }
  const dealIds = new Set();
  for (const deal of index.deals.values()) {
    if (!dealPasses(deal, filters)) continue;
    if (filters.managerIds && !filters.managerIds.has(deal.assignedById || NOT_SPECIFIED)) continue;
    dealIds.add(deal.id);
  }
  return { companyIds, dealIds };
}

// Звонок по сделке проверяется по фильтрам сделки (там же КЭВ), звонок без сделки — по компании.
function callInScope(call, companyIds, dealIds) {
  if (call.dealId) return dealIds.has(call.dealId);
  if (call.companyId) return companyIds.has(call.companyId);
  return false;
}

function summarize(calls) {
  let successful = 0;
  let minutes = 0;
  for (const call of calls) {
    if (call.success) successful += 1;
    minutes += call.durationMinutes || 0;
  }
  return { total: calls.length, successful, minutes: round1(minutes) };
}

/**
 * Звонки за период: итоги (всего/успешных/минут) и динамика минут по бакетам графика.
 */
export function calculateCalls(snapshot, request = {}, options = {}) {
  const index = buildIndex(snapshot);
  const timeZone = options.timeZone || index.portalTimezone || undefined;
  const period = resolvePeriod(
    { type: request.periodType, value: request.periodValue, from: request.from, to: request.to },
    { now: options.now, timeZone }
  );
  const filters = normalizeFilters(request);
  const { companyIds, dealIds } = inScopeIds(index, filters);

  const allCalls = index.calls;
  const inScope = [];
  for (const call of allCalls) {
    if (!callInScope(call, companyIds, dealIds)) continue;
    if (!inPeriod(call.at, period)) continue;
    const atMs = Date.parse(call.at);
    if (Number.isNaN(atMs)) continue;
    inScope.push({ ...call, atMs });
  }

  const windows = resolveBucketWindows(period, { now: options.now, timeZone: period.timeZone });
  const series = windows.map(({ label, fromMs, toMs }) => {
    let minutes = 0;
    for (const call of inScope) {
      if (call.atMs < fromMs || call.atMs > toMs) continue;
      minutes += call.durationMinutes || 0;
    }
    return { label, minutes: round1(minutes) };
  });

  return { ...summarize(inScope), series };
}
