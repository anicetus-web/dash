/**
 * Доменная конфигурация двух воронок 3ДБИЛД.
 *
 * Здесь воронки описаны ДАННЫМИ: этапы, порядок, единица учёта, точка соединения,
 * правило отката. Остальная система (расчётный модуль, API, интерфейс, XLSX,
 * генератор демо-снимка) спрашивает у этого модуля индексы и ID и НИКОГДА
 * не пишет технические ID стадий литералами.
 *
 * Ключевые инварианты (CONTEXT.md):
 *   - индекс этапа задан числом в конфиге, а не выводится из позиции в массиве;
 *   - стадия вне воронки (создана, отказ, неизвестная) даёт индекс -1 — на этом держится вся математика;
 *   - откат компании (воронка 1) НЕ стирает историю (инвариант 3);
 *   - откат активной сделки (воронка 2) обрезает глубину текущей стадией (инвариант 4);
 *   - «Потребность выявлена» — одна логическая ступень: последняя в первой воронке
 *     и первая во второй, с двумя счётчиками (компании и сделки-потребности).
 */

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. ЕДИНСТВЕННОЕ МЕСТО ПРАВКИ ПОСЛЕ АУДИТА ПОРТАЛА.
 *
 * Технические ID стадий Битрикс24 на момент разработки НЕИЗВЕСТНЫ: доступа
 * к порталу нет (см. reference/REQUIRED_INPUTS.md). Все ID ниже — заглушки
 * в служебном пространстве имён `3DB_` и ПОДЛЕЖАТ ЗАМЕНЕ после аудита.
 *
 * Подстановка реальных ID = правка только этого раздела. Ни одна строка кода
 * ниже раздела 2 не меняется: логическая структура воронок берёт ID отсюда.
 * Список ещё не заменённых ID всегда доступен через `pendingAuditStageIds()`.
 * ------------------------------------------------------------------------- */

/** Префикс ID-заглушки. Реальные ID Битрикса так не начинаются. */
export const PLACEHOLDER_STAGE_ID_PREFIX = '3DB_';

/**
 * Категории сделок портала, из которых собираются обе воронки.
 *
 * ВАЖНО про модель данных: обе воронки — это КАТЕГОРИИ СДЕЛОК, а не разные
 * сущности CRM. «Компании» в терминах спеки — не карточка контрагента, а сделка
 * категории 5; путь клиента идёт «сделка категории 5 → сделка категории 7».
 * Сущность company в портале тоже есть (справочник контрагентов), но воронка
 * по ней не ведётся, и у части сделок категории 5 companyId вовсе равен нулю.
 * Подтверждено запросом к порталу, см. reference/PORTAL-AUDIT.md.
 */
export const DEAL_CATEGORY_IDS = Object.freeze({
  companies: '5',
  deals: '7'
});

/**
 * Технические ID положительных этапов: воронка → роль этапа → ID стадии Битрикса.
 * Роль — стабильное латинское имя этапа, по нему обращается вся система.
 *
 * Значения получены с портала 3db.bitrix24.ru
 * (`GET /v1/statuses?entityId=DEAL_STAGE_5` и `…_7`), сверены по названиям
 * этапов со спекой. Полная таблица с человеческими названиями —
 * reference/PORTAL-AUDIT.md.
 */
export const STAGE_TECHNICAL_IDS = Object.freeze({
  companies: Object.freeze({
    newCompany: 'C5:NEW',
    takenToWork: 'C5:PREPARATION',
    firstContact: 'C5:PREPAYMENT_INVOICE',
    decisionMaker: 'C5:EXECUTING',
    qualified: 'C5:UC_7QWHT0',
    needIdentified: 'C5:UC_AZL6WP'
  }),
  deals: Object.freeze({
    needIdentified: 'C7:NEW',
    inputsReceived: 'C7:PREPARATION',
    proposalSent: 'C7:PREPAYMENT_INVOICE',
    proposalDefended: 'C7:EXECUTING',
    requisitesReceived: 'C7:UC_GAWZUY',
    contractApproval: 'C7:UC_8HFSOU',
    contractSentForSigning: 'C7:UC_6O8IIA',
    contractSigned: 'C7:UC_P1SU47',
    advanceReceived: 'C7:UC_XKA0YI',
    handedToProduction: 'C7:WON'
  })
});

