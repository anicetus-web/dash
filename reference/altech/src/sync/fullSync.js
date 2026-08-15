import { DEAL_CATEGORY_2D_BIM, config } from '../config.js';
import { BitrixClient, statusEntityId, statusId, statusName } from '../bitrix/client.js';
import { DEAL_FIELD_IDS, normalizeDeal, normalizeStageEvent, stripNeedPrefix } from '../bitrix/normalize.js';
import { store } from '../storage/jsonStore.js';
import { dateOrNull } from '../lib/records.js';
import { STAGE_IDS, canonicalStageId } from '../domain/stages.js';

// Признак деградации синка: выборка сделок шла с ошибками (троттлинг/таймауты/сетевые сбои прокси)
// и результат не годится заменять текущий снапшот. Случаи: (1) синк вернул 0 сделок — пустотой
// НИКОГДА не затираем кэш; (2) при живом кэше (prev>0) ЛЮБОЕ сокращение числа сделок на фоне
// warnings трактуем как частичную потерю (закрывает тихую просадку 25-39%, что раньше проходила
// гвард на пороге 0.6). Валидный синк БЕЗ warnings — не деградация, даже если сделок стало меньше
// (реальное уменьшение). Первый синк (prev=0) с непустым результатом — наполнение, не деградация.
export function isDegradedSync(previousDealCount, newDealCount, hadFetchWarnings) {
  if (!hadFetchWarnings) return false;
  if (newDealCount === 0) return true;
  return previousDealCount > 0 && newDealCount < previousDealCount;
}

// Удержание сделок при ЧАСТИЧНОМ сбое выборки, проскочившем гвард isDegradedSync (число сделок не
// упало, т.к. новые сделки замаскировали пропажу упавшего окна). При наличии предупреждений
// возвращаем прежние сделки, не пришедшие в этот заход (по id) — иначе «дыра» в окне временно
// выкидывает подписанные договоры и квартальный факт скачет. Без предупреждений — пусто: чистой
// выборке доверяем полностью (реально удалённые сделки должны исчезать). Работает и с raw-, и с
// нормализованными сделками (rawDealId читает id/ID у обеих форм).
export function retainedDealsForPartialSync(previousDeals, fetchedDeals, hadFetchWarnings) {
  const fetchedIds = new Set((fetchedDeals || []).map(rawDealId));
  return (previousDeals || []).filter((deal) => {
    if (fetchedIds.has(rawDealId(deal))) return false;
    // «Выигранные» (Договор подписан) — терминальные: удерживаем ВСЕГДА, даже на чистом синке, т.к.
    // это старые сделки, которых выборка от 2026-01-01 достаёт только через flaky-окно «по обновлению»,
    // и падение окна выкидывает подписанный договор из квартального факта. Прочие сделки удерживаем
    // только при предупреждениях (частичный сбой); чистой выборке доверяем (реальные удаления исчезают).
    const isWon = canonicalStageId(String(deal.stageId || deal.STAGE_ID || '')) === STAGE_IDS.contractSigned;
    return isWon || hadFetchWarnings;
  });
}

// Слияние истории стадий: у сделки, чей перезапрос истории УСПЕШЕН (id в succeededDealIds), берём
// новые события (они уже в newRows); у остальных сделок текущего набора (currentDealIds) — сохраняем
// прежние события. Так падение перезапроса истории по конкретной сделке НЕ обнуляет её события
// (иначе теряется событие «Договор подписан» → сделка выпадает из квартального факта). События сделок,
// выбывших из currentDealIds, отбрасываются (сделка больше не в наборе).
export function mergeStageEvents(previousEvents, newRows, currentDealIds, succeededDealIds) {
  return [
    ...(previousEvents || []).filter((event) => (
      currentDealIds.has(String(event.dealId)) && !succeededDealIds.has(String(event.dealId))
    )),
    ...(newRows || [])
  ];
}

