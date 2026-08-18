/**
 * Индексация нормализованного снимка.
 *
 * Снимок приходит плоскими массивами — для расчёта нужны быстрые связи
 * «сущность → её события» и «событие → ответственный на тот момент».
 * Индекс строится один раз на запрос и дальше только читается.
 *
 * Здесь нет ни одной бизнес-формулы: только раскладка данных и атрибуция.
 */

import { canonicalStageId, isLostStageId } from '../domain/funnels.js';
import { boolOf, idOf, isoOrNull, numberOf } from '../lib/records.js';

/** Сентинел «значение не заполнено». Используется и в фильтрах, и в справочниках. */
export const NOT_SPECIFIED = '__none__';

/** Коды предупреждений о качестве данных портала. */
export const WARNING_CODES = Object.freeze({
  snapshotEmpty: 'SNAPSHOT_EMPTY',
  sourceMissing: 'SOURCE_MISSING',
  kevMissing: 'KEV_MISSING',
  dealWithoutCompany: 'DEAL_WITHOUT_COMPANY',
  sourceNotInherited: 'SOURCE_NOT_INHERITED',
  assigneeHistoryMissing: 'ASSIGNEE_HISTORY_MISSING',
  placeholderStages: 'PLACEHOLDER_STAGES',
  dealAheadOfCompanyStage: 'DEAL_AHEAD_OF_COMPANY_STAGE',
  // Звонки приходят отдельным разделом снимка и на реальном портале пока
  // не наполняются (телефония не подключена). Без этого предупреждения
  // карточка «Звонки» показывала бы нули как ИЗМЕРЕНИЕ («звонков не было»),
  // а не как отсутствие источника данных.
  callsUnavailable: 'CALLS_UNAVAILABLE',
  // Демо-снимок: цифры сгенерированы, а не получены из портала. Показывается
  // всегда, чтобы демонстрационный дашборд нельзя было принять за боевой.
  demoData: 'DEMO_DATA'
});

function timeOf(value) {
  const iso = isoOrNull(value);
  return iso === null ? null : Date.parse(iso);
}

/**
 * Звонки в единой форме: идентификаторы — строками (как ключи Map компаний
 * и сделок), момент — разобранным временем, длительность — числом, признак
 * успеха — булевым через `boolOf` (он знает про 'Y'/'N' Битрикса).
 *
 * Запись без разбираемого момента отбрасывается: звонок, который нельзя
 * положить ни в один период, не должен попадать ни в итог, ни в график —
 * иначе «всего» и сумма по столбцам графика разойдутся.
 */
function normalizeCalls(rows) {
  const calls = [];
  for (const row of rows || []) {
    const atMs = timeOf(row?.at);
    if (atMs === null) continue;
    calls.push({
      id: idOf(row?.id) || null,
      companyId: idOf(row?.companyId) || null,
      dealId: idOf(row?.dealId) || null,
      at: isoOrNull(row?.at),
      atMs,
      durationMinutes: Math.max(0, numberOf(row?.durationMinutes)),
      success: boolOf(row?.success)
    });
  }
  return calls;
}

/**
 * Сортировка событий: по времени, при равенстве — в исходном порядке.
 * Устойчивость важна: два события одной секунды не должны менять
 * местами порядок прохождения этапов от запуска к запуску.
 */
function sortEvents(events) {
  return events
    .map((event, order) => ({ event, order }))
    .sort((a, b) => (a.event.at - b.event.at) || (a.order - b.order))
    .map((item) => item.event);
}

function groupEvents(rows, entityKey) {
  const byEntity = new Map();
  for (const row of rows || []) {
    const entityId = idOf(row?.[entityKey]);
    const stageId = canonicalStageId(row?.stageId);
    const at = timeOf(row?.at);
    // Событие без сущности, без стадии или без даты бесполезно для расчёта:
    // включить его — значит внести в воронку сущность неизвестно когда и куда.
    if (!entityId || !stageId || at === null) continue;
    if (!byEntity.has(entityId)) byEntity.set(entityId, []);
    byEntity.get(entityId).push({ entityId, stageId, at });
  }
  for (const [entityId, events] of byEntity) byEntity.set(entityId, sortEvents(events));
  return byEntity;
}

/**
 * Хронология ответственных по сущности.
 * Ключ — `тип:идентификатор`, чтобы компания 12 и сделка 12 не смешались.
 */