/**
 * Служебные стадии: сущность в них существует, но этапом воронки они не является.
 * Дают индекс -1 и не участвуют в математике.
 *
 * `C5:UC_WM901D` («Есть реализованные проекты») и `C5:WON` («Не завершать») —
 * стадии портала вне последовательности спеки: они не отменяют пройденный путь,
 * но и этапом воронки не считаются.
 */
export const SERVICE_STAGE_IDS = Object.freeze({
  companies: Object.freeze(['C5:UC_WM901D', 'C5:WON']),
  deals: Object.freeze([])
});

/**
 * Стадии отказа. Отказ отделён от положительных этапов: он НЕ этап воронки,
 * не ломает индексацию и отдельным показателем в MVP не выводится (инвариант 5).
 * Механика сохранения пути проигранной сделки: её текущая стадия лежит вне воронки,
 * поэтому `capReachedIndexByCurrentStage` не обрезает достигнутую глубину.
 *
 * Список — все стадии портала с семантикой failure/apology в обеих категориях.
 */
export const LOST_STAGE_IDS = Object.freeze({
  companies: Object.freeze([
    'C5:LOSE', 'C5:APOLOGY', 'C5:UC_ORZ0O0', 'C5:UC_VBWH03', 'C5:UC_9PV7IP',
    'C5:UC_6YX7KV', 'C5:UC_1K2EB2', 'C5:UC_NB0TTC', 'C5:UC_RZ6E7U', 'C5:UC_ZIYUNO',
    'C5:UC_RHVA2K', 'C5:UC_ZLR1YD', 'C5:1', 'C5:UC_7XS624'
  ]),
  deals: Object.freeze([
    'C7:APOLOGY', 'C7:UC_4ZAQ8B', 'C7:UC_YM5NXD', 'C7:UC_8531TU',
    'C7:UC_DMBNWW', 'C7:UC_1KD8FB', 'C7:UC_7BIOKN', 'C7:LOSE'
  ])
});

/**
 * Алиасы стадий: `альтернативный ID` → `канонический ID`.
 * Сюда попадают технические ID, которые портал отдаёт для той же логической стадии:
 * переименованные стадии, дубли воронки в другой категории, короткие формы без префикса.
 *
 * Пусто: на аудите портала таких расхождений не нашлось — каждая стадия обеих
 * категорий имеет ровно один ID. Таблица оставлена как готовое место для случая,
 * когда воронку в портале переименуют или заведут дубль в другой категории.
 */
export const STAGE_ALIASES = Object.freeze({});

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 2. ЛОГИЧЕСКАЯ СТРУКТУРА ВОРОНОК.
 * Аудит портала её не меняет: порядок и состав этапов зафиксированы спекой.
 * ------------------------------------------------------------------------- */

/** Единица учёта. До точки соединения — компания, после — сделка. */
export const UNITS = Object.freeze({ company: 'company', deal: 'deal' });

/** Идентификаторы воронок. */
export const FUNNEL_IDS = Object.freeze({ companies: 'companies', deals: 'deals' });

/**
 * Правило отката. Правила двух воронок ПРОТИВОПОЛОЖНЫ, поэтому они лежат
 * в конфигурации воронки, а не в расчётном модуле: перепутать их нельзя.
 */
export const ROLLBACK_POLICIES = Object.freeze({
  /** Воронка 1: используется исторически максимально достигнутый этап (инвариант 3). */
  keepHistoricalMax: 'keepHistoricalMax',
  /** Воронка 2: глубина активной сделки ограничена её текущей стадией (инвариант 4). */
  capByCurrentStage: 'capByCurrentStage'
});

// Точка соединения объявлена ОДИН раз и подставляется в обе воронки,
// чтобы название и признаки стыка нельзя было рассогласовать правкой одной стороны.
const JUNCTION_ROLE = 'needIdentified';
const JUNCTION_NAME = 'Потребность выявлена';
const JUNCTION_PLURAL_NAME = 'Потребности выявлены';

/** Роль этапа, с которого набирается когорта Статики (первый вход «Взят в работу»). */
const COHORT_ENTRY_ROLE = 'takenToWork';
/** Роль этапа коммерческого результата — конец главной конверсии. */
const COMMERCIAL_RESULT_ROLE = 'advanceReceived';

