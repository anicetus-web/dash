/**
 * Нормализация ответов портала в форму снимка (`EMPTY_CACHE` из `src/storage/jsonStore.js`).
 *
 * Расчётный модуль ничего не знает про Битрикс: он читает компании, сделки и события
 * строго определённой формы. Весь разнобой портала — разный регистр имён полей,
 * числа вместо строк, отсутствующие значения, даты в трёх форматах — заканчивается здесь.
 *
 * Два правила файла:
 *   1. Отдельная функция на каждую сущность. Общая «универсальная» нормализация
 *      однажды прочитает поле сделки у компании и даст расхождение чисел.
 *   2. Никакого домысливания. Нет значения — пустое значение и запись в качество данных;
 *      подставить «правдоподобное» хуже, чем показать «не указано».
 *
 * Чтение полей идёт через `src/lib/records.js`: там уже решены регистр имён,
 * канонизация ID и разбор дат. Дублировать эту логику нельзя — разойдётся.
 */

import { DEAL_CATEGORY_IDS, canonicalStageId, isLostStageId } from '../domain/funnels.js';
import { boolOf, firstIdOf, idOf, isoOrNull, textOf, valueOf } from '../lib/records.js';

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. ПОЛЯ ПОРТАЛА. ПОДТВЕРЖДЕНЫ АУДИТОМ 18.08.2026.
 *
 * Идентификаторы получены запросом `GET /v1/userfields/deals` и разобраны
 * по значениям списков — полная таблица в `reference/PORTAL-AUDIT.md`.
 *
 * Ключевое про модель данных: ОБЕ воронки — это категории СДЕЛОК (5 и 7),
 * поэтому «поле компании» и «поле сделки» здесь физически одно и то же поле
 * сделки. Пары ключей оставлены раздельными намеренно: если заказчик заведёт
 * для второй воронки собственное поле источника, правка будет в одну строку,
 * а не в переписывание нормализаторов.
 *
 * Единственное поле, которого на портале НЕТ, — формат КЭВ: среди 88
 * пользовательских полей сделки нет списка с такими значениями. Оно остаётся
 * заглушкой, `pendingAuditFields()` возвращает ровно его, и это ИЗВЕСТНЫЙ
 * пробел, а не сбой: фильтр по КЭВ в интерфейсе остаётся, но всегда пуст.
 *
 * Технические ID стадий обеих воронок лежат в `src/domain/funnels.js`
 * (`STAGE_TECHNICAL_IDS`, `SERVICE_STAGE_IDS`, `LOST_STAGE_IDS`) — там же и правятся.
 * Часовой пояс портала — переменная окружения `PORTAL_TIMEZONE`.
 * ------------------------------------------------------------------------- */

/** Префикс значения-заглушки. Реальные идентификаторы полей так не начинаются. */
export const PLACEHOLDER_FIELD_PREFIX = '3DB_';

/**
 * Поля портала. Ключ — говорящее имя, значение — идентификатор поля в Битриксе.
 *
 * Про регистр: определения полей приходят в верхнем змеином регистре
 * (`UF_CRM_694BF2A975BD0`), а сами записи — в camelCase (`ufCrm_694BF2A975BD0`).
 * Здесь хранится форма из определений; `valueOf` (src/lib/records.js) сравнивает
 * имена без регистра и разделителей, поэтому оба написания читаются одинаково.
 */
