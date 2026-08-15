import { DEAL_CATEGORY_2D_BIM, RUB } from '../config.js';
import { numberOf, valueOf } from '../lib/records.js';

// Подтверждённые ID новых UF-полей сделки (снято с /deals/fields 07.07.2026).
// Прокси отдаёт ключи полей и raw сделки в camelCase — ID стабильны, ищем по ним, не по label.
export const DEAL_FIELD_IDS = Object.freeze({
  objectType: 'ufCrm_1769063572057',     // Тип объекта (enum)
  need: 'ufCrm_1771482054936',           // Потребность (множественный enum, значения с префиксом «(2D-BIM) »)
  projectRoleNew: 'ufCrm_1783338543497', // Роль в проекте (новое поле — приоритет)
  projectRoleOld: 'ufCrm_1782886702182', // Роль в этом проекте (старое поле — фолбэк)
  city: 'ufCrm_1690191665983',           // Город (address-строка «Город, область, страна|коорд|id»)
  turnover: 'ufCrm_1690191601100',       // Оборот (enum с готовыми диапазонами)
  contractYear: 'ufCrm_1770125160081'    // Год заключения (строка «2023»…«2026»)
});

// Enum → текст. В кэше enum приходят числовыми ID (проверено: turnover=175, objectType=5986),
// но если прокси резолвит ID→VALUE сам — текст пропускаем как есть.
export function enumText(value, items = {}) {
  if (value === undefined || value === null || value === '') return '';
  return String(items[String(value)] || value);
}

// Множественный enum (need, projectRole): массив ID/текстов → массив текстов.
export function enumTexts(value, items = {}) {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => enumText(item, items)).filter(Boolean);
}

// Address-строка Битрикса: «Тверь, Тверская область, Россия|56.85…;35.92…|10654» → «Тверь».
// Бывают укороченные варианты: «Севастополь|;|11900», «Село Фонтаны|;|11896».
export function cityFromAddress(value) {
  return String(value || '').split('|')[0].split(',')[0].trim();
}

// Год заключения: «2026» → 2026; пусто/мусор → null (В6: null → фолбэк на дату события стадии).
export function contractYearOf(value) {
  const year = Number(String(value ?? '').trim());
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

// Потребности заведены с техническим префиксом «(2D-BIM) …» — в фильтрах он шум, срезаем.
export function stripNeedPrefix(value) {
  return String(value || '').replace(/^\(2d-?bim\)\s*/i, '').trim();
}

// Первое НЕпустое значение с учётом пустых массивов множественных enum
// (valueOf их не отличает от заполненных — пустой [] для него «есть значение»).
function firstFilled(raw, keys) {
  for (const key of keys) {
    const value = raw?.[key];
    if (Array.isArray(value) ? value.length : (value !== undefined && value !== null && value !== '')) return value;
  }
  return '';
}

export function normalizeDeal(raw, options = {}) {
  const sourceField = options.sourceField || '';
  const failureReasonField = options.failureReasonField || '';
  const failureReasonItems = options.failureReasonItems || {};
  const clientTypeField = options.clientTypeField || '';
  const clientTypeItems = options.clientTypeItems || {};
  const newFieldItems = options.newFieldItems || {};
  const id = String(valueOf(raw, ['id', 'ID'], ''));
  const amount = numberOf(valueOf(raw, ['amount', 'opportunity', 'OPPORTUNITY', 'sum', 'SUM'], 0));
  const currency = String(valueOf(raw, ['currencyId', 'CURRENCY_ID', 'currency', 'CURRENCY'], RUB) || RUB);
  const sourceId = sourceField
    ? String(valueOf(raw, [sourceField], ''))
    : String(valueOf(raw, ['sourceId', 'SOURCE_ID'], ''));
  const rawFailureReason = failureReasonField ? String(valueOf(raw, [failureReasonField], '')) : '';
  const failureReason = rawFailureReason
    ? String(failureReasonItems[rawFailureReason] || rawFailureReason)
    : String(valueOf(raw, ['failureReason', 'FAILURE_REASON', 'lossReason', 'LOSS_REASON'], ''));
  const rawClientType = clientTypeField ? String(valueOf(raw, [clientTypeField], '')) : '';
  const clientType = rawClientType ? String(clientTypeItems[rawClientType] || rawClientType) : '';

  return {
    id,
    title: String(valueOf(raw, ['title', 'TITLE'], id)),
    categoryId: Number(valueOf(raw, ['categoryId', 'CATEGORY_ID'], DEAL_CATEGORY_2D_BIM)),
    stageId: String(valueOf(raw, ['stageId', 'STAGE_ID'], '')),
    amount,
    currency,
    managerId: String(valueOf(raw, ['assignedById', 'ASSIGNED_BY_ID', 'responsibleId', 'RESPONSIBLE_ID'], '')),
    sourceId,
    failureReason,
    clientType,
    // Новые поля для фильтров (В2-В4) и отбора договоров по году (В6). Пустые: строки → '', множ. → [], год → null.
    objectType: enumText(raw?.[DEAL_FIELD_IDS.objectType], newFieldItems.objectType),
    need: enumTexts(raw?.[DEAL_FIELD_IDS.need], newFieldItems.need).map(stripNeedPrefix).filter(Boolean),
    // Роль: новое поле в приоритете, старое — фолбэк; оба множественные, словари объединены в fullSync.
    projectRole: enumTexts(firstFilled(raw, [DEAL_FIELD_IDS.projectRoleNew, DEAL_FIELD_IDS.projectRoleOld]), newFieldItems.projectRole),
    city: cityFromAddress(raw?.[DEAL_FIELD_IDS.city]),
    turnover: enumText(raw?.[DEAL_FIELD_IDS.turnover], newFieldItems.turnover),
    contractYear: contractYearOf(raw?.[DEAL_FIELD_IDS.contractYear]),
    createdAt: valueOf(raw, ['createdAt', 'DATE_CREATE', 'CREATED_AT'], ''),
    updatedAt: valueOf(raw, ['updatedAt', 'DATE_MODIFY', 'UPDATED_AT'], ''),
    raw
  };
}

export function normalizeStageEvent(raw) {
  const id = String(valueOf(raw, ['id', 'ID'], ''));
  return {
    id,
    dealId: String(valueOf(raw, ['ownerId', 'OWNER_ID', 'dealId', 'DEAL_ID', 'entityId', 'ENTITY_ID'], '')),
    categoryId: Number(valueOf(raw, ['categoryId', 'CATEGORY_ID'], DEAL_CATEGORY_2D_BIM)),
    stageId: String(valueOf(raw, ['stageId', 'STAGE_ID', 'statusId', 'STATUS_ID'], '')),
    createdAt: valueOf(raw, ['createdAt', 'createdTime', 'CREATED_AT', 'CREATED_TIME'], ''),
    raw
  };
}