const COMPANIES_FUNNEL_DEFINITION = {
  id: FUNNEL_IDS.companies,
  title: 'Компании',
  unit: UNITS.company,
  rollbackPolicy: ROLLBACK_POLICIES.keepHistoricalMax,
  rollbackNote: 'Откат компании не стирает достигнутые этапы: берётся исторический максимум.',
  stages: [
    { index: 0, role: 'newCompany', name: 'Новая компания', id: STAGE_TECHNICAL_IDS.companies.newCompany },
    { index: 1, role: 'takenToWork', name: 'Взят в работу', id: STAGE_TECHNICAL_IDS.companies.takenToWork },
    { index: 2, role: 'firstContact', name: 'Первичный контакт установлен', id: STAGE_TECHNICAL_IDS.companies.firstContact },
    { index: 3, role: 'decisionMaker', name: 'Вышел на ЛПР', id: STAGE_TECHNICAL_IDS.companies.decisionMaker },
    { index: 4, role: 'qualified', name: 'Квалификация пройдена', id: STAGE_TECHNICAL_IDS.companies.qualified },
    {
      index: 5,
      role: JUNCTION_ROLE,
      name: JUNCTION_NAME,
      id: STAGE_TECHNICAL_IDS.companies.needIdentified,
      junction: true,
      dualCount: true
    }
  ]
};

const DEALS_FUNNEL_DEFINITION = {
  id: FUNNEL_IDS.deals,
  title: 'Сделки',
  unit: UNITS.deal,
  rollbackPolicy: ROLLBACK_POLICIES.capByCurrentStage,
  rollbackNote: 'Откат активной сделки убирает её с этапов выше текущей стадии; проигранная сделка сохраняет путь.',
  stages: [
    {
      index: 0,
      role: JUNCTION_ROLE,
      name: JUNCTION_NAME,
      id: STAGE_TECHNICAL_IDS.deals.needIdentified,
      junction: true,
      dualCount: true
    },
    { index: 1, role: 'inputsReceived', name: 'Исходные данные получены', id: STAGE_TECHNICAL_IDS.deals.inputsReceived },
    { index: 2, role: 'proposalSent', name: 'КП отправлено', id: STAGE_TECHNICAL_IDS.deals.proposalSent },
    { index: 3, role: 'proposalDefended', name: 'КП защищено', id: STAGE_TECHNICAL_IDS.deals.proposalDefended },
    { index: 4, role: 'requisitesReceived', name: 'Реквизиты получены', id: STAGE_TECHNICAL_IDS.deals.requisitesReceived },
    { index: 5, role: 'contractApproval', name: 'Согласование договора', id: STAGE_TECHNICAL_IDS.deals.contractApproval },
    { index: 6, role: 'contractSentForSigning', name: 'Договор отправлен на подпись', id: STAGE_TECHNICAL_IDS.deals.contractSentForSigning },
    { index: 7, role: 'contractSigned', name: 'Договор подписан', id: STAGE_TECHNICAL_IDS.deals.contractSigned },
    { index: 8, role: COMMERCIAL_RESULT_ROLE, name: 'Аванс получен', id: STAGE_TECHNICAL_IDS.deals.advanceReceived, commercialResult: true },
    {
      index: 9,
      role: 'handedToProduction',
      name: 'Передано в производство',
      id: STAGE_TECHNICAL_IDS.deals.handedToProduction,
      // Операционная ступень ПОСЛЕ коммерческого результата: главную конверсию не заменяет.
      operational: true
    }
  ]
};

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 3. СБОРКА И ИНДЕКСЫ.
 * ------------------------------------------------------------------------- */

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function buildFunnel(definition) {
  const stages = definition.stages.map((stage) =>
    Object.freeze({
      ...stage,
      junction: stage.junction === true,
      dualCount: stage.dualCount === true,
      funnelId: definition.id,
      unit: definition.unit
    })
  );
  return deepFreeze({ ...definition, stages: Object.freeze(stages) });
}

const COMPANIES_FUNNEL = buildFunnel(COMPANIES_FUNNEL_DEFINITION);
const DEALS_FUNNEL = buildFunnel(DEALS_FUNNEL_DEFINITION);

