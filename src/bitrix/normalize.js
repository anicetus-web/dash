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

import { canonicalStageId, isLostStageId } from '../domain/funnels.js';
import { boolOf, idOf, isoOrNull, textOf, valueOf } from '../lib/records.js';

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. ЕДИНСТВЕННОЕ МЕСТО ПРАВКИ ПОСЛЕ АУДИТА ПОРТАЛА.
 *
 * Идентификаторы пользовательских полей портала 3ДБИЛД на момент разработки
 * НЕИЗВЕСТНЫ: доступа к порталу нет (см. `reference/REQUIRED_INPUTS.md`).
 * Значения ниже — заглушки в служебном пространстве имён `3DB_`. Пока значение
 * остаётся заглушкой, нормализация НЕ обращается к несуществующему полю, а читает
 * стандартные имена Битрикса; список неподтверждённых полей всегда доступен
 * через `pendingAuditFields()` и попадает в предупреждения синхронизации.
 *
 * Технические ID стадий обеих воронок лежат в `src/domain/funnels.js`
 * (`STAGE_TECHNICAL_IDS`, `SERVICE_STAGE_IDS`, `LOST_STAGE_IDS`) — там же и правятся.
 * Часовой пояс портала — переменная окружения `PORTAL_TIMEZONE`.
 * ------------------------------------------------------------------------- */

/** Префикс значения-заглушки. Реальные идентификаторы полей так не начинаются. */
export const PLACEHOLDER_FIELD_PREFIX = '3DB_';

/**
 * Пользовательские поля портала. Ключ — говорящее имя, значение — идентификатор поля
 * в Битриксе (обычно `ufCrm_…`). ЗАМЕНИТЬ ПОСЛЕ АУДИТА ПОРТАЛА.
 */
export const PORTAL_FIELDS = Object.freeze({
  /** Поле базы/источника у компании. */
  companySourceField: '3DB_FIELD:COMPANY_SOURCE',
  /** Поле базы/источника у сделки (переносится автоматизацией из компании). */
  dealSourceField: '3DB_FIELD:DEAL_SOURCE',
  /** Поле формата КЭВ у сделки. */
  dealKevFormatField: '3DB_FIELD:DEAL_KEV_FORMAT',
  /** Поле связи сделки с компанией. */
  dealCompanyLinkField: '3DB_FIELD:DEAL_COMPANY_LINK',
  /** Поле текущей стадии компании (первая воронка ведётся не стандартной стадией сделки). */
  companyStageField: '3DB_FIELD:COMPANY_STAGE',
  /** Поле текущей стадии сделки. */
  dealStageField: '3DB_FIELD:DEAL_STAGE',
  /** Категория (воронка) сделок 3ДБИЛД: по ней отбираются сделки второй воронки. */
  dealCategoryId: '3DB_CATEGORY:DEALS'
});

/** Человеческое описание каждого поля — уходит заказчику в `REQUIRED_INPUTS.md`. */
export const PORTAL_FIELD_DESCRIPTIONS = Object.freeze({
  companySourceField: 'ID поля базы/источника в карточке компании',
  dealSourceField: 'ID поля базы/источника в карточке сделки',
  dealKevFormatField: 'ID поля формата КЭВ в карточке сделки',
  dealCompanyLinkField: 'Поле связи сделки с компанией',
  companyStageField: 'Поле текущей стадии компании (первая воронка)',
  dealStageField: 'Поле текущей стадии сделки (вторая воронка)',
  dealCategoryId: 'Числовой ID категории (воронки) сделок 3ДБИЛД'
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

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 3. НОРМАЛИЗАТОРЫ СУЩНОСТЕЙ.
 * Каждый возвращает либо запись формы снимка, либо `null` — запись без
 * идентификатора бесполезна: её нельзя ни дедуплицировать, ни связать.
 * ------------------------------------------------------------------------- */

/**
 * Компания первой воронки.
 * @returns {{id: string, title: string, sourceId: string|null, currentStageId: string,
 *            assignedById: string|null, createdAt: string|null, updatedAt: string|null}|null}
 */
export function normalizeCompany(raw, fields = {}) {
  const id = idOf(valueOf(raw, ['id', 'ID']));
  if (!id) return null;
  const sourceId = idOf(fieldValue(raw, fields.companySourceField, ['sourceId', 'SOURCE_ID', 'source', 'SOURCE']));
  return {
    id,
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
 * @returns {{id: string, companyId: string|null, title: string, sourceId: string|null,
 *            kevFormatId: string|null, currentStageId: string, assignedById: string|null,
 *            createdAt: string|null, updatedAt: string|null, isLost: boolean}|null}
 */
export function normalizeDeal(raw, fields = {}) {
  const id = idOf(valueOf(raw, ['id', 'ID']));
  if (!id) return null;
  const currentStageId = canonicalStageId(fieldValue(raw, fields.dealStageField, STAGE_KEYS) ?? '');
  const companyId = idOf(fieldValue(raw, fields.dealCompanyLinkField, ['companyId', 'COMPANY_ID', 'company', 'COMPANY']));
  const sourceId = idOf(fieldValue(raw, fields.dealSourceField, ['sourceId', 'SOURCE_ID', 'source', 'SOURCE']));
  const kevFormatId = idOf(fieldValue(raw, fields.dealKevFormatField, ['kevFormatId', 'KEV_FORMAT_ID', 'kevFormat', 'KEV_FORMAT']));
  return {
    id,
    // Сделка без компании в сквозную воронку не попадает — расчётный модуль
    // выдаст об этом предупреждение. Придумывать связь здесь нельзя.
    companyId: companyId || null,
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
 * Событие истории стадий. `entityType` задаёт имя ключа связи, потому что снимок
 * хранит истории двух воронок раздельно: `{companyId|dealId, stageId, at}`.
 */
export function normalizeStageEvent(raw, { entityType = 'deal', entityId = null } = {}) {
  const key = entityType === 'company' ? 'companyId' : 'dealId';
  const id = idOf(valueOf(raw, [...OWNER_KEYS, key])) || idOf(entityId);
  const stageId = canonicalStageId(valueOf(raw, EVENT_STAGE_KEYS) ?? '');
  const at = dateField(raw, EVENT_DATE_KEYS);
  // Событие без сущности, стадии или даты внесло бы сущность неизвестно куда и когда.
  if (!id || !stageId || !at) return null;
  return { [key]: id, stageId, at };
}

/**
 * Событие смены ответственного: с момента `at` за сущность отвечает `managerId`.
 * На этом держится инвариант 7 — этап относится к тому, кто вёл сущность в тот момент.
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
  const items = field?.items ?? field?.ITEMS ?? field?.values ?? field?.VALUES;
  if (!Array.isArray(items)) return [];
  return items.map(normalizeDictionaryItem).filter(Boolean);
}

/** Описание одного поля по его идентификатору из ответа `/{entity}/fields`. */
export function findFieldDescription(fieldsBody, fieldId) {
  if (!fieldId) return null;
  const fields = fieldsBody?.fields ?? fieldsBody?.FIELDS ?? fieldsBody;
  if (!fields || typeof fields !== 'object') return null;
  if (Object.hasOwn(fields, fieldId)) return fields[fieldId];
  const wanted = String(fieldId).toLowerCase();
  for (const [key, value] of Object.entries(fields)) {
    if (String(key).toLowerCase() === wanted) return value;
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
