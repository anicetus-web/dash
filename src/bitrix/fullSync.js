/**
 * Оркестрация полной синхронизации с Битрикс24.
 *
 * Единственная обязанность файла — превратить набор запросов к порталу
 * в снимок формы `EMPTY_CACHE`. Хранилищем, единственностью запуска и
 * защитой от затирания хорошего снимка плохим занимается `src/sync/service.js` —
 * здесь только чистая функция `fetchBitrixSnapshot(options) → snapshot`,
 * которая ничего не пишет на диск и не знает про предыдущий снимок.
 *
 * Доступа к реальному порталу на момент написания НЕТ (см. `reference/REQUIRED_INPUTS.md`).
 * Поэтому каждый сетевой шаг вне «компании/сделки» (история стадий, история
 * ответственных, справочники) обёрнут так, что его отказ превращается
 * в предупреждение и пустой результат, а не в падение всей синхронизации —
 * иначе неподтверждённое имя одного маршрута блокировало бы весь снимок.
 */

import { config } from '../config.js';
import { createBitrixClient, isRetryableError } from './client.js';
import {
  PORTAL_FIELDS,
  dictionaryFromValues,
  fieldItems,
  findFieldDescription,
  normalizeAssigneeEvent,
  normalizeCompany,
  normalizeDeal,
  normalizeStageEvent,
  normalizeUser,
  pendingAuditFields,
  resolvePortalFields
} from './normalize.js';

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. ИМЕНА СУЩНОСТЕЙ VIBECODE API — ПОДТВЕРДИТЬ ПОСЛЕ АУДИТА ПОРТАЛА.
 *
 * Стандартные CRM-сущности Битрикс24 (`company`, `deal`, `user`) называются
 * по общепринятой конвенции REST-прокси и почти наверняка верны без правки.
 * Два маршрута — НАСТОЯЩАЯ неизвестность:
 *
 *   - История СТАДИЙ КОМПАНИИ. У компании в стандартном Bitrix24 CRM нет
 *     встроенного «стейджа» (это понятие только у сделок) — первая воронка
 *     3ДБИЛД ведётся ПОЛЬЗОВАТЕЛЬСКИМ полем (см. `PORTAL_FIELDS.companyStageField`).
 *     История ИЗМЕНЕНИЯ такого поля может не существовать как отдельный маршрут.
 *   - История ОТВЕТСТВЕННЫХ. Может не отдаваться API вовсе (см. REQUIRED_INPUTS.md,
 *     пункт про историю ответственных).
 *
 * Обе неизвестности не блокируют синхронизацию: см. `fetchOptional` ниже.
 * ------------------------------------------------------------------------- */
export const BITRIX_ENTITIES = Object.freeze({
  company: 'company',
  deal: 'deal',
  user: 'user',
  companyFields: 'company/fields',
  dealFields: 'deal/fields',
  // Общий маршрут истории переходов; для компании и сделки различается параметром entityType.
  stageHistory: 'stage-history',
  assigneeHistory: 'assignee-history'
});

function windows(fromMs, toMs, days) {
  const step = days * 24 * 60 * 60 * 1000;
  const list = [];
  let cursor = fromMs;
  while (cursor <= toMs) {
    const end = Math.min(cursor + step - 1, toMs);
    list.push({ from: new Date(cursor).toISOString(), to: new Date(end).toISOString() });
    cursor = end + 1;
  }
  return list;
}

/**
 * Общий ограничитель параллелизма — одна очередь на несколько независимых веток.
 *
 * Компании и сделки (или все четыре ветки истории) забираются одним `Promise.all`
 * синхронизации: если у каждой ветки СВОЙ пул воркеров на `limit` штук, реальный
 * пик одновременных запросов к порталу — произведение limit на число веток, а не
 * сам limit. BITRIX_FETCH_CONCURRENCY/BITRIX_HISTORY_CONCURRENCY документированы
 * как предел на портал в целом — эта функция и делает его таким.
 */
export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

async function mapLimit(items, limiter, mapper) {
  return Promise.all(items.map((item, index) => limiter(() => mapper(item, index))));
}

