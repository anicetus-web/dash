/**
 * Оркестрация полной синхронизации с Битрикс24.
 *
 * Единственная обязанность файла — превратить набор запросов к порталу
 * в снимок формы `EMPTY_CACHE`. Хранилищем, единственностью запуска и
 * защитой от затирания хорошего снимка плохим занимается `src/sync/service.js` —
 * здесь только чистая функция `fetchBitrixSnapshot(options) → snapshot`,
 * которая ничего не пишет на диск и не знает про предыдущий снимок.
 *
 * Каждый шаг вне двух главных выборок обёрнут так, что его отказ превращается
 * в предупреждение и пустой результат, а не в падение всей синхронизации:
 * отсутствие одного справочника не стоит целого снимка.
 */

import { config } from '../config.js';
import { createBitrixClient } from './client.js';
import { FUNNELS } from '../domain/funnels.js';
import { idOf, valueOf } from '../lib/records.js';
import {
  KEV_FORMAT_FIELD_KEY,
  dictionaryFromValues,
  fieldItems,
  findFieldDescription,
  normalizeCompany,
  normalizeDeal,
  normalizeUser,
  pendingAuditFields,
  resolvePortalFields,
  stageHistoryEvent
} from './normalize.js';

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. МАРШРУТЫ VIBECODE API. ПОДТВЕРЖДЕНЫ АУДИТОМ 18.08.2026.
 *
 * Имена сущностей во МНОЖЕСТВЕННОМ числе: `/v1/deal` отвечает 404 ROUTE_NOT_FOUND,
 * работает `/v1/deals`. Полная выкладка — `reference/PORTAL-AUDIT.md`.
 *
 * Чего здесь СОЗНАТЕЛЬНО нет:
 *   - `companies`. Справочник контрагентов в портале есть и заполнен, но воронка
 *     «Компании» ведётся НЕ им: её сущности — сделки категории 5, и у части из них
 *     штатный `companyId` вовсе равен нулю. Запрашивать его — тянуть данные,
 *     которые в расчёт не входят.
 *   - `assignee-history`. Маршрута на портале нет (404), см. `assigneeEvents` ниже.
 * ------------------------------------------------------------------------- */
export const BITRIX_ENTITIES = Object.freeze({
  /** Обе воронки — категории сделок, поэтому выборка сущностей ровно одна. */
  deals: 'deals',
  users: 'users',
  /** Определения пользовательских полей сделки: из них берутся справочники значений. */
  dealFields: 'userfields/deals',
  /** Общий журнал переходов по стадиям на весь портал; делится по категориям. */
  stageHistory: 'stage-history'
});

/**
 * Общий ограничитель параллелизма — одна очередь на несколько независимых веток.
 *
 * Ветки выборки уходят одним `Promise.all`: если у каждой СВОЙ пул воркеров
 * на `limit` штук, реальный пик одновременных запросов к порталу — произведение
 * limit на число веток, а не сам limit. BITRIX_FETCH_CONCURRENCY документирован
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
 * Сделки одной категории — одна воронка целиком.
 *
 * Отбор по категории делается ДВАЖДЫ: параметром запроса и ещё раз по полученным
 * записям. Это не перестраховка ради перестраховки: портал молча ИГНОРИРУЕТ
 * параметры, которых не знает (проверено на `filter[ownerId]` у истории стадий),
 * а незамеченный игнор здесь означал бы, что в обе воронки попали сделки всех
 * категорий портала разом — «Прогрев», «Производство», «Подбор персонала».
 *
 * @returns {{rows: object[], warnings: object[], fetchFailed: boolean}}
 */
async function fetchCategoryDeals(client, categoryId, funnelTitle) {
  try {
    const { rows, truncated } = await client.retry(
      () => client.listAll(BITRIX_ENTITIES.deals, { categoryId })
    );
    const wanted = idOf(categoryId);
    const mine = rows.filter((row) => idOf(valueOf(row, ['categoryId', 'CATEGORY_ID'])) === wanted);
    const warnings = [];
    if (truncated) {
      warnings.push({
        code: 'ENTITY_FETCH_TRUNCATED',
        message: `Выборка воронки «${funnelTitle}» обрезана предохранителем постраничности — данные неполны.`
      });
    }
    if (mine.length !== rows.length) {
      warnings.push({
        code: 'ENTITY_CATEGORY_MISMATCH',
        message: `Портал вернул ${rows.length - mine.length} сделок чужой категории на запрос воронки «${funnelTitle}» — они отброшены. Похоже, параметр categoryId проигнорирован.`
      });
    }
    return { rows: mine, warnings, fetchFailed: truncated };
  } catch (error) {
    return {
      rows: [],
      warnings: [{
        code: 'ENTITY_FETCH_FAILED',
        message: `Воронка «${funnelTitle}» не получена: ${error.message}`
      }],
      fetchFailed: true
    };
  }
}

