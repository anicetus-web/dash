/**
 * Агрегация звонков. Отдельный от воронок домен — у звонка нет стадии, поэтому
 * он не проходит через `computeSlice`/`stageSets`.
 *
 * ОТБОР ЗВОНКОВ УЖЕ, ЧЕМ У ВОРОНКИ, И ЭТО НАМЕРЕННО: только период и менеджер.
 * База и формат КЭВ на звонки НЕ распространяются. Звонок — работа менеджера, а
 * не свойство сделки: разговор может идти по сущности без базы, по сделке чужого
 * формата или вообще без привязки к воронке, и во всех этих случаях он всё равно
 * состоялся. Фильтруя звонки базой, карточка показывала бы не «сколько звонили»,
 * а «сколько звонили по сделкам с заполненным полем» — число, которое падает от
 * качества заполнения CRM, а не от работы отдела.
 *
 * Менеджер берётся СВОЙ у звонка (кто разговаривал), а не текущий ответственный
 * связанной сделки: разговор принадлежит тому, кто его вёл, даже если сделку
 * потом передали. Своего менеджера нет — берётся ответственный связанной
 * сущности, это лучшее доступное приближение.
 */
import { inPeriod, resolvePeriod } from '../domain/period.js';
import { normalizeFilters } from './filters.js';
import { NOT_SPECIFIED, buildIndex } from './snapshot.js';
import { resolveBucketWindows } from './timeBuckets.js';

function round1(value) {
  return Math.round(value * 10) / 10;
}

// Поля уже нормализованы индексом (normalizeCalls): success — булево,
// durationMinutes — число. Здесь только суммирование.
function summarize(calls) {
  let successful = 0;
  let minutes = 0;
  for (const call of calls) {
    if (call.success) successful += 1;
    minutes += call.durationMinutes;
  }
  // Неуспешные считаются вычитанием, а не вторым счётчиком: так они не могут
  // разойтись с общим числом ни при каком значении признака успешности.
  return {
    total: calls.length,
    successful,
    unsuccessful: calls.length - successful,
    minutes: round1(minutes)
  };
}

/**
 * Менеджер звонка: свой, иначе ответственный связанной сущности, иначе «не указан».
 */
function callManagerId(index, call) {
  if (call.managerId) return call.managerId;
  const deal = call.dealId ? index.deals.get(call.dealId) : null;
  if (deal?.assignedById) return deal.assignedById;
  const company = call.companyId ? index.companies.get(call.companyId) : null;
  return company?.assignedById || NOT_SPECIFIED;
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

  const inScope = [];
  for (const call of index.calls) {
    if (!inPeriod(call.at, period)) continue;
    if (filters.managerIds && !filters.managerIds.has(callManagerId(index, call))) continue;
    inScope.push(call);
  }

  const windows = resolveBucketWindows(period, { now: options.now, timeZone: period.timeZone });
  const series = windows.map(({ label, fromMs, toMs }) => {
    let minutes = 0;
    for (const call of inScope) {
      if (call.atMs < fromMs || call.atMs > toMs) continue;
      minutes += call.durationMinutes;
    }
    return { label, minutes: round1(minutes) };
  });

  return { ...summarize(inScope), series };
}