/**
 * Дробление окна пополам с бэкоффом при повторяемой ошибке — тот же приём,
 * что и в референсе Altech (`reference/altech/src/sync/fullSync.js`): большое
 * окно, упёршееся в лимит прокси на батч, распадается на два меньших, пока
 * не пройдёт или не упрётся в предохранитель глубины.
 */
async function fetchWindow(client, entity, buildFilter, window, depth = 0) {
  try {
    // Обычный сетевой сбой (не требующий дробления окна) сперва гасится плоским
    // повтором клиента — дробление остаётся для окна, реально упирающегося
    // в лимит прокси на батч, а не для любого единичного обрыва соединения.
    const { rows, truncated } = await client.retry(() => client.searchAll(entity, { filter: buildFilter(window) }));
    return { rows, warnings: truncated ? [{ code: 'WINDOW_TRUNCATED', message: `Окно ${window.from}–${window.to} обрезано предохранителем постраничности.` }] : [] };
  } catch (error) {
    const fromMs = Date.parse(window.from);
    const toMs = Date.parse(window.to);
    const canSplit = depth < 6 && isRetryableError(error) && toMs - fromMs > 24 * 60 * 60 * 1000;
    if (!canSplit) {
      return { rows: [], warnings: [{ code: error.code || 'WINDOW_FETCH_ERROR', message: error.message, from: window.from, to: window.to }] };
    }
    await new Promise((resolve) => { const t = setTimeout(resolve, Math.min(4000, 500 * 2 ** depth)); t.unref?.(); });
    const middle = Math.floor((fromMs + toMs) / 2);
    const halves = [
      { from: window.from, to: new Date(middle).toISOString() },
      { from: new Date(middle + 1).toISOString(), to: window.to }
    ];
    const parts = await Promise.all(halves.map((half) => fetchWindow(client, entity, buildFilter, half, depth + 1)));
    return { rows: parts.flatMap((p) => p.rows), warnings: parts.flatMap((p) => p.warnings) };
  }
}

/** Компании и сделки за весь заданный диапазон, окнами по `createdAt`/`updatedAt`. */
async function fetchEntityWindowed(client, entity, extraFilter, fromMs, toMs, limiter) {
  const ranges = windows(fromMs, toMs, config.bitrixWindowDays);
  const tasks = ranges.flatMap((window) => [
    { window, buildFilter: (w) => ({ ...extraFilter, createdAt: { $lte: toIsoSafe(toMs) }, updatedAt: { $gte: w.from, $lte: w.to } }) },
    { window, buildFilter: (w) => ({ ...extraFilter, createdAt: { $gte: w.from, $lte: w.to } }) }
  ]);

  const results = await mapLimit(tasks, limiter, (task) => fetchWindow(client, entity, task.buildFilter, task.window));

  const byId = new Map();
  const warnings = [];
  // Диапазоны окон, которые НЕ удалось получить целиком (после исчерпания дробления) —
  // сущность, чьи createdAt/updatedAt в них попадают, могла реально существовать
  // и просто не приехать в этот заход, а не быть удалённой на портале (см. вызов
  // restoreMissingFromPrevious в fetchBitrixSnapshot).
  const failedRanges = [];
  for (const result of results) {
    for (const row of result.rows) {
      const id = String(row?.id ?? row?.ID ?? '');
      if (id) byId.set(id, row);
    }
    warnings.push(...result.warnings);
    for (const warning of result.warnings) {
      if (!warning.from || !warning.to) continue;
      const from = Date.parse(warning.from);
      const to = Date.parse(warning.to);
      if (Number.isFinite(from) && Number.isFinite(to)) failedRanges.push({ from, to });
    }
  }
  return { rows: [...byId.values()], warnings, failedRanges };
}

/**
 * Сущности предыдущего снимка, чей заход в этот заход попал в НЕУДАВШЕЕСЯ окно
 * выборки, а среди свежеполученных их нет — восстанавливаются как есть. Без этого
 * окно, упёршееся в ошибку после исчерпания дробления (fetchWindow), делает свои
 * ~30 дней компаний/сделок невидимыми навсегда: `isDegradedSync` пропускает
 * просадку меньше 25% от общего числа, а один неудачный из ~48 окон — это
 * именно такая, некрупная на вид, но реальная и необратимая потеря сущностей.
 */