/**
 * Сущности предыдущего снимка, которых нет среди свежеполученных, — когда выборка
 * в ЭТОТ заход не удалась или пришла неполной. Без этого один отказ маршрута делает
 * сущности невидимыми навсегда: `isDegradedSync` пропускает просадку меньше 25%,
 * и такая потеря — некрупная на вид, но реальная и необратимая.
 *
 * При удавшейся полной выборке НЕ вызывается: там отсутствие сущности означает,
 * что её действительно удалили на портале, и подмешивать её обратно нельзя.
 */
export function restoreMissingFromPrevious(freshList, previousList, warningsSink, label) {
  if (!Array.isArray(previousList) || previousList.length === 0) return freshList;
  const freshIds = new Set(freshList.map((entity) => entity.id));
  const merged = [...freshList];
  let restored = 0;
  for (const previous of previousList) {
    if (!previous?.id || freshIds.has(previous.id)) continue;
    merged.push(previous);
    freshIds.add(previous.id);
    restored += 1;
  }
  if (restored > 0) {
    warningsSink.push({
      code: 'ENTITY_RESTORED_FROM_CACHE',
      message: `${restored} ${label} восстановлены из прежнего снимка — их выборка в этот заход не удалась.`
    });
  }
  return merged;
}

/**
 * События сущностей, чья история в этот заход не приехала, — из прежнего снимка.
 *
 * История стадий на портале только дополняется, поэтому «владельца нет среди
 * свежих событий» при неполной выборке означает не «событий больше нет», а «до
 * его страницы не дошли». Полная замена в этом случае откатила бы сущность на
 * пройденные этапы назад — ровно тот инцидент, что описан в референсе Altech
 * (сделка потеряла событие «Договор подписан» после одной неудачной выборки).
 */