export const PORTAL_FIELDS = Object.freeze({
  /**
   * База/источник у сущности первой воронки (сделка категории 5).
   * Поле МНОЖЕСТВЕННОЕ: значение приезжает массивом (`[493]`) — читается через `firstIdOf`.
   */
  companySourceField: 'UF_CRM_694BF2A975BD0',
  /** База/источник у сделки второй воронки — то же поле сделки. */
  dealSourceField: 'UF_CRM_694BF2A975BD0',
  /**
   * Формат КЭВ. Поля на портале нет — значение остаётся заглушкой, и `fieldValue`
   * не обращается к несуществующему имени. Заводить его должен заказчик.
   */
  dealKevFormatField: '3DB_FIELD:DEAL_KEV_FORMAT',
  /*
   * Поля связи воронок здесь НЕТ, и это результат боевого прогона 18.08.2026.
   *
   * Кандидатом было `UF_CRM_6A26C1E175665` (тип `crm`, область `{"DEAL":"Y"}`) —
   * единственное поле-связь на сделку. Оказалось заполнено у 9 сделок из 893, то есть
   * связью не является: 99% второй воронки осталось бы без родителя.
   *
   * Настоящая связь — ШТАТНАЯ карточка контрагента: `companyId` заполнен у сделок ОБЕИХ
   * категорий и указывает на одну и ту же карточку CRM. Поэтому нормализаторы кладут её
   * в `companyCardId`, а перевод «карточка → сделка категории 5» делает `fullSync.js`:
   * он один видит обе воронки целиком, а нормализатору отдельной записи такой перевод
   * не по силам — он не знает про остальные записи.
   */
  /**
   * Стадия сущности первой воронки. Обе воронки — категории сделок, поэтому
   * стадия лежит в ШТАТНОМ поле сделки, а не в пользовательском.
   */
  companyStageField: 'stageId',
  /** Стадия сделки второй воронки — то же штатное поле. */
  dealStageField: 'stageId',
  /** Категория сделок первой воронки («Компании» в терминах спеки). */
  companyCategoryId: DEAL_CATEGORY_IDS.companies,
  /** Категория сделок второй воронки («Сделки»). */
  dealCategoryId: DEAL_CATEGORY_IDS.deals
});

/** Человеческое описание каждого поля — уходит заказчику в `REQUIRED_INPUTS.md`. */
export const PORTAL_FIELD_DESCRIPTIONS = Object.freeze({
  companySourceField: 'ID поля базы/источника у сущности первой воронки',
  dealSourceField: 'ID поля базы/источника у сделки второй воронки',
  dealKevFormatField: 'ID поля формата КЭВ в карточке сделки',
  companyStageField: 'Поле текущей стадии сущности первой воронки',
  dealStageField: 'Поле текущей стадии сделки второй воронки',
  companyCategoryId: 'Числовой ID категории (воронки) «Компании»',
  dealCategoryId: 'Числовой ID категории (воронки) «Сделки»'
});

/** Значение — незаменённая заглушка аудита. */
export function isPlaceholderField(value) {
  return typeof value === 'string' && value.startsWith(PLACEHOLDER_FIELD_PREFIX);
}

/**
 * Настройка полей с учётом переопределений вызывающего кода.
 * Заглушки и пустые значения превращаются в `null`: читать поле с таким именем
 * нельзя, нормализация обязана уйти на стандартные имена Битрикса.
 */
export function resolvePortalFields(overrides = {}) {
  const resolved = {};
  for (const key of Object.keys(PORTAL_FIELDS)) {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : PORTAL_FIELDS[key];
    const text = value === undefined || value === null ? '' : String(value).trim();
    resolved[key] = text === '' || isPlaceholderField(text) ? null : text;
  }
  return Object.freeze(resolved);
}

/**
 * Ключ поля формата КЭВ. Вынесен константой, потому что синхронизация обязана
 * отличать ЕГО отсутствие (известный пробел портала, тревожить пользователя нечем)
 * от отсутствия любого другого поля (настоящая недонастройка, влияющая на числа).
 */
export const KEV_FORMAT_FIELD_KEY = 'dealKevFormatField';

/**
 * Поля, всё ещё требующие аудита портала. Пустой список означает, что подстановка
 * выполнена полностью. Список выводится в предупреждениях синхронизации, чтобы
 * «не те числа» из-за неподтверждённого поля были видны сразу.
 */