function buildAssigneeTimeline(rows) {
  const timeline = new Map();
  for (const row of rows || []) {
    const entityType = row?.entityType === 'company' ? 'company' : row?.entityType === 'deal' ? 'deal' : null;
    const entityId = idOf(row?.entityId);
    const managerId = idOf(row?.managerId);
    const at = timeOf(row?.at);
    if (!entityType || !entityId || !managerId || at === null) continue;
    const key = `${entityType}:${entityId}`;
    if (!timeline.has(key)) timeline.set(key, []);
    timeline.get(key).push({ managerId, at });
  }
  for (const [key, rows_] of timeline) {
    timeline.set(key, rows_.map((r, order) => ({ ...r, order }))
      .sort((a, b) => (a.at - b.at) || (a.order - b.order)));
  }
  return timeline;
}

function dictionary(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    const id = idOf(row?.id);
    if (!id) continue;
    byId.set(id, String(row?.name ?? '').trim() || id);
  }
  return byId;
}

/**
 * Кэш индекса, ключ — САМ объект снимка.
 *
 * Индекс — чистая функция снимка, но строится он дорого: на портале в 5000
 * компаний это ~170 мс, три четверти времени всего запроса, и раньше он
 * пересобирался заново на КАЖДЫЙ запрос каждого пользователя, хотя данные
 * между синхронизациями не меняются вовсе.
 *
 * Ключ — идентичность объекта, а не версия или хэш, и это принципиально:
 * `JsonStore` держит снимок одним и тем же объектом в памяти и заменяет его
 * НОВЫМ объектом при каждой успешной записи (`save()` собирает `{...}`).
 * Поэтому попадание в кэш возможно только для буквально того же снимка, а
 * новая синхронизация промахивается сама — инвалидировать вручную нечего,
 * и отдать индекс от чужого снимка физически невозможно.
 *
 * WeakMap, а не Map: прежний снимок после синхронизации никто не держит,
 * и его индекс собирается сборщиком мусора вместе с ним. Кэш не растёт.
 */
const indexCache = new WeakMap();

/**
 * Индексированный снимок.
 *
 * @param {object} snapshot нормализованный снимок из хранилища
 * @returns {object} индекс со связями, справочниками и атрибуцией
 */
export function buildIndex(snapshot) {
  if (snapshot && typeof snapshot === 'object') {
    const cached = indexCache.get(snapshot);
    if (cached) return cached;
    const built = buildIndexUncached(snapshot);
    indexCache.set(snapshot, built);
    return built;
  }
  return buildIndexUncached(snapshot);
}