export function keepPreviousEventsForMissingOwners(freshEvents, previousEvents, ownerKey) {
  const known = new Set(freshEvents.map((event) => event[ownerKey]));
  const merged = [...freshEvents];
  for (const event of previousEvents || []) {
    const id = event?.[ownerKey];
    if (!id || known.has(id)) continue;
    merged.push(event);
  }
  return merged;
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
 * Отсекает сущности старше горизонта синхронизации (`BITRIX_HISTORY_YEARS`).
 *
 * Отбор идёт ЗДЕСЬ, а не параметром запроса: синтаксис фильтра по диапазону дат
 * у этого прокси не подтверждён, а неизвестный параметр он молча игнорирует —
 * то есть «фильтр» на стороне портала был бы иллюзией. Сущность без разбираемых
 * дат остаётся: доказать, что она старая, нечем, а выбросить её — потерять данные.
 */
function withinHorizon(entities, fromMs) {
  return entities.filter((entity) => {
    const created = Date.parse(entity.createdAt || '');
    const updated = Date.parse(entity.updatedAt || '');
    if (!Number.isFinite(created) && !Number.isFinite(updated)) return true;
    return (Number.isFinite(created) && created >= fromMs) || (Number.isFinite(updated) && updated >= fromMs);
  });
}

/**
 * Полный снимок из Битрикс24. Чистая функция: сеть → нормализованные данные.
 * Ничего не сохраняет — этим занимается вызывающая служба синхронизации.
 *
 * @param {object} options {now, client, previousSnapshot} — `client` инъектируется
 *   в проверках, чтобы они шли на замоканных ответах и никогда не касались сети.
 *   `previousSnapshot` подставляет `src/sync/service.js` — снимок с прошлого
 *   успешного запуска, откуда берутся данные шагов, не удавшихся в этот заход.
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

  // Без ID категории воронку не отобрать: сделки всех категорий портала лежат
  // в одном маршруте, и выборка «без категории» намешала бы в неё чужие. Такая
  // воронка не синхронизируется вовсе — предупреждение говорит, чего не хватает.
  const categories = { companies: fields.companyCategoryId, deals: fields.dealCategoryId };
  for (const [funnelId, categoryId] of Object.entries(categories)) {
    if (categoryId) continue;
    warnings.push({
      code: 'DEAL_CATEGORY_PENDING',
      message: `ID категории воронки «${FUNNELS[funnelId].title}» не задан — эта воронка не синхронизирована. См. reference/PORTAL-AUDIT.md.`
    });
  }

  // Общий ограничитель на весь заход: параллельные ветки ниже делят один пул
  // слотов, а не заводят каждая свой (см. createLimiter).
  const limiter = createLimiter(config.bitrixFetchConcurrency);
  const empty = { rows: [], warnings: [], fetchFailed: false };

  const [companyResult, dealResult, usersRaw, dealFieldsBody, stageHistory] = await Promise.all([
    categories.companies
      ? limiter(() => fetchCategoryDeals(client, categories.companies, FUNNELS.companies.title))
      : Promise.resolve(empty),
    categories.deals
      ? limiter(() => fetchCategoryDeals(client, categories.deals, FUNNELS.deals.title))
      : Promise.resolve(empty),
    limiter(() => fetchOptional(
      () => client.retry(() => client.listAll(BITRIX_ENTITIES.users, {})).then((r) => r.rows),
      'USERS_FETCH_FAILED', 'Не удалось получить список сотрудников'
    )),
    limiter(() => fetchOptional(
      () => client.retry(() => client.fetchOne(BITRIX_ENTITIES.dealFields)),
      'DEAL_FIELDS_FETCH_FAILED', 'Не удалось получить описание полей сделки'
    )),
    // История стадий забирается ОДНИМ потоком на весь портал и делится по
    // категориям здесь, а не запрашивается по каждой сущности отдельно: обе
    // воронки — сделки, и поштучный опрос означал бы запрос на КАЖДУЮ сделку
    // портала в каждый заход синхронизации (раз в 10 минут по умолчанию).
    limiter(() => fetchOptional(
      () => client.retry(() => client.listAll(BITRIX_ENTITIES.stageHistory, {})),
      'STAGE_HISTORY_UNAVAILABLE',
      'История стадий недоступна — воронки считаются только по текущей стадии, без докраски пропущенных этапов'
    ))
  ]);

  warnings.push(...companyResult.warnings, ...dealResult.warnings);
  if (usersRaw.warning) warnings.push(usersRaw.warning);
  if (dealFieldsBody.warning) warnings.push(dealFieldsBody.warning);
  if (stageHistory.warning) warnings.push(stageHistory.warning);

  let companies = withinHorizon(companyResult.rows.map((row) => normalizeCompany(row, fields)).filter(Boolean), fromMs);
  let deals = withinHorizon(dealResult.rows.map((row) => normalizeDeal(row, fields)).filter(Boolean), fromMs);

  if (companyResult.fetchFailed) {
    companies = restoreMissingFromPrevious(companies, previousSnapshot.companies, warnings, `сущностей воронки «${FUNNELS.companies.title}»`);
  }
  if (dealResult.fetchFailed) {
    deals = restoreMissingFromPrevious(deals, previousSnapshot.deals, warnings, `сделок воронки «${FUNNELS.deals.title}»`);
  }

  // Разбор общего журнала: категория 5 → события первой воронки, категория 7 →
  // второй, всё остальное отбрасывается (см. stageHistoryEvent).
  let companyStageEvents = [];
  let dealStageEvents = [];
  let historyRows = 0;
  for (const row of stageHistory.value?.rows || []) {
    historyRows += 1;
    const parsed = stageHistoryEvent(row);
    if (!parsed) continue;
    if (parsed.funnelId === 'companies') companyStageEvents.push(parsed.event);
    else dealStageEvents.push(parsed.event);
  }

  const historyIncomplete = Boolean(stageHistory.warning) || Boolean(stageHistory.value?.truncated);
  if (stageHistory.value?.truncated) {
    warnings.push({
      code: 'STAGE_HISTORY_TRUNCATED',
      message: `История стадий обрезана предохранителем постраничности на ${historyRows} записях — недостающее взято из прежнего снимка.`
    });
  }
  if (historyIncomplete) {
    companyStageEvents = keepPreviousEventsForMissingOwners(companyStageEvents, previousSnapshot.companyStageEvents, 'companyId');
    dealStageEvents = keepPreviousEventsForMissingOwners(dealStageEvents, previousSnapshot.dealStageEvents, 'dealId');
  }

  // История ОТВЕТСТВЕННЫХ на этом портале недоступна: маршрута `/v1/assignee-history`
  // нет (404, аудит 18.08.2026). Массив пуст всегда — расчётный модуль в этом случае
  // относит этап ТЕКУЩЕМУ ответственному и сам добавляет ASSIGNEE_HISTORY_MISSING.
  // Дублируем предупреждение здесь, чтобы причина была видна и в состоянии
  // синхронизации, а не только над воронкой.
  const assigneeEvents = [];
  warnings.push({
    code: 'ASSIGNEE_HISTORY_UNAVAILABLE',
    message: 'История ответственных на портале недоступна (маршрута нет) — фильтр по менеджеру считает по ТЕКУЩЕМУ ответственному, а не по тому, кто вёл сущность на момент прохождения этапа.'
  });

  const managers = (usersRaw.value || []).map(normalizeUser).filter(Boolean);

  // Источник у обеих воронок — одно и то же поле сделки, поэтому и справочник
  // строится по объединению значений: иначе база, встретившаяся только во второй
  // воронке, пропала бы из фильтра.
  const sources = dictionaryFor(
    dealFieldsBody.value,
    fields.companySourceField || fields.dealSourceField,
    [...companies.map((c) => c.sourceId), ...deals.map((d) => d.sourceId)]
  );
  const kevFormats = dictionaryFor(
    dealFieldsBody.value,
    fields.dealKevFormatField,
    deals.map((d) => d.kevFormatId)
  );

  // Справочник стадий как есть, без имён (отдельный каталог стадий портала
  // сюда не тянется — только то, что фактически встретилось на сущностях):
  // dictionaryFromValues уже возвращает {id, name} с именем, равным ID.
  const companyStagesDictionary = dictionaryFromValues(companies.map((c) => c.currentStageId));
  const dealStagesDictionary = dictionaryFromValues(deals.map((d) => d.currentStageId));

  // Поле формата КЭВ отделено от остальных: его отсутствие — известный и принятый
  // пробел портала, а не недонастройка. Мешать их в одно предупреждение значило бы
  // каждый заход пугать пользователя тем, что уже разобрано и записано в аудит.
  const pendingFields = pendingAuditFields(options.portalFields);
  const kevFieldAbsent = pendingFields.some((field) => field.key === KEV_FORMAT_FIELD_KEY);
  const otherPendingFields = pendingFields.filter((field) => field.key !== KEV_FORMAT_FIELD_KEY);
  if (kevFieldAbsent) {
    warnings.push({
      code: 'KEV_FIELD_ABSENT',
      message: 'Поля формата КЭВ на портале нет — фильтр по КЭВ остаётся пустым. Известный пробел, а не сбой синхронизации.'
    });
  }
  if (otherPendingFields.length > 0) {
    warnings.push({
      code: 'PORTAL_FIELDS_PENDING',
      message: `${otherPendingFields.length} полей портала не подтверждены (${otherPendingFields.map((f) => f.description).join('; ')}) — часть чисел считается на упрощении.`
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
    assigneeHistoryAvailable: false,
    // Та же форма {code, message}, что и у верхнеуровневого warnings — единый контракт
    // на случай, если этот список когда-нибудь пройдёт через тот же рендерер
    // предупреждений (public/app.js#renderMessages читает warning.message).
    warnings: [
      { code: 'SOURCE_MISSING', message: `Без базы/источника: сущностей первой воронки ${companiesWithoutSource}, сделок ${dealsWithoutSource} — попадут в «Источник не указан».` },
      kevFieldAbsent
        // Считать «сделки без КЭВ» при отсутствующем поле бессмысленно: без КЭВ
        // окажутся ВСЕ, и число выглядело бы как обвал качества данных.
        ? { code: 'KEV_MISSING', message: 'Формат КЭВ на портале не ведётся — все сделки попадут в «Не указано».' }
        : { code: 'KEV_MISSING', message: `Без формата КЭВ: сделок ${dealsWithoutKev} — попадут в «Не указано».` }
    ]
  };

  return {
    companies,
    deals,
    companyStageEvents,
    dealStageEvents,
    assigneeEvents,
    // `calls` не заполняется намеренно: телефония портала в синхронизацию не
    // заведена, и карточка «Звонки» обязана показывать прочерк («источника нет»),
    // а не ноль («звонков не было»). Пустой раздел подставит форма снимка.
    managers,
    sources,
    kevFormats,
    stages: { companies: companyStagesDictionary, deals: dealStagesDictionary },
    portalTimezone: config.portalTimezone,
    dataQuality,
    warnings
  };
}
