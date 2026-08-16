/**
 * Построение ступеней воронки.
 *
 * Здесь живут инварианты 1–7 из CONTEXT.md. Всё, что считает «сколько сущностей
 * на ступени», проходит через этот файл — и агрегат, и детализация, чтобы
 * число ступени и список за ним не могли разойтись (инвариант 8).
 *
 * Ключевое понятие — ЗАНЯТОСТЬ (occupancy): какие ступени воронки занимает одна
 * сущность и кто их прошёл. Дальше занятости просто складываются в множества.
 */

import {
  capReachedIndexByCurrentStage,
  funnelStages,
  resolveFunnel,
  stageIndex
} from '../domain/funnels.js';
import { eventsOf, managerAt } from './snapshot.js';

/**
 * Индексы событий сущности внутри одной воронки, в порядке времени.
 * События чужой воронки, служебные и отказ дают индекс -1 и отбрасываются:
 * на этом инварианте держится вся математика (см. `stageIndex`).
 */
function trackedEvents(index, funnel, entityType, entityId) {
  const rows = [];
  for (const event of eventsOf(index, entityType, entityId)) {
    const stageIdx = stageIndex(funnel, event.stageId);
    if (stageIdx < 0) continue;
    rows.push({ index: stageIdx, at: event.at });
  }
  return rows;
}

/**
 * Исторически достигнутая глубина сущности в воронке, с учётом правила отката.
 *
 * Текущая стадия учитывается наравне с историей: если история неполна, а сущность
 * стоит на шестом этапе, она дошла до шестого. Затем применяется правило воронки —
 * для сделок глубина обрезается текущей стадией, для компаний нет (инварианты 3–5).
 *
 * @returns {number} индекс достигнутого этапа или -1, если воронка не начата
 */
function reachedIndexOf(events, funnel, currentStageId) {
  let maxIndex = -1;
  for (const event of events) if (event.index > maxIndex) maxIndex = event.index;

  const currentIndex = stageIndex(funnel, currentStageId);
  if (currentIndex > maxIndex) maxIndex = currentIndex;
  if (maxIndex < 0) return -1;

  return capReachedIndexByCurrentStage(funnel, maxIndex, currentStageId);
}

/**
 * Кто прошёл каждую ступень до достигнутой глубины.
 *
 * Ступень «доказывается» первым по времени событием, поднявшим сущность на этот
 * уровень или выше. Пропущенные этапы (инвариант 2) наследуют исполнителя того
 * события, которое их доказало: наблюдаемого прохождения у них нет, и относить
 * их к кому-то другому не на чем.
 *
 * Ступени, доказанные только текущей стадией (истории нет), остаются без события —
 * для них берётся текущий ответственный.
 */
function proversUpTo(events, reachedIndex) {
  const provers = new Array(reachedIndex + 1).fill(null);
  let filledUpTo = -1;
  for (const event of events) {
    if (event.index <= filledUpTo) continue; // повтор или откат: ступени уже доказаны
    const top = Math.min(event.index, reachedIndex);
    for (let i = filledUpTo + 1; i <= top; i += 1) provers[i] = event;
    filledUpTo = event.index;
    if (filledUpTo >= reachedIndex) break;
  }
  return provers;
}

/**
 * Занятость в режиме СТАТИКИ: куда сущность дошла к моменту просмотра.
 *
 * @returns {Array<{index: number, at: number|null, managerId: string|null, exact: boolean}>}
 */
export function staticOccupancy(index, funnel, entityType, entityId, currentStageId) {
  const funnelObject = resolveFunnel(funnel);
  const events = trackedEvents(index, funnelObject, entityType, entityId);
  const reached = reachedIndexOf(events, funnelObject, currentStageId);
  if (reached < 0) return [];

  const provers = proversUpTo(events, reached);
  const occupancy = [];
  for (let i = 0; i <= reached; i += 1) {
    const prover = provers[i];
    const at = prover ? prover.at : null;
    const attribution = managerAt(index, entityType, entityId, at ?? Number.MAX_SAFE_INTEGER);
    occupancy.push({ index: i, at, managerId: attribution.managerId, exact: prover ? attribution.exact : false });
  }
  return occupancy;
}

/**
 * Занятость в режиме ДИНАМИКИ: какие ступени сущность прошла ВНУТРИ периода.
 *
 * Отличие от Статики принципиальное. Динамика отвечает на вопрос «что отдел сделал
 * за период», поэтому:
 *   - дата создания сущности не важна, важен факт движения в периоде;
 *   - пропущенные этапы докрашиваются от ПРЕДЫДУЩЕГО положения, а не от начала
 *     воронки: шаг с третьего этапа на шестой не должен задним числом
 *     засчитать первый и второй;
 *   - обратный переход положительным прохождением не является;
 *   - повторный вход на уже пройденный этап новой единицы не создаёт.
 */