/** Обе воронки: `FUNNELS.companies`, `FUNNELS.deals`. */
export const FUNNELS = Object.freeze({
  [FUNNEL_IDS.companies]: COMPANIES_FUNNEL,
  [FUNNEL_IDS.deals]: DEALS_FUNNEL
});

/** Воронки по порядку прохождения: сначала компании, затем сделки. */
export const FUNNEL_LIST = Object.freeze([COMPANIES_FUNNEL, DEALS_FUNNEL]);

const FUNNEL_BY_ID = new Map(FUNNEL_LIST.map((funnel) => [funnel.id, funnel]));

// Map «ID стадии → этап» отдельно на каждую воронку: у стыка ДВА разных
// технических ID (стадия компании и стадия сделки), это разные записи.
const STAGE_BY_ID = new Map(
  FUNNEL_LIST.map((funnel) => [funnel.id, new Map(funnel.stages.map((stage) => [stage.id, stage]))])
);

// Глобальный поиск по ID: технические ID уникальны в пределах всей системы
// (проверяется `validateFunnelConfig`).
const GLOBAL_STAGE_BY_ID = new Map();
for (const funnel of FUNNEL_LIST) {
  for (const stage of funnel.stages) GLOBAL_STAGE_BY_ID.set(stage.id, stage);
}

const SERVICE_ID_SET = new Set(Object.values(SERVICE_STAGE_IDS).flat());
const LOST_ID_SET = new Set(Object.values(LOST_STAGE_IDS).flat());

/** Описание точки соединения. Обе стороны стыка читаются отсюда, а не литералами. */
export const JUNCTION = deepFreeze({
  role: JUNCTION_ROLE,
  name: JUNCTION_NAME,
  pluralName: JUNCTION_PLURAL_NAME,
  dualCount: true,
  units: [UNITS.company, UNITS.deal],
  companyStageId: STAGE_TECHNICAL_IDS.companies.needIdentified,
  dealStageId: STAGE_TECHNICAL_IDS.deals.needIdentified,
  companyIndex: COMPANIES_FUNNEL.stages.at(-1).index,
  dealIndex: DEALS_FUNNEL.stages[0].index
});

const JUNCTION_ID_SET = new Set([JUNCTION.companyStageId, JUNCTION.dealStageId]);

/**
 * Сквозная последовательность ступеней для конверсий: воронка 1 целиком,
 * затем воронка 2 без стыка (стык встречается ровно один раз, позиция 5).
 * Позиция — сквозной порядковый номер ступени, не путать с индексом внутри воронки.
 */
export const CROSS_FUNNEL_SEQUENCE = deepFreeze([
  ...COMPANIES_FUNNEL.stages.map((stage) => ({
    position: stage.index,
    role: stage.role,
    name: stage.name,
    junction: stage.junction,
    units: stage.junction ? [UNITS.company, UNITS.deal] : [UNITS.company],
    stageIds: stage.junction
      ? { companies: JUNCTION.companyStageId, deals: JUNCTION.dealStageId }
      : { companies: stage.id }
  })),
  ...DEALS_FUNNEL.stages.slice(1).map((stage) => ({
    position: COMPANIES_FUNNEL.stages.at(-1).index + stage.index,
    role: stage.role,
    name: stage.name,
    junction: false,
    units: [UNITS.deal],
    stageIds: { deals: stage.id }
  }))
]);

const POSITION_BY_STAGE_ID = new Map();
for (const step of CROSS_FUNNEL_SEQUENCE) {
  for (const id of Object.values(step.stageIds)) POSITION_BY_STAGE_ID.set(id, step.position);
}

/** Ступень входа в когорту Статики: первый переход компании на «Взят в работу». */
export const COHORT_ENTRY = deepFreeze({
  funnelId: FUNNEL_IDS.companies,
  role: COHORT_ENTRY_ROLE,
  name: COMPANIES_FUNNEL.stages.find((stage) => stage.role === COHORT_ENTRY_ROLE).name,
  stageId: STAGE_TECHNICAL_IDS.companies[COHORT_ENTRY_ROLE]
});