export function pendingAuditFields(overrides = {}) {
  const pending = [];
  for (const key of Object.keys(PORTAL_FIELDS)) {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : PORTAL_FIELDS[key];
    const text = value === undefined || value === null ? '' : String(value).trim();
    if (text === '' || isPlaceholderField(text)) {
      pending.push({ key, value: text || null, description: PORTAL_FIELD_DESCRIPTIONS[key] || key });
    }
  }
  return pending;
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 2. ЧТЕНИЕ ПОЛЕЙ.
 * ------------------------------------------------------------------------- */

/**
 * Значение настраиваемого поля, а при его отсутствии — стандартных имён Битрикса.
 * `configured` уже прошёл `resolvePortalFields`, поэтому здесь он либо реальное
 * имя поля, либо `null` — обращения к полю-заглушке не произойдёт.
 */
function fieldValue(raw, configured, fallbackKeys) {
  if (configured) {
    const value = valueOf(raw, [configured]);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return valueOf(raw, fallbackKeys);
}

/** Первая непустая дата среди возможных имён поля, приведённая к ISO. */
function dateField(raw, keys) {
  return isoOrNull(valueOf(raw, keys));
}

const CREATED_AT_KEYS = ['createdAt', 'CREATED_AT', 'dateCreate', 'DATE_CREATE', 'createdTime', 'CREATED_TIME'];
const UPDATED_AT_KEYS = ['updatedAt', 'UPDATED_AT', 'dateModify', 'DATE_MODIFY', 'modifiedTime', 'MODIFIED_TIME'];
const ASSIGNEE_KEYS = ['assignedById', 'ASSIGNED_BY_ID', 'responsibleId', 'RESPONSIBLE_ID', 'assignedBy', 'managerId'];
const STAGE_KEYS = ['stageId', 'STAGE_ID', 'statusId', 'STATUS_ID', 'stage', 'STAGE'];
const EVENT_STAGE_KEYS = ['stageId', 'STAGE_ID', 'statusId', 'STATUS_ID', 'toStageId', 'TO_STAGE_ID', 'toValue', 'TO_VALUE', 'stage'];
const EVENT_DATE_KEYS = ['at', 'createdAt', 'CREATED_AT', 'createdTime', 'CREATED_TIME', 'date', 'DATE', 'changedAt', 'CHANGED_AT', 'dateCreate', 'DATE_CREATE'];
const OWNER_KEYS = ['ownerId', 'OWNER_ID', 'entityId', 'ENTITY_ID', 'itemId', 'ITEM_ID'];
const CATEGORY_KEYS = ['categoryId', 'CATEGORY_ID'];

const COMPANY_CARD_KEYS = ['companyId', 'COMPANY_ID', 'company', 'COMPANY'];

/**
 * Карточка контрагента CRM, к которой привязана сделка (штатный `companyId`).
 *
 * Это ОБЩИЙ ключ обеих воронок: `сделка C5 → карточка ← сделка C7`. Сам по себе он не
 * является связью снимка — в `deal.companyId` расчётный модуль ждёт ID сделки первой
 * воронки, а не карточки. Перевод одного в другое делает `fullSync.js`.
 *
 * `companyId = 0` (у части сделок категории 5) `idOf` превращает в '' → `null`: нулевой ID
 * означает «карточки нет», и путать его с настоящей связью нельзя.
 */
export function companyCardId(raw) {
  return firstIdOf(valueOf(raw, COMPANY_CARD_KEYS)) || null;
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 3. НОРМАЛИЗАТОРЫ СУЩНОСТЕЙ.
 * Каждый возвращает либо запись формы снимка, либо `null` — запись без
 * идентификатора бесполезна: её нельзя ни дедуплицировать, ни связать.
 * ------------------------------------------------------------------------- */

/**
 * Компания первой воронки.
 * @returns {{id: string, companyCardId: string|null, title: string, sourceId: string|null,
 *            currentStageId: string, assignedById: string|null,
 *            createdAt: string|null, updatedAt: string|null}|null}
 */
export function normalizeCompany(raw, fields = {}) {
  const id = idOf(valueOf(raw, ['id', 'ID']));
  if (!id) return null;
  // База — множественное перечисление: значение приходит массивом (`[493]`).
  const sourceId = firstIdOf(fieldValue(raw, fields.companySourceField, ['sourceId', 'SOURCE_ID', 'source', 'SOURCE']));
  return {
    id,
    // Карточка контрагента: по ней сделки второй воронки находят свою сущность первой.
    companyCardId: companyCardId(raw),
    title: textOf(raw, ['title', 'TITLE', 'name', 'NAME'], `Компания ${id}`),
    // Пустой источник — не ошибка данных: такие компании собираются в «Источник не указан».
    sourceId: sourceId || null,
    currentStageId: canonicalStageId(fieldValue(raw, fields.companyStageField, STAGE_KEYS) ?? ''),
    assignedById: idOf(valueOf(raw, ASSIGNEE_KEYS)) || null,
    createdAt: dateField(raw, CREATED_AT_KEYS),
    updatedAt: dateField(raw, UPDATED_AT_KEYS)
  };
}

/**
 * Сделка второй воронки — одна потребность компании.
 * @returns {{id: string, companyId: string|null, companyCardId: string|null, title: string,
 *            sourceId: string|null, kevFormatId: string|null, currentStageId: string,
 *            assignedById: string|null, createdAt: string|null, updatedAt: string|null,
 *            isLost: boolean}|null}
 */
export function normalizeDeal(raw, fields = {}) {
  const id = idOf(valueOf(raw, ['id', 'ID']));
  if (!id) return null;
  const currentStageId = canonicalStageId(fieldValue(raw, fields.dealStageField, STAGE_KEYS) ?? '');
  // База у сделок второй воронки на портале не заполняется (она относится к верхней
  // воронке) — чтение оставлено на случай, если заказчик заведёт её и здесь.
  const sourceId = firstIdOf(fieldValue(raw, fields.dealSourceField, ['sourceId', 'SOURCE_ID', 'source', 'SOURCE']));
  const kevFormatId = firstIdOf(fieldValue(raw, fields.dealKevFormatField, ['kevFormatId', 'KEV_FORMAT_ID', 'kevFormat', 'KEV_FORMAT']));
  return {
    id,
    // Связь с первой воронкой ЗДЕСЬ не разрешается и остаётся null: штатный `companyId`
    // указывает на карточку контрагента, а расчётный модуль ждёт в этом поле ID сделки
    // категории 5. Перевод делает `linkDealsToCompanies` в fullSync.js — только он видит
    // обе воронки сразу. Подставить сюда карточку значило бы дать «родителя», которого
    // нет в `companies[]`: связь хуже, чем её отсутствие.
    companyId: null,
    // Общий ключ обеих воронок — по нему связь и восстанавливается.
    companyCardId: companyCardId(raw),
    title: textOf(raw, ['title', 'TITLE', 'name', 'NAME'], `Сделка ${id}`),
    sourceId: sourceId || null,
    kevFormatId: kevFormatId || null,
    currentStageId,
    assignedById: idOf(valueOf(raw, ASSIGNEE_KEYS)) || null,
    createdAt: dateField(raw, CREATED_AT_KEYS),
    updatedAt: dateField(raw, UPDATED_AT_KEYS),
    isLost: isDealLost(raw, currentStageId)
  };
}

/**
 * Признак отказа. Три независимых источника, потому что портал сообщает его
 * по-разному: явный флаг, семантика стадии («F» — провал) и стадия из списка отказов.
 * Ошибиться здесь дорого: инвариант 5 требует, чтобы проигранная сделка сохранила путь.
 */
export function isDealLost(raw, currentStageId) {
  const flag = valueOf(raw, ['isLost', 'IS_LOST', 'lost', 'LOST']);
  if (flag !== undefined && boolOf(flag, false)) return true;
  const semantics = textOf(raw, ['stageSemantics', 'STAGE_SEMANTICS', 'semantics', 'SEMANTICS']).toUpperCase();
  if (semantics === 'F' || semantics === 'FAIL' || semantics === 'LOSE') return true;
  return isLostStageId(currentStageId);
}

/**
 * Префикс технических ID стадий у категории сделок: категория 5 → «C5:».
 * Считается из `DEAL_CATEGORY_IDS`, чтобы литералов стадий здесь не было.
 */
const STAGE_PREFIX_BY_FUNNEL = Object.freeze({
  companies: `C${DEAL_CATEGORY_IDS.companies}:`,
  deals: `C${DEAL_CATEGORY_IDS.deals}:`
});

const FUNNEL_BY_DEAL_CATEGORY = Object.freeze({
  [DEAL_CATEGORY_IDS.companies]: 'companies',
  [DEAL_CATEGORY_IDS.deals]: 'deals'
});

/**
 * Запись общего журнала `/v1/stage-history` → событие своей воронки.
 *
 * Журнал приходит ОДНИМ потоком на весь портал: в нём и категории 5/7 (наши две
 * воронки), и посторонние — «Прогрев», «Производство», «Подбор персонала».
 * Поэтому запись разбирается по ДВУМ независимым признакам:
 *
 *   - `categoryId` — что говорит сам портал;
 *   - префикс `stageId` («C5:»/«C7:») — что видно по самой стадии.
 *
 * Решение принимает префикс, а расхождение с категорией отбрасывает запись целиком.
 * Так строже, чем доверять одному полю: `typeId` (значения 1/2/3) в справочнике
 * портала не описан, и строить на нём фильтр — гадание, а префикс стадии
 * самодоказателен. Чужая воронка и запись без владельца/даты не проходят вовсе:
 * событие непонятно чьё и непонятно когда испортило бы обе воронки сразу.
 *
 * @returns {{funnelId: 'companies'|'deals', event: object}|null}
 */
export function stageHistoryEvent(raw) {
  const ownerId = idOf(valueOf(raw, OWNER_KEYS));
  const stageId = canonicalStageId(valueOf(raw, EVENT_STAGE_KEYS) ?? '');
  const at = dateField(raw, EVENT_DATE_KEYS);
  if (!ownerId || !stageId || !at) return null;

  const funnelId = Object.keys(STAGE_PREFIX_BY_FUNNEL)
    .find((id) => stageId.startsWith(STAGE_PREFIX_BY_FUNNEL[id])) ?? null;
  if (!funnelId) return null;

  const category = idOf(valueOf(raw, CATEGORY_KEYS));
  if (category && FUNNEL_BY_DEAL_CATEGORY[category] !== funnelId) return null;

  return funnelId === 'companies'
    ? { funnelId, event: { companyId: ownerId, stageId, at } }
    : { funnelId, event: { dealId: ownerId, stageId, at } };
}

/**
 * Событие смены ответственного: с момента `at` за сущность отвечает `managerId`.
 * На этом держится инвариант 7 — этап относится к тому, кто вёл сущность в тот момент.
 *
 * На портале 3ДБИЛД маршрута истории ответственных НЕТ (`/v1/assignee-history`
 * отвечает 404), поэтому синхронизация эту функцию сейчас не вызывает и
 * `assigneeEvents` всегда пуст. Функция оставлена вместе с разделом снимка и всей
 * цепочкой атрибуции: когда маршрут появится, включение будет в одну строку
 * `fullSync.js`, а не в восстановление удалённой механики.
 */
export function normalizeAssigneeEvent(raw, { entityType = 'deal', entityId = null } = {}) {
  const type = entityType === 'company' ? 'company' : 'deal';
  // Тот же приём, что у normalizeStageEvent: ищем ТОЛЬКО ключ своего типа. Строка
  // сделки может содержать и её companyId (владение), и dealId одновременно —
  // без явного скоупа событие сделки рискует привязаться к ID компании.
  const key = type === 'company' ? 'companyId' : 'dealId';
  const id = idOf(valueOf(raw, [...OWNER_KEYS, key])) || idOf(entityId);
  const managerId = idOf(valueOf(raw, ['managerId', 'toValue', 'TO_VALUE', 'newValue', 'NEW_VALUE', 'value', 'VALUE', ...ASSIGNEE_KEYS]));
  const at = dateField(raw, EVENT_DATE_KEYS);
  if (!id || !managerId || !at) return null;
  return { entityType: type, entityId: id, managerId, at };
}

/** Сотрудник для справочника менеджеров. Имя собирается из того, что портал дал. */
export function normalizeUser(raw) {
  const id = idOf(valueOf(raw, ['id', 'ID']));
  if (!id) return null;
  const composed = [
    textOf(raw, ['lastName', 'LAST_NAME']),
    textOf(raw, ['name', 'NAME', 'firstName', 'FIRST_NAME'])
  ].filter(Boolean).join(' ').trim();
  const name = textOf(raw, ['fullName', 'FULL_NAME', 'title', 'TITLE'])
    || composed
    || textOf(raw, ['email', 'EMAIL'])
    || `Сотрудник ${id}`;
  return { id, name };
}

/**
 * Элемент справочника: значение списка, статус портала, вариант пользовательского поля.
 * Портал называет их `{ID, VALUE}`, `{STATUS_ID, NAME}` и `{id, name}` — все три формы одинаковы по смыслу.
 */
export function normalizeDictionaryItem(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const id = idOf(raw);
    return id ? { id, name: String(raw).trim() || id } : null;
  }
  const id = idOf(valueOf(raw, ['id', 'ID', 'statusId', 'STATUS_ID', 'value', 'VALUE']));
  if (!id) return null;
  const name = textOf(raw, ['name', 'NAME', 'title', 'TITLE', 'value', 'VALUE', 'label', 'LABEL'], id);
  return { id, name };
}

/** Стадия портала как есть: `{id, name}`. Порядок и смысл задаёт доменная конфигурация. */
export function normalizeStage(raw) {
  const id = canonicalStageId(valueOf(raw, ['statusId', 'STATUS_ID', 'stageId', 'STAGE_ID', 'id', 'ID']) ?? '');
  if (!id) return null;
  return { id, name: textOf(raw, ['name', 'NAME', 'title', 'TITLE', 'value', 'VALUE'], id) };
}

/** Сущность, к которой относится набор статусов портала (`SOURCE`, `DEAL_STAGE_7`, …). */
export function statusEntityId(raw) {
  return textOf(raw, ['entityId', 'ENTITY_ID']).toUpperCase();
}

/** Варианты значений пользовательского поля из описания полей портала. */
export function fieldItems(field) {
  const items = valueOf(field, ['items', 'ITEMS', 'values', 'VALUES', 'list', 'LIST']);
  if (!Array.isArray(items)) return [];
  return items.map(normalizeDictionaryItem).filter(Boolean);
}

/** Имя поля внутри его описания — портал называет его по-разному в разных маршрутах. */
const FIELD_NAME_KEYS = ['fieldName', 'FIELD_NAME', 'field', 'FIELD', 'code', 'CODE', 'name', 'NAME', 'id', 'ID'];

/**
 * Имена полей совпадают. Регистр и подчёркивания не учитываются: определения
 * приходят как `UF_CRM_694BF2A975BD0`, а записи — как `ufCrm_694BF2A975BD0`,
 * и это одно и то же поле (то же правило, что в `valueOf` из lib/records.js).
 */
function sameFieldName(left, right) {
  const key = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalized = key(left);
  return normalized !== '' && normalized === key(right);
}

/**
 * Описание одного поля по его идентификатору из ответа со списком полей.
 *
 * Форм ответа три, и все три встречаются: карта «имя → описание» (классический
 * `crm.deal.fields`), тот же объект под ключом `fields`, и МАССИВ описаний под
 * ключом `data` — так отвечает `/v1/userfields/deals` этого портала. Перебираем
 * все три, потому что промах здесь не падает, а тихо оставляет справочник
 * источников без человеческих названий — заметить это на экране трудно.
 */
export function findFieldDescription(fieldsBody, fieldId) {
  if (!fieldId) return null;
  const fields = fieldsBody?.fields ?? fieldsBody?.FIELDS ?? fieldsBody?.data ?? fieldsBody;
  if (!fields || typeof fields !== 'object') return null;
  if (Array.isArray(fields)) {
    return fields.find((item) => sameFieldName(valueOf(item, FIELD_NAME_KEYS), fieldId)) ?? null;
  }
  if (Object.hasOwn(fields, fieldId)) return fields[fieldId];
  for (const [key, value] of Object.entries(fields)) {
    if (sameFieldName(key, fieldId)) return value;
  }
  return null;
}

/**
 * Справочник из значений, реально встреченных в данных. Резервный путь: применяется,
 * когда портал не отдал описание поля. Имя равно идентификатору — честнее, чем выдумать.
 */
export function dictionaryFromValues(values, { name = (id) => id } = {}) {
  const byId = new Map();
  for (const value of values) {
    const id = idOf(value);
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, name: String(name(id)) });
  }
  return [...byId.values()];
}