export function restoreMissingFromPrevious(freshList, previousList, failedRanges, warningsSink, label) {
  if (!Array.isArray(previousList) || previousList.length === 0 || failedRanges.length === 0) return freshList;
  const freshIds = new Set(freshList.map((entity) => entity.id));
  const merged = [...freshList];
  let restored = 0;
  for (const previous of previousList) {
    if (!previous?.id || freshIds.has(previous.id)) continue;
    const stamp = Date.parse(previous.createdAt || previous.updatedAt || '');
    if (!Number.isFinite(stamp)) continue;
    const inFailedWindow = failedRanges.some((range) => stamp >= range.from && stamp <= range.to);
    if (!inFailedWindow) continue;
    merged.push(previous);
    freshIds.add(previous.id);
    restored += 1;
  }
  if (restored > 0) {
    warningsSink.push({
      code: 'ENTITY_WINDOW_RESTORED_FROM_CACHE',
      message: `${restored} ${label} восстановлены из прежнего снимка — их окно синхронизации не удалось получить в этот заход.`
    });
  }
  return merged;
}

function toIsoSafe(ms) {
  return new Date(ms).toISOString();
}

/**
 * Запрос, отказ которого не блокирует синхронизацию: неизвестный маршрут,
 * отсутствующее поле, бизнес-ошибка 404 — всё превращается в пустой результат
 * и предупреждение, а не в исключение, останавливающее весь снимок.
 */
async function fetchOptional(task, warningCode, warningMessage) {
  try {
    return { value: await task(), warning: null };
  } catch (error) {
    return {
      value: null,
      warning: { code: warningCode, message: `${warningMessage}: ${error.message}` }
    };
  }
}

/**
 * История стадий или ответственных по одной сущности — с ограничением параллелизма.
 *
 * История заменяется ТОЛЬКО для сущностей, чей перезапрос удался в этот заход.
 * Для сущности, чей запрос упал (сеть, таймаут, временная недоступность маршрута),
 * подставляются её ПРЕЖНИЕ события из предыдущего снимка — иначе одна неудачная
 * попытка стирает достигнутые этапы сущности при следующей успешной синхронизации
 * целиком заменяющей снимок (см. предупреждение в reference/altech/src/sync/fullSync.js
 * про реальный инцидент: сделка потеряла событие «Договор подписан» именно так).
 */
async function fetchHistoryFor(client, entities, entityType, historyEntity, normalizer, previousEvents, limiter, unchangedEntities = []) {
  const entityKey = entityType === 'company' ? 'companyId' : 'dealId';
  const previousByEntity = new Map();
  for (const event of previousEvents || []) {
    // История ответственных хранится ОДНИМ общим массивом на обе воронки
    // (assigneeEvents), в отличие от истории стадий (companyStageEvents/
    // dealStageEvents уже разделены по массивам) — без фильтра по типу событие
    // сделки могло бы попасть в восстановление истории компании и наоборот.
    if (event?.entityType && event.entityType !== entityType) continue;
    // ?? event?.entityId — тот же общий массив несёт связь как {entityType,
    // entityId}, а не {companyId|dealId}, которые исторически ждёт стадийная ветка.
    const id = String(event?.[entityKey] ?? event?.entityId ?? '');
    if (!id) continue;
    if (!previousByEntity.has(id)) previousByEntity.set(id, []);
    previousByEntity.get(id).push(event);
  }

  // Сущности, не менявшиеся с прошлой УДАВШЕЙСЯ выборки истории (см. historySync
  // в fetchBitrixSnapshot) — их история переносится из прежнего снимка вообще БЕЗ
  // сетевого запроса. Это и есть инкрементальность: `entities` здесь — уже только
  // те, кто реально нуждается в перезапросе.
  const events = [];
  const skippedIds = [];
  for (const entity of unchangedEntities) {
    const id = String(entity?.id ?? '');
    if (!id) continue;
    skippedIds.push(id);
    events.push(...(previousByEntity.get(id) || []));
  }

  const results = await mapLimit(entities, limiter, async (entity) => {
    const id = String(entity?.id ?? entity?.ID ?? '');
    if (!id) return { rows: [], ok: false, id: null };
    try {
      const { rows } = await client.retry(() => client.listAll(historyEntity, { entityType, ownerId: id }));
      return { rows, ok: true, id };
    } catch (error) {
      return { rows: [], ok: false, id, error };
    }
  });

  const failedIds = [];
  const syncedIds = [];
  for (const result of results) {
    if (!result.ok) {
      if (result.id) {
        failedIds.push(result.id);
        events.push(...(previousByEntity.get(result.id) || []));
      }
      continue;
    }
    syncedIds.push(result.id);
    for (const row of result.rows) {
      const event = normalizer(row, { entityType, entityId: result.id });
      if (event) events.push(event);
    }
  }
  return { events, attempted: entities.length, failed: failedIds.length, syncedIds, skippedIds };
}