/** Главная коммерческая конверсия: «Взят в работу» → «Аванс получен». */
export const MAIN_CONVERSION = deepFreeze({
  from: {
    funnelId: FUNNEL_IDS.companies,
    role: COHORT_ENTRY_ROLE,
    name: COHORT_ENTRY.name,
    stageId: STAGE_TECHNICAL_IDS.companies[COHORT_ENTRY_ROLE],
    unit: UNITS.company
  },
  to: {
    funnelId: FUNNEL_IDS.deals,
    role: COMMERCIAL_RESULT_ROLE,
    name: DEALS_FUNNEL.stages.find((stage) => stage.role === COMMERCIAL_RESULT_ROLE).name,
    stageId: STAGE_TECHNICAL_IDS.deals[COMMERCIAL_RESULT_ROLE],
    unit: UNITS.deal
  }
});

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 4. ПУБЛИЧНЫЕ ФУНКЦИИ.
 * `canonicalStageId` применяется В КАЖДОЙ точке входа: событие истории,
 * текущая стадия сущности, параметр среза из API.
 * ------------------------------------------------------------------------- */

const ALIAS_MAX_HOPS = 5;

/**
 * Приводит ID стадии к каноническому виду: обрезает пробелы, приводит число
 * к строке, разрешает алиасы (в том числе цепочку). Неизвестное значение
 * возвращается как есть, пустое — как пустая строка.
 */
export function canonicalStageId(stageId) {
  if (stageId === null || stageId === undefined) return '';
  const raw = (typeof stageId === 'string' ? stageId : String(stageId)).trim();
  if (raw === '') return '';
  let id = raw;
  for (let hop = 0; hop < ALIAS_MAX_HOPS; hop += 1) {
    if (!Object.hasOwn(STAGE_ALIASES, id)) return id;
    const next = STAGE_ALIASES[id];
    if (typeof next !== 'string' || next === id) return id;
    id = next;
  }
  return id;
}

/**
 * Принимает идентификатор воронки (`'companies'` / `'deals'`) или саму воронку.
 * Неизвестная воронка — ошибка, а не молчаливый ноль: иначе опечатка в имени
 * воронки обнулила бы весь расчёт незаметно.
 */
export function resolveFunnel(funnel) {
  if (typeof funnel === 'string' && FUNNEL_BY_ID.has(funnel)) return FUNNEL_BY_ID.get(funnel);
  if (funnel && typeof funnel === 'object' && FUNNEL_BY_ID.get(funnel.id) === funnel) return funnel;
  const known = [...FUNNEL_BY_ID.keys()].join(', ');
  const got = typeof funnel === 'object' && funnel !== null ? JSON.stringify(funnel.id) : String(funnel);
  throw new RangeError(`Неизвестная воронка: ${got}. Допустимые значения: ${known}`);
}

/** Этапы воронки в порядке прохождения. */
export function funnelStages(funnel) {
  return resolveFunnel(funnel).stages;
}

/** Единица учёта воронки: `'company'` или `'deal'`. */
export function unitOfAccount(funnel) {
  return resolveFunnel(funnel).unit;
}

/** Этап воронки по ID стадии или `null`, если стадия в эту воронку не входит. */
export function stageById(funnel, stageId) {
  const funnelObject = resolveFunnel(funnel);
  return STAGE_BY_ID.get(funnelObject.id).get(canonicalStageId(stageId)) ?? null;
}

/**
 * Индекс этапа в воронке. `-1` — стадия в воронку не входит: неизвестная,
 * служебная («создана»), отказ или этап соседней воронки.
 * На этом инварианте держится вся математика воронки.
 */
export function stageIndex(funnel, stageId) {
  return stageById(funnel, stageId)?.index ?? -1;
}

/** Стадия является положительным этапом этой воронки. */
export function isTrackedStage(funnel, stageId) {
  return stageById(funnel, stageId) !== null;
}

/** Этап воронки по роли. Неизвестная роль — ошибка: опечатка не должна тихо давать `undefined`. */
export function stageByRole(funnel, role) {
  const funnelObject = resolveFunnel(funnel);
  const stage = funnelObject.stages.find((item) => item.role === role);
  if (!stage) {
    const known = funnelObject.stages.map((item) => item.role).join(', ');
    throw new RangeError(`Неизвестная роль этапа «${String(role)}» в воронке «${funnelObject.id}». Известные роли: ${known}`);
  }
  return stage;
}