/* ---------------------------------------------------------------------------
 * ЗВОНКИ
 * ------------------------------------------------------------------------- */

const CALL_ID_KEYS = ['id', 'ID', 'callId', 'CALL_ID'];
const CALL_DATE_KEYS = ['at', 'callStartDate', 'CALL_START_DATE', 'startedAt', 'startTime', 'START_TIME', 'createdAt', 'CREATED', 'DATE_CREATE'];
/** Длительность в СЕКУНДАХ — так её отдаёт телефония Битрикса. */
const CALL_DURATION_SEC_KEYS = ['durationSec', 'duration', 'callDuration', 'CALL_DURATION'];
/** Длительность уже в минутах — форма демо-источника и возможного прокси. */
const CALL_DURATION_MIN_KEYS = ['durationMinutes'];
const CALL_ENTITY_TYPE_KEYS = ['crmEntityType', 'CRM_ENTITY_TYPE', 'entityType', 'ownerType', 'ownerTypeId', 'OWNER_TYPE_ID'];
/** Тип дела CRM: 2 — звонок. У выделенного маршрута телефонии поля нет вовсе. */
const CALL_TYPE_KEYS = ['typeId', 'TYPE_ID'];
const CALL_START_KEYS = ['startTime', 'START_TIME', 'start'];
const CALL_END_KEYS = ['endTime', 'END_TIME', 'end'];
const CALL_COMPLETED_KEYS = ['completed', 'COMPLETED'];
const CALL_ENTITY_ID_KEYS = ['crmEntityId', 'CRM_ENTITY_ID', 'entityId', 'ownerId'];
const CALL_COMPANY_KEYS = ['companyId', 'COMPANY_ID'];
const CALL_DEAL_KEYS = ['dealId', 'DEAL_ID'];
const CALL_SUCCESS_KEYS = ['success', 'successful'];
/** Кто разговаривал. У телефонии — сотрудник портала, у дела CRM — ответственный. */
const CALL_MANAGER_KEYS = ['managerId', 'portalUserId', 'PORTAL_USER_ID', 'responsibleId', 'RESPONSIBLE_ID', 'assignedById', 'ASSIGNED_BY_ID', 'authorId', 'AUTHOR_ID'];
const CALL_FAILED_CODE_KEYS = ['callFailedCode', 'CALL_FAILED_CODE', 'failedCode', 'statusCode'];