/**
 * Делит сущности на «нужен перезапрос истории» и «не менялась — можно пропустить».
 * Без updatedAt (или без прежней отметки) сущность ВСЕГДА идёт в перезапрос —
 * пропуск оправдан только когда есть чем доказать, что ничего не изменилось.
 */
function partitionByHistoryFreshness(entities, syncedMap) {
  const needsFetch = [];
  const unchanged = [];
  for (const entity of entities) {
    const synced = syncedMap[entity.id];
    if (synced && entity.updatedAt && synced === entity.updatedAt) unchanged.push(entity);
    else needsFetch.push(entity);
  }
  return { needsFetch, unchanged };
}

/**
 * Новая карта historySync: сущность считается синхронизированной только если
 * ОБА потока (история стадий и история ответственных) в этот заход удались —
 * частичный успех не двигает отметку, чтобы следующий заход честно повторил
 * недостающую половину, а не «забыл» о ней навсегда.
 */
function advanceHistorySync(previousMap, entities, stageResult, assigneeResult) {
  const stageSynced = new Set(stageResult?.syncedIds || []);
  const assigneeSynced = new Set(assigneeResult.syncedIds || []);
  const map = {};
  for (const entity of entities) {
    if (!entity.id) continue;
    const fullySynced = stageSynced.has(entity.id) && assigneeSynced.has(entity.id);
    if (fullySynced && entity.updatedAt) {
      map[entity.id] = entity.updatedAt;
    } else if (Object.hasOwn(previousMap, entity.id)) {
      // Не досинхронизировалась сейчас — сохраняем прежнюю отметку как есть
      // (не свежее, но и не потеряна): следующий заход повторит попытку.
      map[entity.id] = previousMap[entity.id];
    }
    // Иначе сущность новая и не досинхронизировалась — записи нет, и это верно:
    // следующий заход обязан попытаться снова, а не решить, что она «пропущена».
  }
  return map;
}

/** Справочник значений enum-поля: из описания поля, иначе — из фактических данных. */
function dictionaryFor(fieldsBody, fieldId, observedValues) {
  const description = findFieldDescription(fieldsBody, fieldId);
  const items = fieldId ? fieldItems(description) : [];
  if (items.length > 0) return items;
  // Резервный путь: портал не отдал описание поля (или оно не enum) —
  // собираем справочник из значений, реально встреченных в данных.
  return dictionaryFromValues(observedValues);
}

/**
 * Полный снимок из Битрикс24. Чистая функция: сеть → нормализованные данные.
 * Ничего не сохраняет — этим занимается вызывающая служба синхронизации.
 *
 * @param {object} options {now, client, previousSnapshot} — `client` инъектируется
 *   в проверках, чтобы они шли на замоканных ответах и никогда не касались сети.
 *   `previousSnapshot` подставляет `src/sync/service.js` — снимок с прошлого
 *   успешного запуска, откуда берутся события сущностей с неудавшимся перезапросом.
 */