/** Технический ID стадии по роли этапа. Единственный разрешённый способ получить ID в коде. */
export function stageIdByRole(funnel, role) {
  return stageByRole(funnel, role).id;
}

/** Глобальный поиск этапа по ID: `{ funnelId, stage }` или `null`. */
export function findStage(stageId) {
  const stage = GLOBAL_STAGE_BY_ID.get(canonicalStageId(stageId));
  return stage ? { funnelId: stage.funnelId, stage } : null;
}

/** Стадия — точка соединения (в любой из двух воронок). */
export function isJunctionStage(stageId) {
  return JUNCTION_ID_SET.has(canonicalStageId(stageId));
}

/** Стадия — отказ. Отказ не является этапом воронки и не участвует в индексации. */
export function isLostStageId(stageId) {
  return LOST_ID_SET.has(canonicalStageId(stageId));
}

/** Стадия — служебная (создана и т. п.): существует в портале, но этапом воронки не является. */
export function isServiceStageId(stageId) {
  return SERVICE_ID_SET.has(canonicalStageId(stageId));
}

/** Сквозная позиция ступени в объединённой воронке или `-1`. */
export function crossFunnelPosition(stageId) {
  return POSITION_BY_STAGE_ID.get(canonicalStageId(stageId)) ?? -1;
}

/**
 * Ограничивает достигнутую глубину текущей стадией сущности.
 *
 * Правила двух воронок противоположны и берутся из конфигурации воронки:
 *   - воронка «Компании» (`keepHistoricalMax`) — обрезки нет никогда: откат
 *     не стирает исторически достигнутые этапы (инвариант 3);
 *   - воронка «Сделки» (`capByCurrentStage`) — глубина активной сделки
 *     ограничена её текущей стадией (инвариант 4).
 *
 * `currentIndex < 0` (отказ, служебная или неизвестная стадия) — обрезки нет:
 * так проигранная сделка сохраняет путь, достигнутый до отказа (инвариант 5).
 * Обрезка только понижает глубину: текущая стадия выше достигнутой её не поднимает.
 */