function numberOf(raw, keys) {
  const value = valueOf(raw, keys);
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Запись телефонии → звонок снимка.
 *
 * Привязка к сущности НЕ решается здесь: обе воронки — сделки, и по одному
 * `crmEntityId` невозможно сказать, верхняя это сущность или нижняя, не зная
 * обоих списков. Поэтому наружу отдаётся `entityId`, а раскладывает его по
 * `companyId`/`dealId` уже `linkCallsToEntities` в fullSync.js, где оба
 * списка на руках.
 *
 * Успешность: явный флаг, иначе код завершения телефонии (200 — разговор
 * состоялся). Ни того ни другого — звонок считается неуспешным, потому что
 * «успешным по умолчанию» он завысил бы карточку.
 *
 * @returns {{id: string, entityId: string|null, companyId: string|null, dealId: string|null,
 *   at: string, durationMinutes: number, success: boolean}|null}
 */
export function normalizeCall(raw) {
  const id = idOf(valueOf(raw, CALL_ID_KEYS)) || null;
  const at = dateField(raw, CALL_DATE_KEYS);
  if (!id || !at) return null;

  // Дело CRM другого типа (письмо, встреча, задача) звонком не является.
  // Поля нет — значит запись пришла с выделенного маршрута телефонии, где
  // все записи и так звонки.
  const typeId = valueOf(raw, CALL_TYPE_KEYS);
  if (typeId !== undefined && typeId !== null && typeId !== '' && String(typeId) !== '2') return null;

  const minutesDirect = numberOf(raw, CALL_DURATION_MIN_KEYS);
  const seconds = numberOf(raw, CALL_DURATION_SEC_KEYS);
  // У дела CRM длительности нет — она выводится из интервала начала и конца.
  const startMs = Date.parse(dateField(raw, CALL_START_KEYS) ?? '');
  const endMs = Date.parse(dateField(raw, CALL_END_KEYS) ?? '');
  const spanMinutes = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
    ? Math.round(((endMs - startMs) / 60000) * 10) / 10
    : null;
  const durationMinutes = minutesDirect !== null
    ? Math.max(0, minutesDirect)
    : (seconds !== null
      ? Math.max(0, Math.round((seconds / 60) * 10) / 10)
      : Math.max(0, spanMinutes ?? 0));

  const entityType = String(valueOf(raw, CALL_ENTITY_TYPE_KEYS) ?? '').toUpperCase();
  const entityId = idOf(valueOf(raw, CALL_ENTITY_ID_KEYS));

  const explicit = valueOf(raw, CALL_SUCCESS_KEYS);
  const failedCode = valueOf(raw, CALL_FAILED_CODE_KEYS);
  const completed = valueOf(raw, CALL_COMPLETED_KEYS);
  let success = false;
  if (explicit !== undefined && explicit !== null && explicit !== '') success = boolOf(explicit);
  else if (failedCode !== undefined && failedCode !== null && failedCode !== '') success = String(failedCode) === '200';
  // Дело CRM успешности не хранит: ближайшее по смыслу — отметка «завершено».
  else if (completed !== undefined && completed !== null && completed !== '') success = boolOf(completed);

  return {
    id,
    // Тип сущности сохраняем только чтобы не приписать звонок по контакту/лиду
    // сделке с тем же номером — такие записи связи не получают вовсе.
    entityId: entityType === '' || entityType === 'DEAL' || entityType === '2' ? (entityId || null) : null,
    managerId: idOf(valueOf(raw, CALL_MANAGER_KEYS)) || null,
    companyId: idOf(valueOf(raw, CALL_COMPANY_KEYS)) || null,
    dealId: idOf(valueOf(raw, CALL_DEAL_KEYS)) || null,
    at,
    durationMinutes,
    success
  };
}