export function dynamicOccupancy(index, funnel, entityType, entityId, currentStageId, period) {
  const funnelObject = resolveFunnel(funnel);
  const events = trackedEvents(index, funnelObject, entityType, entityId);
  if (events.length === 0) return [];

  const from = period.from ? period.from.getTime() : Number.NEGATIVE_INFINITY;
  const to = period.to.getTime();

  const occupancy = [];
  const seen = new Set();
  // Фактическая позиция сущности непосредственно перед текущим событием — в отличие
  // от исторического максимума, ПОНИЖАЕТСЯ после отката. Так последующий настоящий
  // подъём внутри периода (даже до уровня, когда-то достигнутого до периода)
  // распознаётся как новое движение, а не молча проглатывается устаревшим пиком.
  let position = -1;

  for (const event of events) {
    if (event.index <= position) {
      // Движение вниз или на месте: положительным прохождением не считается,
      // но позиция обязана отразить реальный откат.
      position = event.index;
      continue;
    }

    const previousPosition = position;
    position = event.index;

    if (event.at < from || event.at > to) continue; // движение вне периода

    const attribution = managerAt(index, entityType, entityId, event.at);
    for (let i = previousPosition + 1; i <= event.index; i += 1) {
      if (seen.has(i)) continue;
      seen.add(i);
      occupancy.push({ index: i, at: event.at, managerId: attribution.managerId, exact: attribution.exact });
    }
  }

  if (occupancy.length === 0) return [];

  // Ограничение текущей стадией активной сделки действует и в Динамике
  // (спека, Режим Динамики §6).
  const cap = capReachedIndexByCurrentStage(funnelObject, funnelStages(funnelObject).length - 1, currentStageId);
  return occupancy.filter((item) => item.index <= cap);
}

/**
 * Занятость по режиму.
 * Единственная точка, где режим влияет на отбор ступеней.
 */
export function occupancyOf(index, funnel, entityType, entity, mode, period) {
  return mode === 'dynamic'
    ? dynamicOccupancy(index, funnel, entityType, entity.id, entity.currentStageId, period)
    : staticOccupancy(index, funnel, entityType, entity.id, entity.currentStageId);
}

/**
 * Множества сущностей по ступеням одной воронки.
 *
 * @param {object}   index      индексированный снимок
 * @param {object}   funnel     воронка
 * @param {Iterable} entities   сущности, уже прошедшие фильтры уровня сущности
 * @param {string}   entityType 'company' | 'deal'
 * @param {string}   mode       'static' | 'dynamic'
 * @param {object}   period     разрешённый период
 * @param {Set|null} managerIds выбранные менеджеры или null (все)
 *
 * @returns {{sets: Array<Set<string>>, attribution: Array<Map<string, object>>, inexact: number}}
 *          `sets[i]` — уникальные сущности на ступени i (инвариант 1: считается размер множества);
 *          `attribution[i]` — кто и когда прошёл ступень, нужно детализации;
 *          `inexact` — сколько раз сработал фолбэк атрибуции.
 */
export function stageSets(index, funnel, entities, entityType, mode, period, managerIds) {
  const funnelObject = resolveFunnel(funnel);
  const stageCount = funnelStages(funnelObject).length;
  const sets = Array.from({ length: stageCount }, () => new Set());
  const attribution = Array.from({ length: stageCount }, () => new Map());
  let inexact = 0;

  for (const entity of entities) {
    const occupancy = occupancyOf(index, funnelObject, entityType, entity, mode, period);
    for (const item of occupancy) {
      // Фильтр менеджера применяется к ФАКТИЧЕСКОМУ исполнителю ступени,
      // а не к текущему ответственному за сущность (инвариант 7).
      if (managerIds && !managerIds.has(item.managerId)) continue;
      if (!item.exact) inexact += 1;
      // Множество само обеспечивает уникальность: повторное прохождение
      // и совпадение по нескольким выбранным менеджерам дубля не создают.
      sets[item.index].add(entity.id);
      if (!attribution[item.index].has(entity.id)) {
        attribution[item.index].set(entity.id, { at: item.at, managerId: item.managerId, exact: item.exact });
      }
    }
  }

  return { sets, attribution, inexact };
}