/** Сборка индекса без кэша. Отдельно — чтобы кэш можно было проверить в обход. */
export function buildIndexUncached(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};

  const companies = new Map();
  for (const row of source.companies || []) {
    const id = idOf(row?.id);
    if (!id) continue;
    companies.set(id, {
      id,
      title: String(row?.title ?? '').trim() || `Компания ${id}`,
      sourceId: idOf(row?.sourceId) || NOT_SPECIFIED,
      currentStageId: canonicalStageId(row?.currentStageId),
      assignedById: idOf(row?.assignedById) || null,
      createdAt: timeOf(row?.createdAt)
    });
  }

  const deals = new Map();
  const dealsByCompany = new Map();
  let dealsWithoutCompany = 0;
  for (const row of source.deals || []) {
    const id = idOf(row?.id);
    if (!id) continue;
    const companyId = idOf(row?.companyId) || null;
    const currentStageId = canonicalStageId(row?.currentStageId);
    const deal = {
      id,
      companyId,
      title: String(row?.title ?? '').trim() || `Сделка ${id}`,
      sourceId: idOf(row?.sourceId) || NOT_SPECIFIED,
      kevFormatId: idOf(row?.kevFormatId) || NOT_SPECIFIED,
      currentStageId,
      assignedById: idOf(row?.assignedById) || null,
      createdAt: timeOf(row?.createdAt),
      // Признак отказа: либо явным флагом снимка, либо текущей стадией отказа.
      isLost: row?.isLost === true || isLostStageId(currentStageId)
    };
    deals.set(id, deal);
    if (companyId && companies.has(companyId)) {
      if (!dealsByCompany.has(companyId)) dealsByCompany.set(companyId, []);
      dealsByCompany.get(companyId).push(deal);
    } else {
      // Сделка без компании не может участвовать в сквозной воронке:
      // связь «компания → потребность → сделка» разорвана.
      dealsWithoutCompany += 1;
    }
  }

  // Источник обязан переноситься в дочернюю сделку автоматизацией Битрикса.
  // Если он не совпадает с источником компании, срез по базе будет тихо
  // терять сделки — это дефект настройки портала, и о нём нужно сказать вслух.
  let dealsWithForeignSource = 0;
  for (const deal of deals.values()) {
    if (!deal.companyId) continue;
    const owner = companies.get(deal.companyId);
    if (!owner) continue;
    // Источник компании должен быть известен, чтобы сравнение вообще было
    // осмысленным — но у сделки он как раз может быть ПУСТ: это и есть самый
    // частый реальный случай («автоматизация не отработала»), и предупреждение
    // существует прежде всего ради него, а не только ради разных явных значений.
    if (owner.sourceId !== NOT_SPECIFIED && deal.sourceId !== owner.sourceId) {
      dealsWithForeignSource += 1;
    }
  }

  const companyEvents = groupEvents(source.companyStageEvents, 'companyId');
  const dealEvents = groupEvents(source.dealStageEvents, 'dealId');
  const assigneeTimeline = buildAssigneeTimeline(source.assigneeEvents);

  return {
    companies,
    deals,
    dealsByCompany,
    companyEvents,
    dealEvents,
    assigneeTimeline,
    managers: dictionary(source.managers),
    sources: dictionary(source.sources),
    kevFormats: dictionary(source.kevFormats),
    portalTimezone: source.portalTimezone || null,
    updatedAt: source.updatedAt || null,
    // Имя переменной ('source') намеренно совпадает с полем снимка ('source.source' =
    // 'demo' | 'bitrix'): без явного переноса это поле нигде не появлялось бы
    // в индексе, и freshness.source в ответе API всегда был бы null.
    source: source.source ?? null,
    sync: source.sync || null,
    dataQuality: source.dataQuality || null,
    // Звонки не раскладываются по сущностям (у них нет стадий и в воронке они не
    // участвуют), но проходят ТУ ЖЕ нормализацию, что компании и сделки. Это не
    // формальность: связи ищутся по идентификаторам из тех же Map, и числовой ID
    // из портала (REST отдаёт числа) не совпал бы со строковым ключом — ни один
    // звонок не попал бы в срез, а карточка молча показала бы нули. Точно так же
    // длительность строкой давала бы склейку строк вместо суммы минут, а 'N'
    // Битрикса — «успешный звонок», потому что непустая строка истинна.
    calls: normalizeCalls(source.calls),
    counts: {
      companies: companies.size,
      deals: deals.size,
      companyStageEvents: companyEvents.size,
      dealStageEvents: dealEvents.size,
      dealsWithoutCompany,
      dealsWithForeignSource
    },
    // Есть ли вообще история ответственных. Влияет на достоверность фильтра
    // по менеджеру и на предупреждение в интерфейсе.
    hasAssigneeHistory: assigneeTimeline.size > 0
  };
}

/** События сущности по типу. Всегда массив, отсортированный по времени. */
export function eventsOf(index, entityType, entityId) {
  const map = entityType === 'company' ? index.companyEvents : index.dealEvents;
  return map.get(entityId) || [];
}

/**
 * Ответственный за сущность на момент времени.
 *
 * Инвариант 7: этап относится к тому, кто вёл сущность в момент прохождения,
 * а не к текущему ответственному. Ищем последнюю запись хронологии, начавшуюся
 * не позже события.
 *
 * Фолбэк — текущий ответственный. Он используется, когда хронологии нет вовсе
 * или событие произошло раньше первой записи. Это не ошибка и не повод потерять
 * сущность, но пользователь должен знать: расчёт помечается предупреждением.
 *
 * @returns {{managerId: string|null, exact: boolean}} `exact:false` — сработал фолбэк
 */
export function managerAt(index, entityType, entityId, at) {
  const rows = index.assigneeTimeline.get(`${entityType}:${entityId}`);
  const entity = entityType === 'company' ? index.companies.get(entityId) : index.deals.get(entityId);
  const current = entity?.assignedById ?? null;

  if (!rows || rows.length === 0) return { managerId: current, exact: false };

  // Двоичный поиск последней записи с `at` не позже момента события.
  let low = 0;
  let high = rows.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (rows[mid].at <= at) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (found === -1) {
    // Событие раньше первой известной записи: истории на этот момент нет.
    return { managerId: current, exact: false };
  }
  return { managerId: rows[found].managerId, exact: true };
}
