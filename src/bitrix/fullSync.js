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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Дробление окна пополам с бэкоффом при повторяемой ошибке — тот же приём,
 * что и в референсе Altech (`reference/altech/src/sync/fullSync.js`): большое
 * окно, упёршееся в лимит прокси на батч, распадается на два меньших, пока
 * не пройдёт или не упрётся в предохранитель глубины.
 */
async function fetchWindow(client, entity, buildFilter, window, depth = 0) {
  try {
    const { rows, truncated } = await client.searchAll(entity, { filter: buildFilter(window) });
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
async function fetchEntityWindowed(client, entity, extraFilter, fromMs, toMs) {
  const ranges = windows(fromMs, toMs, config.bitrixWindowDays);
  const tasks = ranges.flatMap((window) => [
    { window, buildFilter: (w) => ({ ...extraFilter, createdAt: { $lte: toIsoSafe(toMs) }, updatedAt: { $gte: w.from, $lte: w.to } }) },
    { window, buildFilter: (w) => ({ ...extraFilter, createdAt: { $gte: w.from, $lte: w.to } }) }
  ]);

  const results = await mapLimit(tasks, config.bitrixFetchConcurrency, (task) => fetchWindow(client, entity, task.buildFilter, task.window));

  const byId = new Map();
  const warnings = [];
  for (const result of results) {
    for (const row of result.rows) {
      const id = String(row?.id ?? row?.ID ?? '');
      if (id) byId.set(id, row);
    }
    warnings.push(...result.warnings);
  }
  return { rows: [...byId.values()], warnings };
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
async function fetchHistoryFor(client, entities, entityType, historyEntity, normalizer, previousEvents) {
  const entityKey = entityType === 'company' ? 'companyId' : 'dealId';
  const previousByEntity = new Map();
  for (const event of previousEvents || []) {
    const id = String(event?.[entityKey] ?? '');
    if (!id) continue;
    if (!previousByEntity.has(id)) previousByEntity.set(id, []);
    previousByEntity.get(id).push(event);
  }

  const results = await mapLimit(entities, config.bitrixHistoryConcurrency, async (entity) => {
    const id = String(entity?.id ?? entity?.ID ?? '');
    if (!id) return { rows: [], ok: false, id: null };
    try {
      const { rows } = await client.listAll(historyEntity, { entityType, ownerId: id });
      return { rows, ok: true, id };
    } catch (error) {
      return { rows: [], ok: false, id, error };
    }
  });

  const events = [];
  const failedIds = [];
  for (const result of results) {
    if (!result.ok) {
      if (result.id) {
        failedIds.push(result.id);
        events.push(...(previousByEntity.get(result.id) || []));
      }
      continue;
    }
    for (const row of result.rows) {
      const event = normalizer(row, { entityType, entityId: result.id });
      if (event) events.push(event);
    }
  }
  return { events, attempted: entities.length, failed: failedIds.length };
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

  const [companyResult, dealResult, usersRaw, companyFieldsBody, dealFieldsBody] = await Promise.all([
    fetchEntityWindowed(client, BITRIX_ENTITIES.company, {}, fromMs, now.getTime()),
    dealFilter
      ? fetchEntityWindowed(client, BITRIX_ENTITIES.deal, dealFilter, fromMs, now.getTime())
      : Promise.resolve({ rows: [], warnings: [] }),
    fetchOptional(() => client.listAll(BITRIX_ENTITIES.user, {}).then((r) => r.rows), 'USERS_FETCH_FAILED', 'Не удалось получить список сотрудников'),
    fetchOptional(() => client.fetchOne(BITRIX_ENTITIES.companyFields), 'COMPANY_FIELDS_FETCH_FAILED', 'Не удалось получить описание полей компании'),
    fetchOptional(() => client.fetchOne(BITRIX_ENTITIES.dealFields), 'DEAL_FIELDS_FETCH_FAILED', 'Не удалось получить описание полей сделки')
  ]);

  warnings.push(...companyResult.warnings, ...dealResult.warnings);
  if (usersRaw.warning) warnings.push(usersRaw.warning);
  if (companyFieldsBody.warning) warnings.push(companyFieldsBody.warning);
  if (dealFieldsBody.warning) warnings.push(dealFieldsBody.warning);

  const companies = companyResult.rows.map((row) => normalizeCompany(row, fields)).filter(Boolean);
  const deals = dealResult.rows.map((row) => normalizeDeal(row, fields)).filter(Boolean);

  // История стадий и история ответственных — необязательные потоки (см. РАЗДЕЛ 1).
  // `fetchHistoryFor` ловит отказ КАЖДОЙ сущности внутри себя и никогда не бросает
  // исключение сама — `fetchOptional` здесь ловит только катастрофу самого
  // механизма (например, ошибку в mapLimit), а НЕ переиспользуется для решения
  // «доступен ли маршрут вообще»: если он не существует на портале, все попытки
  // просто попадают в `failed`, а промис благополучно резолвится. Доступность
  // определяется явно, ниже, по соотношению `failed`/`attempted`.
  const [companyStages, dealStages, companyAssignee, dealAssignee] = await Promise.all([
    fetchOptional(
      () => fetchHistoryFor(client, companies, 'company', BITRIX_ENTITIES.stageHistory, normalizeStageEvent, previousSnapshot.companyStageEvents),
      'COMPANY_STAGE_HISTORY_UNAVAILABLE',
      'История стадий компаний недоступна — воронка компаний считается только по текущей стадии, без докраски пропущенных этапов из истории'
    ),
    fetchOptional(
      () => fetchHistoryFor(client, deals, 'deal', BITRIX_ENTITIES.stageHistory, normalizeStageEvent, previousSnapshot.dealStageEvents),
      'DEAL_STAGE_HISTORY_UNAVAILABLE',
      'История стадий сделок недоступна — воронка сделок считается только по текущей стадии, без докраски пропущенных этапов из истории'
    ),
    fetchHistoryFor(client, companies, 'company', BITRIX_ENTITIES.assigneeHistory, normalizeAssigneeEvent),
    fetchHistoryFor(client, deals, 'deal', BITRIX_ENTITIES.assigneeHistory, normalizeAssigneeEvent)
  ]);

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
    warnings
  };
}