export function capReachedIndexByCurrentStage(funnel, reachedIndex, currentStageId) {
  const funnelObject = resolveFunnel(funnel);
  if (!Number.isInteger(reachedIndex)) {
    throw new TypeError(`Достигнутый индекс должен быть целым числом, получено: ${String(reachedIndex)}`);
  }
  if (funnelObject.rollbackPolicy !== ROLLBACK_POLICIES.capByCurrentStage) return reachedIndex;
  const currentIndex = stageIndex(funnelObject, currentStageId);
  if (currentIndex < 0) return reachedIndex;
  return Math.min(reachedIndex, currentIndex);
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 5. СОСТОЯНИЕ КОНФИГУРАЦИИ.
 * ------------------------------------------------------------------------- */

/** ID является заглушкой, подлежащей замене после аудита портала. */
export function isPlaceholderStageId(stageId) {
  const id = canonicalStageId(stageId);
  return id.startsWith(PLACEHOLDER_STAGE_ID_PREFIX);
}

/**
 * Перечисляет технические ID, которые всё ещё остаются заглушками.
 * Пустой список означает, что аудит портала внесён полностью.
 * Используется интерфейсом для предупреждения о неподтверждённой конфигурации.
 */
export function pendingAuditStageIds() {
  const pending = [];
  for (const funnel of FUNNEL_LIST) {
    for (const stage of funnel.stages) {
      if (stage.id.startsWith(PLACEHOLDER_STAGE_ID_PREFIX)) {
        pending.push({ funnelId: funnel.id, kind: 'stage', role: stage.role, stageId: stage.id });
      }
    }
    for (const id of SERVICE_STAGE_IDS[funnel.id]) {
      if (id.startsWith(PLACEHOLDER_STAGE_ID_PREFIX)) {
        pending.push({ funnelId: funnel.id, kind: 'service', role: null, stageId: id });
      }
    }
    for (const id of LOST_STAGE_IDS[funnel.id]) {
      if (id.startsWith(PLACEHOLDER_STAGE_ID_PREFIX)) {
        pending.push({ funnelId: funnel.id, kind: 'lost', role: null, stageId: id });
      }
    }
  }
  for (const alias of Object.keys(STAGE_ALIASES)) {
    if (alias.startsWith(PLACEHOLDER_STAGE_ID_PREFIX)) {
      pending.push({ funnelId: null, kind: 'alias', role: null, stageId: alias });
    }
  }
  return pending;
}

/** В конфигурации остались ID-заглушки: данные портала ещё не подтверждены аудитом. */
export function hasPlaceholderStageIds() {
  return pendingAuditStageIds().length > 0;
}

/**
 * Проверяет внутреннюю непротиворечивость конфигурации воронок.
 * Возвращает список проблем на русском; пустой список — конфигурация цела.
 * Вызывается проверками и может вызываться сервером при старте, чтобы
 * ошибка подстановки реальных ID была видна сразу, а не в виде кривых чисел.
 */
export function validateFunnelConfig() {
  const problems = [];
  const seenIds = new Map();

  for (const funnel of FUNNEL_LIST) {
    const seenRoles = new Set();
    funnel.stages.forEach((stage, position) => {
      if (stage.index !== position) {
        problems.push(`Воронка «${funnel.id}»: этап «${stage.name}» объявлен с index=${stage.index}, а стоит на позиции ${position}.`);
      }
      if (seenRoles.has(stage.role)) {
        problems.push(`Воронка «${funnel.id}»: роль «${stage.role}» повторяется.`);
      }
      seenRoles.add(stage.role);

      if (typeof stage.id !== 'string' || stage.id.trim() === '') {
        problems.push(`Воронка «${funnel.id}»: у этапа «${stage.name}» пустой технический ID.`);
      }
      if (STAGE_TECHNICAL_IDS[funnel.id]?.[stage.role] !== stage.id) {
        problems.push(`Воронка «${funnel.id}»: ID этапа «${stage.name}» задан мимо таблицы STAGE_TECHNICAL_IDS.`);
      }
      if (Object.hasOwn(STAGE_ALIASES, stage.id)) {
        problems.push(`Воронка «${funnel.id}»: ID этапа «${stage.name}» одновременно объявлен алиасом.`);
      }
      const owner = seenIds.get(stage.id);
      if (owner) {
        problems.push(`Технический ID «${stage.id}» используют сразу два этапа: ${owner} и ${funnel.id}/${stage.role}.`);
      }
      seenIds.set(stage.id, `${funnel.id}/${stage.role}`);
    });

    for (const id of [...SERVICE_STAGE_IDS[funnel.id], ...LOST_STAGE_IDS[funnel.id]]) {
      if (STAGE_BY_ID.get(funnel.id).has(id)) {
        problems.push(`Воронка «${funnel.id}»: служебная стадия или отказ «${id}» объявлена этапом воронки.`);
      }
    }
  }

  for (const [alias, target] of Object.entries(STAGE_ALIASES)) {
    const resolved = canonicalStageId(alias);
    const known = GLOBAL_STAGE_BY_ID.has(resolved) || SERVICE_ID_SET.has(resolved) || LOST_ID_SET.has(resolved);
    if (!known) {
      problems.push(`Алиас «${alias}» ведёт на неизвестную стадию «${target}».`);
    }
  }

  const companyJunction = COMPANIES_FUNNEL.stages.at(-1);
  const dealJunction = DEALS_FUNNEL.stages[0];
  if (companyJunction.name !== dealJunction.name) {
    problems.push(`Точка соединения рассогласована по названию: «${companyJunction.name}» и «${dealJunction.name}».`);
  }
  if (companyJunction.role !== dealJunction.role) {
    problems.push(`Точка соединения рассогласована по роли: «${companyJunction.role}» и «${dealJunction.role}».`);
  }
  if (!companyJunction.junction || !dealJunction.junction || !companyJunction.dualCount || !dealJunction.dualCount) {
    problems.push('Точка соединения потеряла признак стыка или двойного счётчика на одной из сторон.');
  }
  const junctionStages = FUNNEL_LIST.flatMap((funnel) => funnel.stages).filter((stage) => stage.junction);
  if (junctionStages.length !== 2) {
    problems.push(`Признак стыка должен стоять ровно у двух этапов, найдено: ${junctionStages.length}.`);
  }
  if (JUNCTION.companyStageId !== companyJunction.id || JUNCTION.dealStageId !== dealJunction.id) {
    problems.push('Описание JUNCTION разошлось с этапами воронок.');
  }

  return problems;
}
