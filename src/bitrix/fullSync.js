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
  normalizeCall,
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
  stageHistory: 'stage-history',
  /** Телефония. Маршрут на портале не подтверждён — ветка необязательная. */
  calls: 'calls'
});

/**
 * Маршруты, под которыми на порталах живут звонки.
 *
 * Единого имени нет: где-то это выделенная телефония, где-то звонок — просто
 * дело CRM с типом «звонок». Аудит 3db.bitrix24.ru маршрута телефонии не
 * подтвердил, поэтому перебираем известные варианты по очереди и берём первый,
 * который вообще что-то отдал. Гадать вместо перебора нельзя: карточка «Звонки»
 * либо показывает настоящие числа, либо честный прочерк — придумывать нечего.
 */
export const CALL_ROUTE_CANDIDATES = Object.freeze(['calls', 'telephony/calls', 'activities']);

/**
 * Первый маршрут звонков, который отдал записи.
 *
 * @returns {{rows: any[], route: string|null, failures: string[]}}
 */
/**
 * Потолок страниц для звонков. Их выборка НЕ имеет права стоить столько же,
 * сколько воронка: маршрут дел CRM отдаёт все дела портала подряд — письма,
 * встречи, задачи, — и без потолка одна эта ветка тянет синхронизацию дольше
 * всех остальных вместе взятых. А пока синхронизация не закончилась, снимка
 * нет вовсе и дашборд показывает демо-цифры: цена «полных звонков» — пустая
 * воронка, что несоизмеримо хуже.
 */
const CALL_PAGE_CAP = 1000;
// Страница крупнее обычной: обход туда-обратно на этом маршруте стоит дороже
// самой передачи, а короткую страницу постраничность больше не считает концом
// данных — портал вправе отдать меньше запрошенного.
const CALL_PAGE_SIZE = 500;

/**
 * Бюджет времени на звонки. Ветка звонков НЕ имеет права задерживать снимок:
 * пока синхронизация не закончилась, снимка нет вовсе и дашборд показывает
 * демонстрационные цифры вместо воронки. Полная выкачка дел портала на бою
 * шла дольше десяти минут и держала всю синхронизацию — воронка есть, но её
 * никто не видит. Не уложились в бюджет — берём звонки из прежнего снимка.
 */
const CALL_TIME_BUDGET_MS = 300000;

/**
 * Окно звонков в днях.
 *
 * Дел CRM на портале под сотню тысяч, и практически все — внутри горизонта
 * синхронизации: выборка не уложилась ни в три минуты, ни в семь. Снимок при
 * этом ждёт ВСЕ ветки, поэтому длинный бюджет означал бы не «звонки приедут»,
 * а «воронку никто не увидит ещё дольше».
 *
 * Поэтому звонки берутся за последние месяцы — этого хватает быстрым периодам
 * (день, неделя, месяц, квартал), а за более давние карточка честно говорит,
 * что разговоры туда не загружены, вместо показа заниженных чисел как верных.
 */
export const CALL_WINDOW_DAYS = 120;