function splitIsoWindows(fromIso, toIso, days = 31) {
  const windows = [];
  let cursor = new Date(fromIso).getTime();
  const end = new Date(toIso).getTime();
  const step = days * 24 * 60 * 60 * 1000;
  while (Number.isFinite(cursor) && cursor <= end) {
    const next = Math.min(cursor + step - 1, end);
    windows.push({ from: new Date(cursor).toISOString(), to: new Date(next).toISOString() });
    cursor = next + 1;
  }
  return windows;
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function userName(user) {
  return user.name || user.fullName || user.NAME || user.FULL_NAME
    || [user.lastName || user.LAST_NAME, user.firstName || user.FIRST_NAME].filter(Boolean).join(' ')
    || user.email || user.EMAIL
    || `ID ${user.id || user.ID}`;
}

function sourceRows(statuses) {
  return statuses
    .filter((item) => statusEntityId(item).toUpperCase() === 'SOURCE')
    .map((item) => ({ id: statusId(item), name: statusName(item) }))
    .filter((item) => item.id && item.name);
}

// Справочник стадий категории 78 из crm.status: ENTITY_ID = DEAL_STAGE_78, STATUS_ID вида «C78:NEW».
// Даёт имена стадиям, которых нет в src/domain/stages.js: C78:NEW «Заявки маркетинг», LOSE-стадии, будущие.
export function stageRows(statuses) {
  const entity = `DEAL_STAGE_${DEAL_CATEGORY_2D_BIM}`;
  return statuses
    .filter((item) => statusEntityId(item).toUpperCase() === entity)
    .map((item) => ({ id: statusId(item), name: statusName(item) }))
    .filter((item) => item.id && item.name);
}

async function fetchDealFields(client) {
  const body = await client.request('/deals/fields', { timeoutMs: 30000 });
  return body.data?.fields || {};
}

function findSourceOpBimField(fields) {
  return Object.entries(fields)
    .map(([id, field]) => ({ id, ...field }))
    .find((field) => String(field.label || '').trim().toLowerCase() === 'источник оп бим')
    || null;
}

function normalizeFieldLabel(field) {
  return String(field.label || field.title || field.name || '').trim().toLowerCase().replace(/ё/g, 'е');
}

function fieldList(fields) {
  return Object.entries(fields).map(([id, field]) => ({ id, ...field }));
}

// Точный заголовок «Причина отказа покупки 2Dbim» (ТЗ), затем — эвристика по «причина…отказ».
function findFailureReasonField(fields) {
  const list = fieldList(fields);
  return list.find((field) => normalizeFieldLabel(field) === 'причина отказа покупки 2dbim')
    || list.find((field) => {
      const label = normalizeFieldLabel(field);
      return label.includes('причин') && (label.includes('отказ') || label.includes('проигр') || label.includes('потер'));
    })
    || null;
}

// Тип клиента = поле «Основной ОКВЭД» (ТЗ), затем — эвристика по «оквэд».
function findClientTypeField(fields) {
  const list = fieldList(fields);
  return list.find((field) => normalizeFieldLabel(field) === 'основной оквэд')
    || list.find((field) => normalizeFieldLabel(field).includes('оквэд'))
    || null;
}

function sourceRowsFromField(field) {
  return (field?.items || [])
    .map((item) => ({
      id: String(item.ID || item.id || ''),
      name: String(item.VALUE || item.value || '')
    }))
    .filter((item) => item.id && item.name);
}

function itemMapFromField(field) {
  return Object.fromEntries(sourceRowsFromField(field).map((item) => [item.id, item.name]));
}

function rawDealId(deal) {
  return String(deal.id || deal.ID || '');
}

function normalizedDealUpdatedAt(deal) {
  return dateOrNull(deal.updatedAt || deal.UPDATED_AT || deal.DATE_MODIFY || deal.modifiedTime || deal.MODIFIED_TIME);
}

async function fetchDeals(client, fromIso, toIso) {
  // Меньшее стартовое окно (14 дн.) = меньше сделок в одном батче → реже упираемся в 15с-лимит прокси.
  const windows = splitIsoWindows(fromIso, toIso, 14);
  const tasks = windows.flatMap((window) => [
    { field: 'updatedAt', window },
    { field: 'createdAt', window }
  ]);

  const results = await mapLimit(tasks, 4, (task) => fetchDealTask(client, task, toIso));

  const byId = new Map();
  const warnings = [];
  for (const result of results) {
    for (const deal of result.rows || []) byId.set(String(deal.id || deal.ID), deal);
    warnings.push(...(result.warnings || []));
  }
  return { deals: [...byId.values()], warnings };
}

function dealTaskFilter(task, toIso) {
  if (task.field === 'updatedAt') {
    return {
      categoryId: DEAL_CATEGORY_2D_BIM,
      createdAt: { $lte: toIso },
      updatedAt: { $gte: task.window.from, $lte: task.window.to }
    };
  }
  return {
    categoryId: DEAL_CATEGORY_2D_BIM,
    createdAt: { $gte: task.window.from, $lte: task.window.to }
  };
}

function splitWindow(window) {
  const fromMs = new Date(window.from).getTime();
  const toMs = new Date(window.to).getTime();
  const middle = Math.floor((fromMs + toMs) / 2);
  return [
    { from: new Date(fromMs).toISOString(), to: new Date(middle).toISOString() },
    { from: new Date(middle + 1).toISOString(), to: new Date(toMs).toISOString() }
  ];
}

// Таймаут может прийти как наш AbortError (API_TIMEOUT), так и от VibeCode-прокси, у которого свой
// лимит ~15с на батч к Битриксу («Bitrix24 batch timed out after 15s») — распознаём и то, и другое,
// чтобы дробить окно и ретраить (иначе большие окна стабильно теряются без повторов).
export function isTimeoutError(error) {
  return error.code === 'API_TIMEOUT' || /tim(?:e|ed)\s*out|timeout/i.test(String(error.message || ''));
}

// Ретраибельные (дробим окно + бэкофф): таймауты + транзиентные ошибки прокси/сети.
// Коды сети undici лежат в error.code, а у «fetch failed» — в error.cause.code.
// HTTP 5xx приходят из client.js с числовым error.status (см. client.js:37-42).
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET']);
export function isRetryableError(error) {
  if (!error) return false;
  if (isTimeoutError(error)) return true;
  if (Number(error.status) >= 500) return true;
  const code = error.code || error.cause?.code;
  if (code && RETRYABLE_CODES.has(code)) return true;
  const message = String(error.message || '');
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|503|502|504/i.test(message);
}

async function fetchDealTask(client, task, toIso, depth = 0) {
  try {
    const rows = await client.search('deals', {
      filter: dealTaskFilter(task, toIso),
      sort: { updatedAt: 'desc' },
      limit: 5000
    }, { timeoutMs: 35000 });
    return { rows, warnings: [] };
  } catch (error) {
    const fromMs = new Date(task.window.from).getTime();
    const toMs = new Date(task.window.to).getTime();
    const canSplit = depth < 6 && toMs - fromMs > 24 * 60 * 60 * 1000;
    if (isRetryableError(error) && canSplit) {
      // Бэкофф перед дроблением: 0.5с → 1с → 2с … (капим 4с), даём прокси/Битриксу «отпустить».
      const backoffMs = Math.min(4000, 500 * 2 ** depth);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      const children = [];
      for (const window of splitWindow(task.window)) {
        children.push(await fetchDealTask(client, { ...task, window }, toIso, depth + 1));
      }
      return {
        rows: children.flatMap((item) => item.rows || []),
        warnings: children.flatMap((item) => item.warnings || [])
      };
    }
    return {
      rows: [],
      warnings: [{
        code: error.code || 'DEALS_SYNC_ERROR',
        message: error.message,
        field: task.field,
        from: task.window.from,
        to: task.window.to
      }]
    };
  }
}

async function fetchStageHistoryForDeals(client, deals) {
  let completed = 0;
  const results = await mapLimit(deals, 8, async (deal) => {
    const id = rawDealId(deal);
    if (!id) return { rows: [] };
    try {
      const rows = await client.list('stage-history', {
        categoryId: DEAL_CATEGORY_2D_BIM,
        ownerId: id
      }, { timeoutMs: 15000 });
      completed += 1;
      if (completed % 50 === 0) console.error(`stage-history synced ${completed}/${deals.length}`);
      return { rows, dealId: id };
    } catch (error) {
      completed += 1;
      return {
        rows: [],
        dealId: id,
        error: {
          code: error.code || 'STAGE_HISTORY_DEAL_SYNC_ERROR',
          message: error.message,
          dealId: id
        }
      };
    }
  });

  const byId = new Map();
  const warnings = [];
  const succeededDealIds = [];
  for (const result of results) {
    for (const row of result.rows || []) {
      if (Number(row.categoryId || row.CATEGORY_ID) !== DEAL_CATEGORY_2D_BIM) continue;
      byId.set(String(row.id || row.ID), row);
    }
    if (result.error) warnings.push(result.error);
    else if (result.dealId) succeededDealIds.push(result.dealId);
  }
  return { rows: [...byId.values()], warnings, succeededDealIds };
}

// Сделки в финальной стадии «Договор подписан», у которых в кэше НЕТ ни одного события подписания, —
// данные рассинхронены (событие потеряно при сбойном перезапросе или не собрано). Такую историю надо
// перезапросить принудительно, даже если сделка давно не менялась: иначе она выпадает из квартального
// факта и не восстанавливается (selectHistoryBatch перезапрашивает только новые/недавно менявшиеся).
export function dealsMissingSignedEvent(deals, stageEvents) {
  const signedEventDealIds = new Set(
    (stageEvents || [])
      .filter((event) => canonicalStageId(event.stageId) === STAGE_IDS.contractSigned)
      .map((event) => String(event.dealId))
  );
  return (deals || []).filter((deal) => {
    const id = rawDealId(deal);
    if (!id) return false;
    const stage = canonicalStageId(String(deal.stageId || deal.STAGE_ID || ''));
    return stage === STAGE_IDS.contractSigned && !signedEventDealIds.has(id);
  });
}

function selectHistoryBatch(deals, currentSnapshot, now) {
  const batchSize = Number(process.env.BI_HISTORY_BATCH_SIZE || 300);
  if (batchSize <= 0) return [];

  const synced = new Set(currentSnapshot.historySync?.syncedDealIds || []);
  const lookbackMs = config.syncLookbackDays * 24 * 60 * 60 * 1000;
  const changedSince = new Date(now.getTime() - lookbackMs);
  // Приоритетное самолечение: подписанные сделки, потерявшие событие подписания (см. выше).
  const healIds = new Set(dealsMissingSignedEvent(deals, currentSnapshot.stageEvents).map(rawDealId));
  const changed = [];
  const pending = [];
  const heal = [];

  for (const deal of deals) {
    const id = rawDealId(deal);
    if (!id) continue;
    if (!synced.has(id)) {
      pending.push(deal);
      continue;
    }
    if (healIds.has(id)) {
      heal.push(deal);
      continue;
    }
    const updatedAt = normalizedDealUpdatedAt(deal);
    if (updatedAt && updatedAt >= changedSince) changed.push(deal);
  }

  const selected = new Map();
  const candidates = [...pending, ...heal, ...changed];
  for (const deal of candidates) {
    if (selected.size >= batchSize) break;
    selected.set(rawDealId(deal), deal);
  }
  return [...selected.values()];
}

export async function fullSync(options = {}) {
  const client = new BitrixClient(options);
  const now = options.now || new Date();
  const fromIso = new Date(options.from || process.env.BI_FULL_SYNC_FROM || '2026-01-01T00:00:00.000Z').toISOString();
  const toIso = now.toISOString();
  const currentSnapshot = await store.getSnapshot();
  const resetHistory = options.resetHistory || process.env.BI_HISTORY_RESET === '1';
  const historySnapshot = resetHistory
    ? { ...currentSnapshot, stageEvents: [], historySync: { syncedDealIds: [], complete: false, lastBatchAt: null } }
    : currentSnapshot;

  const [statuses, users, fields, dealResult] = await Promise.all([
    client.list('statuses', { limit: 5000 }),
    client.list('users', { limit: 5000 }),
    fetchDealFields(client),
    fetchDeals(client, fromIso, toIso)
  ]);

  // Троттленный/частичный синк не должен затирать здоровый кэш — сохраняем прежний снапшот.
  if (isDegradedSync(currentSnapshot.deals?.length || 0, dealResult.deals.length, dealResult.warnings.length > 0)) {
    const snapshot = await store.replaceSnapshot({
      ...currentSnapshot,
      sync: {
        status: 'idle',
        lastStartedAt: new Date().toISOString(),
        lastSuccessAt: currentSnapshot.sync?.lastSuccessAt || null,
        lastError: null,
        warnings: [
          { code: 'DEGRADED_SYNC_SKIPPED', message: `Throttled sync fetched ${dealResult.deals.length}/${currentSnapshot.deals.length} deals — kept previous cache.` },
          ...dealResult.warnings
        ]
      }
    });
    console.error(`fullSync: degraded fetch ${dealResult.deals.length}/${currentSnapshot.deals.length} deals — snapshot preserved`);
    return {
      dealsCount: snapshot.deals.length,
      stageEventsCount: snapshot.stageEvents.length,
      historySyncedDeals: snapshot.historySync?.syncedDealIds?.length || 0,
      historyComplete: Boolean(snapshot.historySync?.complete),
      degradedSkipped: true,
      warnings: snapshot.sync.warnings
    };
  }

  // retainedDeals уже нормализованы (из прежнего снапшота), их история — в кэше (см.
  // retainedDealsForPartialSync). Добавляем их в набор, чтобы дыра упавшего окна не роняла факт.
  const fetchedRawIds = new Set(dealResult.deals.map(rawDealId));
  const retainedDeals = retainedDealsForPartialSync(currentSnapshot.deals, dealResult.deals, dealResult.warnings.length > 0);
  const retainedDealIds = new Set(retainedDeals.map(rawDealId));

  const historyBatch = selectHistoryBatch(dealResult.deals, historySnapshot, now);
  const historyResult = await fetchStageHistoryForDeals(client, historyBatch);
  const currentDealIds = new Set([...fetchedRawIds, ...retainedDealIds]);
  const previousEvents = historySnapshot.stageEvents || [];
  const normalizedHistoryRows = historyResult.rows.map(normalizeStageEvent);
  // Заменяем историю ТОЛЬКО у сделок с УСПЕШНЫМ перезапросом. У сделок, чей перезапрос упал
  // (STAGE_HISTORY_DEAL_SYNC_ERROR), прежние события СОХРАНЯЕМ — иначе недавно подписанная сделка
  // теряет событие «Договор подписан» и выпадает из квартального факта (баг: сделка 142772, −3,6 млн).
  const succeededHistoryDealIds = new Set((historyResult.succeededDealIds || []).map(String));
  const stageEvents = mergeStageEvents(previousEvents, normalizedHistoryRows, currentDealIds, succeededHistoryDealIds);
  const syncedDealIds = new Set(
    (historySnapshot.historySync?.syncedDealIds || []).filter((id) => currentDealIds.has(String(id)))
  );
  for (const id of historyResult.succeededDealIds || []) syncedDealIds.add(String(id));
  const historyComplete = syncedDealIds.size >= (dealResult.deals.length + retainedDeals.length);
  const historyWarnings = [];
  if (!historyComplete) {
    historyWarnings.push({
      code: 'HISTORY_BACKFILL_IN_PROGRESS',
      message: `Stage history backfill is in progress: ${syncedDealIds.size}/${dealResult.deals.length} deals synced.`
    });
  }
  if (historyResult.warnings.length) {
    historyWarnings.push({
      code: 'STAGE_HISTORY_BATCH_ERRORS',
      message: `${historyResult.warnings.length} deal history requests failed in this batch.`
    });
  }

  const sourceFieldConfig = findSourceOpBimField(fields);
  const failureReasonFieldConfig = findFailureReasonField(fields);
  const clientTypeFieldConfig = findClientTypeField(fields);
  const sourceField = sourceFieldConfig?.id || null;
  const failureReasonField = failureReasonFieldConfig?.id || null;
  const failureReasonItems = itemMapFromField(failureReasonFieldConfig);
  const clientTypeField = clientTypeFieldConfig?.id || null;
  const clientTypeItems = itemMapFromField(clientTypeFieldConfig);
  // Словари новых enum-полей (ID→текст) из /deals/fields — для резолва в normalizeDeal и списков фильтров.
  const newFieldItems = {
    objectType: itemMapFromField(fields[DEAL_FIELD_IDS.objectType]),
    need: itemMapFromField(fields[DEAL_FIELD_IDS.need]),
    // Два поля роли с разными наборами вариантов — объединяем словари (ID вариантов в Битриксе уникальны).
    projectRole: {
      ...itemMapFromField(fields[DEAL_FIELD_IDS.projectRoleOld]),
      ...itemMapFromField(fields[DEAL_FIELD_IDS.projectRoleNew])
    },
    turnover: itemMapFromField(fields[DEAL_FIELD_IDS.turnover])
  };
  // Готовые списки значений для фильтров (В2-В4). Потребности — без технического префикса «(2D-BIM) ».
  const uniq = (list) => [...new Set(list.filter(Boolean))];
  const enumDictionaries = {
    objectType: uniq(Object.values(newFieldItems.objectType)),
    need: uniq(Object.values(newFieldItems.need).map(stripNeedPrefix)),
    projectRole: uniq(Object.values(newFieldItems.projectRole)),
    turnover: uniq(Object.values(newFieldItems.turnover)),
    clientType: uniq(Object.values(clientTypeItems))
  };
  const sources = sourceField
    ? sourceRowsFromField(sourceFieldConfig)
    : sourceRows(statuses);
  const stages = stageRows(statuses);
  const snapshot = await store.replaceSnapshot({
    sourceField,
    failureReasonField,
    clientTypeField,
    deals: [
      ...dealResult.deals.map((deal) => normalizeDeal(deal, { sourceField, failureReasonField, failureReasonItems, clientTypeField, clientTypeItems, newFieldItems })),
      ...retainedDeals
    ],
    stageEvents,
    stages,
    enumDictionaries,
    managers: users.map((user) => ({ id: String(user.id || user.ID), name: userName(user), raw: user })),
    sources,
    historySync: {
      syncedDealIds: [...syncedDealIds],
      lastBatchAt: new Date().toISOString(),
      complete: historyComplete
    },
    sync: {
      status: 'idle',
      lastStartedAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastError: null,
      warnings: [
        !sourceField ? { code: 'SOURCE_OP_BIM_FIELD_PENDING', message: 'Custom source field discovery is pending; using SOURCE_ID fallback.' } : null,
        !failureReasonField ? { code: 'FAILURE_REASON_FIELD_PENDING', message: 'Failure reason field discovery is pending; rejection reasons may be grouped as unspecified.' } : null,
        !clientTypeField ? { code: 'CLIENT_TYPE_FIELD_PENDING', message: 'Client type field («Основной ОКВЭД») discovery is pending.' } : null,
        ...dealResult.warnings,
        ...historyWarnings
      ].filter(Boolean)
    }
  });

  return {
    dealsCount: snapshot.deals.length,
    stageEventsCount: snapshot.stageEvents.length,
    historySyncedDeals: snapshot.historySync.syncedDealIds.length,
    historyComplete: snapshot.historySync.complete,
    warnings: snapshot.sync.warnings
  };
}