export async function fetchBitrixSnapshot(options = {}) {
  const client = options.client || createBitrixClient();
  if (!client.ready) {
    const error = new Error('Ключ доступа к Битрикс24 не задан — синхронизация невозможна.');
    error.code = 'NO_API_KEY';
    throw error;
  }

  const previousSnapshot = options.previousSnapshot || {};
  const fields = resolvePortalFields(options.portalFields);
  const now = options.now || new Date();
  const fromMs = now.getTime() - config.bitrixHistoryYears * 365 * 24 * 60 * 60 * 1000;
  const warnings = [];

  // Категория сделок 3ДБИЛД не подтверждена — без неё нельзя отличить сделки
  // второй воронки от сделок другой воронки на том же портале. Синхронизация
  // сделок в этом случае не выполняется вовсе, чтобы не намешать чужие данные;
  // предупреждение указывает точную причину и что нужно для исправления.
  const dealFilter = fields.dealCategoryId ? { categoryId: fields.dealCategoryId } : null;
  if (!dealFilter) {
    warnings.push({
      code: 'DEAL_CATEGORY_PENDING',
      message: 'ID категории (воронки) сделок 3ДБИЛД не подтверждён аудитом портала — сделки не синхронизированы. См. reference/REQUIRED_INPUTS.md.'
    });
  }

  // Общие ограничители на весь заход: несколько параллельных веток ниже делят
  // один и тот же пул слотов, а не заводят каждая свой (см. createLimiter).
  const fetchLimiter = createLimiter(config.bitrixFetchConcurrency);
  const historyLimiter = createLimiter(config.bitrixHistoryConcurrency);

  const [companyResult, dealResult, usersRaw, companyFieldsBody, dealFieldsBody] = await Promise.all([
    fetchEntityWindowed(client, BITRIX_ENTITIES.company, {}, fromMs, now.getTime(), fetchLimiter),
    dealFilter
      ? fetchEntityWindowed(client, BITRIX_ENTITIES.deal, dealFilter, fromMs, now.getTime(), fetchLimiter)
      : Promise.resolve({ rows: [], warnings: [], failedRanges: [] }),
    fetchOptional(() => client.retry(() => client.listAll(BITRIX_ENTITIES.user, {})).then((r) => r.rows), 'USERS_FETCH_FAILED', 'Не удалось получить список сотрудников'),
    fetchOptional(() => client.retry(() => client.fetchOne(BITRIX_ENTITIES.companyFields)), 'COMPANY_FIELDS_FETCH_FAILED', 'Не удалось получить описание полей компании'),
    fetchOptional(() => client.retry(() => client.fetchOne(BITRIX_ENTITIES.dealFields)), 'DEAL_FIELDS_FETCH_FAILED', 'Не удалось получить описание полей сделки')
  ]);

  warnings.push(...companyResult.warnings, ...dealResult.warnings);
  if (usersRaw.warning) warnings.push(usersRaw.warning);
  if (companyFieldsBody.warning) warnings.push(companyFieldsBody.warning);
  if (dealFieldsBody.warning) warnings.push(dealFieldsBody.warning);

  let companies = companyResult.rows.map((row) => normalizeCompany(row, fields)).filter(Boolean);
  let deals = dealResult.rows.map((row) => normalizeDeal(row, fields)).filter(Boolean);

  // Окно, упёршееся в ошибку после исчерпания дробления, иначе стирает свои
  // сущности из снимка НАВСЕГДА — восстанавливаем их из прежнего снимка,
  // раз их собственный запрос в этот заход не удался (не «сущность удалена»).
  companies = restoreMissingFromPrevious(companies, previousSnapshot.companies, companyResult.failedRanges, warnings, 'компаний');
  deals = restoreMissingFromPrevious(deals, previousSnapshot.deals, dealResult.failedRanges, warnings, 'сделок');

  // Инкрементальность: сущность, чей updatedAt не изменился с прошлой УДАВШЕЙСЯ
  // синхронизации её истории (historySync прежнего снимка), не перезапрашивается
  // вовсе — иначе каждый заход (по умолчанию раз в 10 минут) заново опрашивает
  // историю КАЖДОЙ компании и сделки, что не масштабируется на реальный портал
  // (тысячи сущностей × 2 потока истории на каждый тик).
  const previousHistorySync = previousSnapshot.historySync || {};
  const companyHistoryPlan = partitionByHistoryFreshness(companies, previousHistorySync.companies || {});
  const dealHistoryPlan = partitionByHistoryFreshness(deals, previousHistorySync.deals || {});

  // История стадий и история ответственных — необязательные потоки (см. РАЗДЕЛ 1).
  // `fetchHistoryFor` ловит отказ КАЖДОЙ сущности внутри себя и никогда не бросает
  // исключение сама — `fetchOptional` здесь ловит только катастрофу самого
  // механизма (например, ошибку в mapLimit), а НЕ переиспользуется для решения
  // «доступен ли маршрут вообще»: если он не существует на портале, все попытки
  // просто попадают в `failed`, а промис благополучно резолвится. Доступность
  // определяется явно, ниже, по соотношению `failed`/`attempted` (уже только
  // среди тех, кого реально пытались перезапросить в этот заход).
  const [companyStages, dealStages, companyAssignee, dealAssignee] = await Promise.all([
    fetchOptional(
      () => fetchHistoryFor(client, companyHistoryPlan.needsFetch, 'company', BITRIX_ENTITIES.stageHistory, normalizeStageEvent, previousSnapshot.companyStageEvents, historyLimiter, companyHistoryPlan.unchanged),
      'COMPANY_STAGE_HISTORY_UNAVAILABLE',
      'История стадий компаний недоступна — воронка компаний считается только по текущей стадии, без докраски пропущенных этапов из истории'
    ),
    fetchOptional(
      () => fetchHistoryFor(client, dealHistoryPlan.needsFetch, 'deal', BITRIX_ENTITIES.stageHistory, normalizeStageEvent, previousSnapshot.dealStageEvents, historyLimiter, dealHistoryPlan.unchanged),
      'DEAL_STAGE_HISTORY_UNAVAILABLE',
      'История стадий сделок недоступна — воронка сделок считается только по текущей стадии, без докраски пропущенных этапов из истории'
    ),
    fetchHistoryFor(client, companyHistoryPlan.needsFetch, 'company', BITRIX_ENTITIES.assigneeHistory, normalizeAssigneeEvent, previousSnapshot.assigneeEvents, historyLimiter, companyHistoryPlan.unchanged),
    fetchHistoryFor(client, dealHistoryPlan.needsFetch, 'deal', BITRIX_ENTITIES.assigneeHistory, normalizeAssigneeEvent, previousSnapshot.assigneeEvents, historyLimiter, dealHistoryPlan.unchanged)
  ]);

  // Отметка продвигается только для сущности, у которой удались ОБА потока —
  // частичный успех не должен навсегда "забыть" недостающую половину.
  const historySync = {
    companies: advanceHistorySync(previousHistorySync.companies || {}, companies, companyStages.value, companyAssignee),
    deals: advanceHistorySync(previousHistorySync.deals || {}, deals, dealStages.value, dealAssignee)
  };

  if (companyStages.warning) warnings.push(companyStages.warning);
  if (dealStages.warning) warnings.push(dealStages.warning);

  const companyStageEvents = companyStages.value?.events || [];
  const dealStageEvents = dealStages.value?.events || [];
  const assigneeEvents = [...companyAssignee.events, ...dealAssignee.events];
  const assigneeAttempted = companyAssignee.attempted + dealAssignee.attempted;
  const assigneeFailed = companyAssignee.failed + dealAssignee.failed;
  // Ноль попыток (пустой снимок компаний и сделок) не говорит ничего о доступности
  // маршрута — не объявляем его недоступным на пустых данных. Провал КАЖДОЙ
  // попытки при наличии хотя бы одной сущности — почти наверняка означает, что
  // маршрута просто нет на этом портале, а не единичный сетевой сбой.
  const assigneeHistoryAvailable = assigneeAttempted === 0 || assigneeFailed < assigneeAttempted;

  if (assigneeAttempted > 0 && assigneeFailed === assigneeAttempted) {
    warnings.push({
      code: 'ASSIGNEE_HISTORY_UNAVAILABLE',
      message: 'История ответственных недоступна — этапы отнесены текущему ответственному, а не тому, кто вёл сущность на момент прохождения'
    });
  } else if (assigneeFailed > 0) {
    warnings.push({
      code: 'ASSIGNEE_HISTORY_PARTIAL',
      message: `История ответственных не получена для ${assigneeFailed} из ${assigneeAttempted} сущностей.`
    });
  }

  if (companyStages.value && companyStages.value.failed > 0) {
    warnings.push({ code: 'COMPANY_STAGE_HISTORY_PARTIAL', message: `История стадий не получена для ${companyStages.value.failed} из ${companyStages.value.attempted} компаний — прежние данные по ним не заменяются.` });
  }
  if (dealStages.value && dealStages.value.failed > 0) {
    warnings.push({ code: 'DEAL_STAGE_HISTORY_PARTIAL', message: `История стадий не получена для ${dealStages.value.failed} из ${dealStages.value.attempted} сделок — прежние данные по ним не заменяются.` });
  }

  const managers = (usersRaw.value || []).map(normalizeUser).filter(Boolean);

  const sources = dictionaryFor(
    companyFieldsBody.value,
    fields.companySourceField,
    companies.map((c) => c.sourceId)
  );
  const kevFormats = dictionaryFor(
    dealFieldsBody.value,
    fields.dealKevFormatField,
    deals.map((d) => d.kevFormatId)
  );

  // Справочник стадий как есть, без имён (у нас нет отдельного каталога стадий
  // портала — только то, что фактически встретилось на компаниях/сделках):
  // dictionaryFromValues уже возвращает {id, name} с именем, равным ID.
  const companyStagesDictionary = dictionaryFromValues(companies.map((c) => c.currentStageId));
  const dealStagesDictionary = dictionaryFromValues(deals.map((d) => d.currentStageId));

  const pendingFields = pendingAuditFields(options.portalFields);
  if (pendingFields.length > 0) {
    warnings.push({
      code: 'PORTAL_FIELDS_PENDING',
      message: `${pendingFields.length} пользовательских полей не подтверждены аудитом портала (${pendingFields.map((f) => f.description).join('; ')}).`
    });
  }

  const companiesWithoutSource = companies.filter((c) => !c.sourceId).length;
  const dealsWithoutSource = deals.filter((d) => !d.sourceId).length;
  const dealsWithoutKev = deals.filter((d) => !d.kevFormatId).length;
  const dealsWithoutCompany = deals.filter((d) => !d.companyId).length;

  // Строковые сводки для панели диагностики — та же форма, что и у демо-источника
  // (src/demo/generator.js), чтобы состояние синхронизации выглядело одинаково
  // независимо от того, какой источник данных сейчас активен.
  const dataQuality = {
    companiesWithoutSource,
    dealsWithoutSource,
    dealsWithoutKev,
    dealsWithoutCompany,
    assigneeHistoryAvailable,
    // Та же форма {code, message}, что и у верхнеуровневого warnings — единый контракт
    // на случай, если этот список когда-нибудь пройдёт через тот же рендерер
    // предупреждений (public/app.js#renderMessages читает warning.message).
    warnings: [
      { code: 'SOURCE_MISSING', message: `Без базы/источника: компаний ${companiesWithoutSource}, сделок ${dealsWithoutSource} — попадут в «Источник не указан».` },
      { code: 'KEV_MISSING', message: `Без формата КЭВ: сделок ${dealsWithoutKev} — попадут в «Не указано».` }
    ]
  };

  return {
    companies,
    deals,
    companyStageEvents,
    dealStageEvents,
    assigneeEvents,
    managers,
    sources,
    kevFormats,
    stages: { companies: companyStagesDictionary, deals: dealStagesDictionary },
    portalTimezone: config.portalTimezone,
    dataQuality,
    historySync,
    warnings
  };
}