/** Результат задачи либо отметка «не уложились», без падения всей ветки. */
async function withTimeBudget(task, budgetMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    // Без unref: снятый с учёта таймер не удерживает событийный цикл, и когда
    // задача ничего не ждёт через дескрипторы, цикл опустошается раньше срока —
    // бюджет не срабатывает вовсе. Таймер снимается в finally.
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  try {
    return await Promise.race([task().then((value) => ({ timedOut: false, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Дата записи на указанном смещении. null — записи там уже нет. */
async function dateAtOffset(client, route, offset) {
  const probe = await client.retry(() => client.listAll(
    route, { typeId: 2 }, { maxPages: 1, pageSize: 1, startOffset: offset }
  ));
  const row = (probe.rows || [])[0];
  if (!row) return null;
  // Дата читается напрямую, а не через normalizeCall: тому нужен ещё и ID,
  // и запись без пригодного ID сошла бы за «конец выборки», сдвинув границу.
  for (const key of ['startTime', 'START_TIME', 'callStartDate', 'CALL_START_DATE', 'createdAt', 'CREATED', 'DATE_CREATE']) {
    const value = row[key];
    if (value === undefined || value === null || value === '') continue;
    const at = Date.parse(String(value).replace(' ', 'T'));
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/**
 * Смещение, с которого начинаются записи не старше горизонта синхронизации.
 *
 * Дела CRM приходят от старых к новым и их на порталах десятки тысяч, но в
 * дашборд попадают только записи внутри горизонта. Выкачивать ради них весь
 * журнал портала незачем: смещение маршрут отрабатывает честно (проверено —
 * offset 20000 отдаёт другую запись), поэтому нужная граница ищется двоично.
 * Каждая проба стоит ОДНУ запись, всего около двадцати запросов.
 *
 * Отсутствие записи на смещении считается «уже за горизонтом»: это конец
 * выборки, и искать надо левее.
 */
async function offsetOfHorizon(client, route, fromMs) {
  const reached = async (offset) => {
    const at = await dateAtOffset(client, route, offset);
    return at === null || at >= fromMs;
  };
  if (await reached(0)) return 0;

  let older = 0;
  let inside = null;
  for (let step = 1024; step <= 4194304; step *= 2) {
    if (await reached(step)) { inside = step; break; }
    older = step;
  }
  // Ни одна запись не попала в окно: журнал портала заканчивается раньше его
  // начала. Возврат последнего опробованного смещения здесь означал бы выборку
  // с заведомо несуществующего места — портал на такое отдаёт горсть случайных
  // записей, и они уезжали в снимок как «звонки за период».
  if (inside === null) return null;
  while (inside - older > CALL_PAGE_SIZE) {
    const middle = Math.floor((older + inside) / 2);
    if (await reached(middle)) inside = middle;
    else older = middle;
  }
  return older;
}

export async function fetchCallRows(client, { budgetMs = CALL_TIME_BUDGET_MS, fromMs = null, nowMs = Date.now() } = {}) {
  const failures = [];
  for (const route of CALL_ROUTE_CANDIDATES) {
    try {
      // typeId=2 — «звонок» среди дел CRM. Незнакомый параметр этот прокси
      // молча игнорирует, поэтому тип перепроверяется ещё раз при разборе
      // записи (normalizeCall), а не считается применённым отбором.
      const probe = await client.retry(() => client.listAll(route, { typeId: 2 }, { maxPages: 1, pageSize: 1 }));
      if ((probe.rows || []).length === 0) continue;

      // Проба смещения: отвечает ли маршрут на «дай запись номер N» или
      // зажимает смещение и отдаёт одно и то же. От этого зависит, можно ли
      // вообще брать свежий хвост вместо выкачивания всех дел портала.
      // Ответ уходит в диагностику синхронизации, а не в догадки.
      let offsetProbe = null;
      try {
        const far = await client.retry(() => client.listAll(
          route, { typeId: 2 }, { maxPages: 1, pageSize: 1, startOffset: 20000 }
        ));
        offsetProbe = {
          firstId: idOfRow(probe.rows[0]),
          farId: idOfRow((far.rows || [])[0]),
          farRows: (far.rows || []).length
        };
      } catch { offsetProbe = null; }

      // Берём не весь журнал портала, а его часть от границы горизонта.
      // Не весь журнал портала и даже не весь горизонт — только окно звонков.
      const windowFromMs = fromMs === null ? null : Math.max(fromMs, nowMs - CALL_WINDOW_DAYS * 86400000);
      const startOffset = windowFromMs === null ? 0 : await offsetOfHorizon(client, route, windowFromMs);
      if (startOffset === null) {
        return { rows: [], route, failures, truncated: false, timedOut: false, total: probe.total, offsetProbe, startOffset: null, emptyWindow: true };
      }
      const attempt = await withTimeBudget(() => client.retry(() => client.listAll(
        route,
        { typeId: 2 },
        { maxPages: CALL_PAGE_CAP, pageSize: CALL_PAGE_SIZE, startOffset }
      )), budgetMs);

      if (attempt.timedOut) {
        return { rows: [], route, failures, truncated: true, timedOut: true, total: probe.total, offsetProbe, startOffset };
      }
      const result = attempt.value;
      if ((result.rows || []).length > 0) {
        return {
          rows: result.rows,
          route,
          failures,
          truncated: Boolean(result.truncated),
          timedOut: false,
          total: probe.total,
          offsetProbe,
          startOffset
        };
      }
    } catch (error) {
      // 404 на несуществующем маршруте — это не сбой синхронизации, а ответ
      // «такого тут нет»: пробуем следующий кандидат.
      failures.push(`${route}: ${error.message}`);
    }
  }
  return { rows: [], route: null, failures, truncated: false, timedOut: false };
}

/** ID записи в той форме, в какой его отдаёт портал. */
function idOfRow(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id ?? row.ID;
  return id === undefined || id === null ? null : String(id);
}

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

/* ------------------------------------------------------------------------- *
 * СВЯЗЬ ВОРОНОК ЧЕРЕЗ КАРТОЧКУ КОНТРАГЕНТА.
 *
 * Обе воронки — категории сделок, и «своя» сделка друг для друга у них не указана
 * напрямую: единственное поле-связь портала (`UF_CRM_6A26C1E175665`) заполнено у 9
 * сделок из 893 и связью не является. Зато у сделок ОБЕИХ категорий заполнен штатный
 * `companyId` — обе смотрят на одну карточку контрагента CRM:
 *
 *     сделка C5 → карточка компании ← сделка C7
 *
 * Снимок же хранит `companies[]` = сделки категории 5 и ждёт, что `deal.companyId`
 * указывает на запись ИЗ ЭТОГО списка. Поэтому карточку нужно перевести в сделку
 * первой воронки — этим и заняты две функции ниже.
 * ------------------------------------------------------------------------- */

/**
 * Сравнение ID для устойчивого порядка: числовые сравниваются как числа
 * ('9' < '10'), любые прочие — лексикографически.
 */
function compareIds(left, right) {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) return Number(left) - Number(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Сущность без разбираемой даты создания не может выиграть у датированной: иначе выбор
 * родителя зависел бы от порядка страниц выборки, а портал его не гарантирует.
 */
function createdAtMs(entity) {
  const ms = Date.parse(entity?.createdAt || '');
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/**
 * Индекс «карточка контрагента → сделка первой воронки».
 *
 * Одна карточка может вести к НЕСКОЛЬКИМ сделкам категории 5 (одну компанию заводили
 * дважды, или у неё несколько заходов). Родитель выбирается детерминированно — самая
 * ранняя по `createdAt`, при равных датах меньший ID, — чтобы два прогона синхронизации
 * не разошлись в том, к какой сущности отнесены сделки: иначе сквозная воронка меняла бы
 * числа на ровном месте, без единого изменения на портале.
 *
 * Сделка категории 5 без карточки (`companyId = 0`) в индекс не попадает: целью связи
 * ей быть нечем. Это не ошибка — таких на портале заметная часть.
 *
 * @returns {{byCard: Map<string, object>, collidingCards: number, extraCompanies: number}}
 */
export function indexCompaniesByCard(companies) {
  const byCard = new Map();
  const colliding = new Set();
  let extraCompanies = 0;
  for (const company of companies) {
    const card = company?.companyCardId;
    if (!card) continue;
    const kept = byCard.get(card);
    if (!kept) {
      byCard.set(card, company);
      continue;
    }
    colliding.add(card);
    extraCompanies += 1;
    const keptTime = createdAtMs(kept);
    const time = createdAtMs(company);
    const earlier = time !== keptTime ? time < keptTime : compareIds(company.id, kept.id) < 0;
    if (earlier) byCard.set(card, company);
  }
  return { byCard, collidingCards: colliding.size, extraCompanies };
}

/**
 * Проставляет сделкам второй воронки `companyId` — ID сделки ПЕРВОЙ воронки,
 * делящей с ними карточку контрагента.
 *
 * Сделка, чья карточка не нашлась среди сущностей первой воронки, остаётся с `companyId`
 * = null и попадает в `dealsWithoutCompany`. Придумать ей родителя нельзя: это ровно тот
 * случай, ради которого счётчик и предупреждение существуют.
 */
export function linkDealsToCompanies(companies, deals, warningsSink) {
  const { byCard, collidingCards, extraCompanies } = indexCompaniesByCard(companies);
  if (collidingCards > 0) {
    warningsSink.push({
      code: 'COMPANY_CARD_COLLISION',
      message: `${collidingCards} карточек контрагента ведут больше чем к одной сущности воронки «${FUNNELS.companies.title}» (${extraCompanies} лишних) — родителем выбрана самая ранняя по дате создания, остальные в сквозную воронку не собирают свои сделки.`
    });
  }
  return deals.map((deal) => {
    // Сделка, восстановленная из ПРЕЖНЕГО снимка, карточки не несёт — там её не хранили.
    // Её уже разрешённая связь остаётся как есть: обнулить её значило бы потерять данные
    // там, где новой информации просто нет.
    if (!deal.companyCardId) return deal;
    const parent = byCard.get(deal.companyCardId);
    if (!parent) return { ...deal, companyId: null };

    // База НАСЛЕДУЕТСЯ от родителя из верхней воронки.
    //
    // На этом портале поле базы заполняется только у сущностей воронки
    // «Компании» — у сделок нижней воронки его нет вовсе (аудит портала).
    // Без наследования фильтр по базе обнулял бы всю нижнюю половину воронки:
    // сделка не совпала бы ни с одним выбранным значением и выпала бы из среза,
    // хотя её родитель этой базе принадлежит. Собственное значение сделки, если
    // оно вдруг заполнено, приоритетнее — портал мог его переопределить осознанно.
    const sourceId = deal.sourceId ?? parent.sourceId ?? null;
    return { ...deal, companyId: parent.id, sourceId };
  });
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

  const [companyResult, dealResult, usersRaw, dealFieldsBody, stageHistory, callsRaw] = await Promise.all([
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
    )),
    // Телефония. Ветка НЕОБЯЗАТЕЛЬНАЯ: наличие маршрута /v1/calls на портале не
    // подтверждено аудитом, и его отсутствие не должно ронять всю синхронизацию.
    // Нет маршрута — карточка «Звонки» показывает отсутствие данных ровно так же,
    // как показывала до появления этой ветки, но с причиной в предупреждении.
    // Звонки остаются В ОБЩЕЙ ОЧЕРЕДИ слотов. Попытка вывести их наружу, чтобы
    // не голодали, обернулась хуже: портал начал отказывать по всем маршрутам
    // сразу — лишний одновременный поток упирается в его собственный предел, и
    // вместо медленных звонков не стало никаких. Ограничитель здесь защищает не
    // нас, а портал, и обходить его нельзя.
    limiter(() => fetchOptional(
      () => fetchCallRows(client, { fromMs, nowMs: now.getTime() }),
      'CALLS_FETCH_FAILED',
      'Телефония портала недоступна — карточка «Звонки» останется пустой'
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

  // Связь воронок — ПОСЛЕ восстановления из прежнего снимка: индекс карточек обязан
  // включать и восстановленные сущности первой воронки, иначе один неудавшийся заход
  // разорвал бы связи у сделок, чьи родители в этот раз не приехали.
  deals = linkDealsToCompanies(companies, deals, warnings);

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

  // Сколько журнала реально доехало. Портал сообщает общее число записей, и
  // расхождение с полученным — единственный способ ЗАМЕТИТЬ недобор: воронка,
  // посчитанная по неполной истории, выглядит совершенно нормально, просто
  // показывает числа в разы меньше настоящих.
  const historyReportedTotal = stageHistory.value?.total ?? null;
  const historyPartial = historyReportedTotal !== null && historyRows < historyReportedTotal;
  if (historyPartial) {
    warnings.push({
      code: 'STAGE_HISTORY_PARTIAL',
      message: `Журнал переходов получен не полностью: ${historyRows} записей из ${historyReportedTotal}. Воронка посчитана по неполной истории и занижена — числам верить нельзя до успешной синхронизации.`
    });
  }

  const historyIncomplete = Boolean(stageHistory.warning) || Boolean(stageHistory.value?.truncated) || historyPartial;
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

  // Раскладка звонков по воронкам. Телефония знает только «сделка N», а какая это
  // воронка — верхняя (категория 5) или нижняя (категория 7) — видно лишь по нашим
  // спискам. Звонок, чья сущность не нашлась ни там ни там (лид, контакт, сделка
  // чужой категории), связи не получает и в карточку не попадёт: приписать его
  // наугад значило бы завысить показатель по чужим разговорам.
  const companyIdSet = new Set(companies.map((c) => c.id));
  // Карта, а не поиск перебором: звонков на портале кратно больше, чем сделок,
  // и перебор списка на каждый звонок превратил бы раскладку в квадрат.
  const dealById = new Map(deals.map((d) => [d.id, d]));
  const dealIdSet = new Set(dealById.keys());
  let callsLinked = 0;
  let callsFetched = 0;
  const calls = [];
  const callsRoute = callsRaw.value?.route ?? null;
  for (const row of callsRaw.value?.rows || []) {
    callsFetched += 1;
    const call = normalizeCall(row);
    if (!call) continue;
    const companyId = call.companyId && companyIdSet.has(call.companyId) ? call.companyId
      : (call.entityId && companyIdSet.has(call.entityId) ? call.entityId : null);
    const dealId = call.dealId && dealIdSet.has(call.dealId) ? call.dealId
      : (call.entityId && dealIdSet.has(call.entityId) ? call.entityId : null);
    if (!companyId && !dealId) continue;
    // Звонок по сделке нижней воронки наследует компанию-родителя: карточка
    // «Звонки» уважает фильтр по базе, а база живёт только в верхней воронке.
    const parentId = dealId ? (dealById.get(dealId)?.companyId ?? null) : null;
    callsLinked += 1;
    calls.push({
      id: call.id,
      companyId: companyId ?? parentId,
      dealId,
      at: call.at,
      durationMinutes: call.durationMinutes,
      success: call.success
    });
  }
  // Не уложились в бюджет — звонки берутся из прежнего снимка. Обнулять их
  // нельзя: пустая карточка читается как «звонков не было», хотя на деле мы
  // просто не успели их забрать в этот заход.
  let callsTimedOut = false;
  if (callsRaw.value?.timedOut) {
    callsTimedOut = true;
    const previous = previousSnapshot?.calls || [];
    if (previous.length > 0) {
      calls.push(...previous);
      callsLinked = previous.length;
      warnings.push({
        code: 'CALLS_STALE',
        message: `Звонки не успели обновиться за отведённое время — показаны ${previous.length} записей из прежнего снимка.`
      });
    } else {
      warnings.push({
        code: 'CALLS_TIMEOUT',
        message: 'Звонки не успели загрузиться за отведённое время — карточка «Звонки» пуста. Воронка при этом посчитана полностью.'
      });
    }
  }
  if (calls.length > 0) {
    warnings.push({
      code: 'CALLS_WINDOW',
      message: `Звонки загружены за последние ${CALL_WINDOW_DAYS} дней: дел на портале под сотню тысяч, и выкачивать их целиком означало бы держать воронку невидимой. За более давние периоды карточка «Звонки» покажет прочерк.`
    });
  }
  if (callsRaw.warning) warnings.push(callsRaw.warning);
  if (callsRaw.value?.truncated) {
    const total = callsRaw.value?.total ?? null;
    warnings.push({
      code: 'CALLS_PARTIAL',
      message: total !== null
        ? `Звонки взяты не целиком: последние ${callsFetched} записей из ${total}. За давние периоды карточка «Звонки» покажет заниженные числа.`
        : 'Объём звонков на портале неизвестен, взята только часть выборки — числа в карточке «Звонки» могут быть занижены.'
    });
  }
  if (callsRaw.value?.emptyWindow) {
    warnings.push({
      code: 'CALLS_WINDOW_EMPTY',
      message: `За последние ${CALL_WINDOW_DAYS} дней на портале нет ни одного зарегистрированного звонка — карточка «Звонки» показывает прочерк, а не ноль.`
    });
  }
  if (!callsRaw.warning && !callsTimedOut && !callsRaw.value?.emptyWindow && calls.length === 0) {
    warnings.push({
      code: 'CALLS_UNAVAILABLE',
      message: 'Телефония портала не отдала ни одного звонка, привязанного к сущностям воронок — карточка «Звонки» показывает отсутствие данных, а не отсутствие звонков.'
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
    // callsFetched — сколько записей телефонии вообще приехало, callsLinked —
    // сколько удалось привязать к сущностям воронок. Ноль у первого значит
    // «маршрута нет или он пуст», ноль у второго при ненулевом первом —
    // «телефония есть, но связывается не тем полем».
    callsFetched,
    callsLinked,
    // Какой маршрут портала отдал звонки. null — не отдал ни один из известных.
    callsRoute,
    callsTotalOnPortal: callsRaw.value?.total ?? null,
    callsTimedOut,
    // Отвечает ли маршрут на смещение или зажимает его: от этого зависит,
    // можно ли брать свежий хвост вместо выкачивания всех дел портала.
    callsOffsetProbe: callsRaw.value?.offsetProbe ?? null,
    // С какого смещения начата выборка: граница горизонта синхронизации.
    callsStartOffset: callsRaw.value?.startOffset ?? null,
    // Диагностика журнала переходов: по ней видно, полон ли он, без чтения логов.
    stageHistory: {
      rowsFetched: historyRows,
      reportedTotal: historyReportedTotal,
      pages: stageHistory.value?.pages ?? null,
      keptCompanies: companyStageEvents.length,
      keptDeals: dealStageEvents.length,
      complete: !historyIncomplete
    },
    // Та же форма {code, message}, что и у верхнеуровневого warnings — единый контракт
    // на случай, если этот список когда-нибудь пройдёт через тот же рендерер
    // предупреждений (public/app.js#renderMessages читает warning.message).
    warnings: [
      // Считается ТОЛЬКО по первой воронке: база — поле верхней воронки, у сделок
      // категории 7 она не заполняется вовсе (боевой прогон 18.08.2026). Их счётчик
      // равнялся бы числу всех сделок и читался бы как обвал качества данных.
      { code: 'SOURCE_MISSING', message: `Без базы/источника: сущностей первой воронки ${companiesWithoutSource} — попадут в «Источник не указан». База ведётся только в верхней воронке, у сделок её нет по устройству портала.` },
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
    calls,
    managers,
    sources,
    kevFormats,
    stages: { companies: companyStagesDictionary, deals: dealStagesDictionary },
    portalTimezone: config.portalTimezone,
    dataQuality,
    warnings
  };
}
