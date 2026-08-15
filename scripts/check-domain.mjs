// Проверки доменной конфигурации двух воронок.
// Каждая проверка независима и формулирует бизнес-правило, а не факт вызова функции.
// Запуск: node scripts/check-domain.mjs
import assert from 'node:assert';
import {
  FUNNELS,
  FUNNEL_LIST,
  FUNNEL_IDS,
  UNITS,
  ROLLBACK_POLICIES,
  JUNCTION,
  CROSS_FUNNEL_SEQUENCE,
  COHORT_ENTRY,
  MAIN_CONVERSION,
  STAGE_TECHNICAL_IDS,
  STAGE_ALIASES,
  SERVICE_STAGE_IDS,
  LOST_STAGE_IDS,
  PLACEHOLDER_STAGE_ID_PREFIX,
  canonicalStageId,
  stageIndex,
  stageById,
  stageByRole,
  stageIdByRole,
  isTrackedStage,
  isJunctionStage,
  isLostStageId,
  isServiceStageId,
  isPlaceholderStageId,
  findStage,
  unitOfAccount,
  crossFunnelPosition,
  capReachedIndexByCurrentStage,
  pendingAuditStageIds,
  validateFunnelConfig
} from '../src/domain/funnels.js';

let failed = 0;
let passed = 0;

function check(name, run) {
  try {
    run();
    passed += 1;
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error && error.message ? error.message : String(error));
  }
}

// Порядок этапов из спеки (раздел Funnel Definition) — продублирован здесь намеренно:
// проверка должна падать при любой правке порядка в конфигурации.
const COMPANY_STAGE_NAMES = [
  'Новая компания',
  'Взят в работу',
  'Первичный контакт установлен',
  'Вышел на ЛПР',
  'Квалификация пройдена',
  'Потребность выявлена'
];

const DEAL_STAGE_NAMES = [
  'Потребность выявлена',
  'Исходные данные получены',
  'КП отправлено',
  'КП защищено',
  'Реквизиты получены',
  'Согласование договора',
  'Договор отправлен на подпись',
  'Договор подписан',
  'Аванс получен',
  'Передано в производство'
];

const JUNCTION_NAME = 'Потребность выявлена';
// Похоже на ID стадии Битрикса, но такой стадии нет ни в одной нашей воронке.
const UNKNOWN_STAGE_ID = 'C999:UC_NEVER_EXISTED';

/* --- структура воронок --------------------------------------------------- */

check('первая воронка ведёт компании от «Новая компания» до «Потребность выявлена» строго по спеке', () => {
  assert.deepStrictEqual(FUNNELS.companies.stages.map((stage) => stage.name), COMPANY_STAGE_NAMES);
  assert.strictEqual(FUNNELS.companies.unit, UNITS.company);
});

check('вторая воронка ведёт сделки от «Потребность выявлена» до «Передано в производство» строго по спеке', () => {
  assert.deepStrictEqual(FUNNELS.deals.stages.map((stage) => stage.name), DEAL_STAGE_NAMES);
  assert.strictEqual(FUNNELS.deals.unit, UNITS.deal);
});

check('индекс этапа задан в конфиге, уникален и идёт подряд от нуля в обеих воронках', () => {
  for (const funnel of FUNNEL_LIST) {
    const indexes = funnel.stages.map((stage) => stage.index);
    const expected = funnel.stages.map((_, position) => position);
    assert.deepStrictEqual(indexes, expected, `воронка «${funnel.id}»: индексы ${indexes.join(',')}`);
    assert.strictEqual(new Set(indexes).size, indexes.length, `воронка «${funnel.id}»: индексы повторяются`);
    for (const stage of funnel.stages) {
      assert.ok(Object.hasOwn(stage, 'index'), `этап «${stage.name}» не объявляет index явно`);
    }
  }
});

check('единица учёта меняется на стыке: до него считаются компании, после — сделки', () => {
  assert.strictEqual(unitOfAccount(FUNNEL_IDS.companies), UNITS.company);
  assert.strictEqual(unitOfAccount(FUNNEL_IDS.deals), UNITS.deal);
  for (const step of CROSS_FUNNEL_SEQUENCE) {
    if (step.position < JUNCTION.companyIndex) {
      assert.deepStrictEqual(step.units, [UNITS.company], `ступень «${step.name}» должна считаться по компаниям`);
    } else if (step.position > JUNCTION.companyIndex) {
      assert.deepStrictEqual(step.units, [UNITS.deal], `ступень «${step.name}» должна считаться по сделкам`);
    } else {
      assert.deepStrictEqual(step.units, [UNITS.company, UNITS.deal]);
    }
  }
});

check('конфигурация воронок непротиворечива по собственной валидации', () => {
  assert.deepStrictEqual(validateFunnelConfig(), []);
});

check('конфигурация неизменяема: расчётный модуль не может испортить общий домен', () => {
  assert.throws(() => {
    FUNNELS.companies.stages[0].name = 'Подменённое название';
  }, TypeError);
  assert.throws(() => {
    FUNNELS.deals.stages.push({ index: 10, role: 'hack', name: 'Лишний этап', id: 'X' });
  }, TypeError);
});

/* --- технические ID ------------------------------------------------------ */

check('технический ID этапа берётся только из таблицы ID — подстановка после аудита правит одно место', () => {
  for (const funnel of FUNNEL_LIST) {
    for (const stage of funnel.stages) {
      assert.strictEqual(
        stage.id,
        STAGE_TECHNICAL_IDS[funnel.id][stage.role],
        `воронка «${funnel.id}», этап «${stage.name}»: ID разошёлся с таблицей STAGE_TECHNICAL_IDS`
      );
    }
  }
});

check('технические ID уникальны во всей системе — один ID не может обслуживать два этапа', () => {
  const ids = FUNNEL_LIST.flatMap((funnel) => funnel.stages.map((stage) => stage.id));
  const service = Object.values(SERVICE_STAGE_IDS).flat();
  const lost = Object.values(LOST_STAGE_IDS).flat();
  const all = [...ids, ...service, ...lost];
  assert.strictEqual(new Set(all).size, all.length, `повторяющиеся ID: ${all.join(', ')}`);
});

check('незаменённые ID-заглушки перечисляются автоматически и помечены единым префиксом', () => {
  const pending = pendingAuditStageIds();
  const declared = [
    ...FUNNEL_LIST.flatMap((funnel) => funnel.stages.map((stage) => stage.id)),
    ...Object.values(SERVICE_STAGE_IDS).flat(),
    ...Object.values(LOST_STAGE_IDS).flat(),
    ...Object.keys(STAGE_ALIASES)
  ];
  const expected = declared.filter((id) => id.startsWith(PLACEHOLDER_STAGE_ID_PREFIX)).sort();
  assert.deepStrictEqual(pending.map((item) => item.stageId).sort(), expected);
  for (const item of pending) {
    assert.ok(isPlaceholderStageId(item.stageId), `«${item.stageId}» не распознан как заглушка`);
  }
  assert.ok(!isPlaceholderStageId('C2:UC_ABC123'), 'реальный ID Битрикса ошибочно принят за заглушку');
});

/* --- точка соединения ---------------------------------------------------- */

check('«Потребность выявлена» — последняя ступень первой воронки и первая ступень второй', () => {
  const companyJunction = FUNNELS.companies.stages.at(-1);
  const dealJunction = FUNNELS.deals.stages[0];
  assert.strictEqual(companyJunction.name, JUNCTION_NAME);
  assert.strictEqual(dealJunction.name, JUNCTION_NAME);
  assert.strictEqual(companyJunction.index, FUNNELS.companies.stages.length - 1);
  assert.strictEqual(dealJunction.index, 0);
});

check('признаки стыка не расходятся между воронками', () => {
  const companyJunction = FUNNELS.companies.stages.at(-1);
  const dealJunction = FUNNELS.deals.stages[0];
  assert.strictEqual(companyJunction.name, dealJunction.name, 'названия стыка разошлись');
  assert.strictEqual(companyJunction.role, dealJunction.role, 'роли стыка разошлись');
  assert.strictEqual(companyJunction.junction, true);
  assert.strictEqual(dealJunction.junction, true);
  assert.strictEqual(companyJunction.dualCount, true, 'сторона компаний потеряла двойной счётчик');
  assert.strictEqual(dealJunction.dualCount, true, 'сторона сделок потеряла двойной счётчик');
  assert.strictEqual(JUNCTION.name, companyJunction.name);
  assert.strictEqual(JUNCTION.role, companyJunction.role);
  assert.strictEqual(JUNCTION.companyStageId, companyJunction.id);
  assert.strictEqual(JUNCTION.dealStageId, dealJunction.id);
  assert.deepStrictEqual(JUNCTION.units, [UNITS.company, UNITS.deal]);
});

check('признак стыка стоит ровно у двух этапов — ни один другой этап не претендует на двойной счётчик', () => {
  const stages = FUNNEL_LIST.flatMap((funnel) => funnel.stages);
  assert.strictEqual(stages.filter((stage) => stage.junction).length, 2);
  assert.strictEqual(stages.filter((stage) => stage.dualCount).length, 2);
  for (const stage of stages) {
    assert.strictEqual(stage.junction, isJunctionStage(stage.id), `этап «${stage.name}»: флаг стыка и isJunctionStage разошлись`);
  }
});

check('у стыка две стороны с разными техническими ID: стадия компании и стадия сделки — не одно и то же', () => {
  assert.notStrictEqual(JUNCTION.companyStageId, JUNCTION.dealStageId);
  assert.strictEqual(stageIndex(FUNNEL_IDS.companies, JUNCTION.companyStageId), JUNCTION.companyIndex);
  assert.strictEqual(stageIndex(FUNNEL_IDS.deals, JUNCTION.dealStageId), JUNCTION.dealIndex);
  assert.strictEqual(findStage(JUNCTION.companyStageId).funnelId, FUNNEL_IDS.companies);
  assert.strictEqual(findStage(JUNCTION.dealStageId).funnelId, FUNNEL_IDS.deals);
});

check('в сквозной последовательности стык встречается один раз, а обе его стороны ведут на одну ступень', () => {
  assert.strictEqual(CROSS_FUNNEL_SEQUENCE.length, FUNNELS.companies.stages.length + FUNNELS.deals.stages.length - 1);
  assert.deepStrictEqual(
    CROSS_FUNNEL_SEQUENCE.map((step) => step.position),
    CROSS_FUNNEL_SEQUENCE.map((_, position) => position)
  );
  assert.strictEqual(CROSS_FUNNEL_SEQUENCE.filter((step) => step.junction).length, 1);
  assert.strictEqual(crossFunnelPosition(JUNCTION.companyStageId), JUNCTION.companyIndex);
  assert.strictEqual(crossFunnelPosition(JUNCTION.dealStageId), JUNCTION.companyIndex);
});

/* --- алиасы и точки входа ------------------------------------------------ */

check('алиас стадии разрешается в канонический ID и даёт тот же индекс, что и канонический', () => {
  const aliases = Object.entries(STAGE_ALIASES);
  assert.ok(aliases.length > 0, 'таблица алиасов пуста — механизм нечем проверить');
  for (const [alias, canonical] of aliases) {
    assert.strictEqual(canonicalStageId(alias), canonical);
    const found = findStage(canonical);
    assert.ok(found, `алиас «${alias}» ведёт на неизвестную стадию «${canonical}»`);
    assert.strictEqual(stageIndex(found.funnelId, alias), stageIndex(found.funnelId, canonical));
    assert.strictEqual(isTrackedStage(found.funnelId, alias), true);
  }
});

check('канонизация применяется в каждой точке входа: алиас, пробелы и число дают тот же этап', () => {
  const [alias, canonical] = Object.entries(STAGE_ALIASES)[0];
  const { funnelId } = findStage(canonical);
  const funnel = FUNNELS[funnelId];
  const expected = stageIndex(funnelId, canonical);
  const deepest = funnel.stages.length - 1;
  assert.strictEqual(stageIndex(funnelId, `  ${alias} `), expected, 'пробелы вокруг ID не обрезаются');
  assert.strictEqual(stageById(funnelId, alias).id, canonical);
  // Текущая стадия сущности — тоже точка входа: алиас в ней обязан обрезать глубину так же, как канонический ID.
  assert.strictEqual(
    capReachedIndexByCurrentStage(funnelId, deepest, `  ${alias} `),
    capReachedIndexByCurrentStage(funnelId, deepest, canonical),
    'алиас в текущей стадии обрабатывается иначе, чем канонический ID'
  );
  assert.strictEqual(canonicalStageId(42), '42', 'числовой ID не приводится к строке');
  assert.strictEqual(canonicalStageId('   '), '');
  assert.strictEqual(canonicalStageId(null), '');
  assert.strictEqual(canonicalStageId(undefined), '');
});

check('канонизация не путает ID стадии со служебными именами JavaScript', () => {
  for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(canonicalStageId(id), id, `«${id}» подменён свойством прототипа`);
    assert.strictEqual(stageIndex(FUNNEL_IDS.deals, id), -1);
  }
});

/* --- инвариант «-1 для стадии вне воронки» -------------------------------- */

check('неизвестная стадия не входит в воронку и даёт -1 в обеих воронках', () => {
  for (const funnelId of [FUNNEL_IDS.companies, FUNNEL_IDS.deals]) {
    assert.strictEqual(stageIndex(funnelId, UNKNOWN_STAGE_ID), -1);
    assert.strictEqual(stageIndex(funnelId, ''), -1);
    assert.strictEqual(stageIndex(funnelId, null), -1);
    assert.strictEqual(stageIndex(funnelId, undefined), -1);
    assert.strictEqual(isTrackedStage(funnelId, UNKNOWN_STAGE_ID), false);
  }
  assert.strictEqual(findStage(UNKNOWN_STAGE_ID), null);
  assert.strictEqual(crossFunnelPosition(UNKNOWN_STAGE_ID), -1);
});

check('служебная стадия «создана» не является этапом воронки', () => {
  for (const funnel of FUNNEL_LIST) {
    for (const id of SERVICE_STAGE_IDS[funnel.id]) {
      assert.strictEqual(isServiceStageId(id), true);
      assert.strictEqual(stageIndex(funnel.id, id), -1, `служебная стадия «${id}» попала в воронку «${funnel.id}»`);
      assert.strictEqual(isTrackedStage(funnel.id, id), false);
    }
  }
});

check('отказ не является этапом воронки и не ломает индексацию', () => {
  const lost = LOST_STAGE_IDS.deals;
  assert.ok(lost.length > 0, 'не объявлено ни одной стадии отказа — правило нечем проверить');
  for (const id of lost) {
    assert.strictEqual(isLostStageId(id), true);
    assert.strictEqual(stageIndex(FUNNEL_IDS.deals, id), -1, `стадия отказа «${id}» попала в воронку сделок`);
    assert.strictEqual(crossFunnelPosition(id), -1);
  }
  const names = FUNNELS.deals.stages.map((stage) => stage.name);
  assert.strictEqual(names.length, DEAL_STAGE_NAMES.length, 'отказ добавлен в список этапов воронки');
  assert.strictEqual(isLostStageId(stageIdByRole(FUNNEL_IDS.deals, 'advanceReceived')), false);
});

check('этап соседней воронки не считается этапом этой воронки', () => {
  assert.strictEqual(stageIndex(FUNNEL_IDS.companies, STAGE_TECHNICAL_IDS.deals.proposalSent), -1);
  assert.strictEqual(stageIndex(FUNNEL_IDS.deals, STAGE_TECHNICAL_IDS.companies.qualified), -1);
  assert.strictEqual(stageIndex(FUNNEL_IDS.companies, JUNCTION.dealStageId), -1, 'стадия сделки принята за этап воронки компаний');
  assert.strictEqual(stageIndex(FUNNEL_IDS.deals, JUNCTION.companyStageId), -1, 'стадия компании принята за этап воронки сделок');
});

/* --- откаты: два противоположных правила ---------------------------------- */

check('откат компании не стирает достигнутые этапы первой воронки', () => {
  const reached = stageIndex(FUNNEL_IDS.companies, STAGE_TECHNICAL_IDS.companies.qualified); // 4
  const currentAfterRollback = STAGE_TECHNICAL_IDS.companies.firstContact; // 2
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.companies, reached, currentAfterRollback), reached);
  assert.strictEqual(FUNNELS.companies.rollbackPolicy, ROLLBACK_POLICIES.keepHistoricalMax);
});

check('откат активной сделки убирает её с этапов выше текущей стадии', () => {
  const reached = stageIndex(FUNNEL_IDS.deals, STAGE_TECHNICAL_IDS.deals.contractSigned); // 7
  const currentAfterRollback = STAGE_TECHNICAL_IDS.deals.requisitesReceived; // 4
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, reached, currentAfterRollback), 4);
  assert.strictEqual(FUNNELS.deals.rollbackPolicy, ROLLBACK_POLICIES.capByCurrentStage);
});

check('правила отката двух воронок противоположны и не могут быть перепутаны местами', () => {
  // Одинаковый вход, разные воронки: компания сохраняет глубину, активная сделка обрезается.
  const companyReached = 4;
  const dealReached = 7;
  const companyCurrent = STAGE_TECHNICAL_IDS.companies.newCompany; // индекс 0
  const dealCurrent = STAGE_TECHNICAL_IDS.deals.proposalSent; // индекс 2
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.companies, companyReached, companyCurrent), companyReached);
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, dealReached, dealCurrent), 2);
  assert.notStrictEqual(FUNNELS.companies.rollbackPolicy, FUNNELS.deals.rollbackPolicy);
});

check('проигранная сделка сохраняет путь: стадия вне воронки не обрезает достигнутую глубину', () => {
  const reached = stageIndex(FUNNEL_IDS.deals, STAGE_TECHNICAL_IDS.deals.proposalDefended); // 3
  for (const outside of [...LOST_STAGE_IDS.deals, ...SERVICE_STAGE_IDS.deals, UNKNOWN_STAGE_ID, '', null]) {
    assert.strictEqual(
      capReachedIndexByCurrentStage(FUNNEL_IDS.deals, reached, outside),
      reached,
      `стадия вне воронки «${String(outside)}» обрезала глубину`
    );
  }
});

check('повторное продвижение после отката не поднимает глубину выше фактически достигнутой', () => {
  const reached = stageIndex(FUNNEL_IDS.deals, STAGE_TECHNICAL_IDS.deals.proposalSent); // 2
  const currentHigher = STAGE_TECHNICAL_IDS.deals.handedToProduction; // 9
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, reached, currentHigher), reached);
  const same = STAGE_TECHNICAL_IDS.deals.proposalSent;
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, reached, same), reached);
});

check('сущность, не дошедшая ни до одного этапа, остаётся с глубиной -1 после обрезки', () => {
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, -1, STAGE_TECHNICAL_IDS.deals.contractSigned), -1);
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.deals, -1, UNKNOWN_STAGE_ID), -1);
  assert.strictEqual(capReachedIndexByCurrentStage(FUNNEL_IDS.companies, -1, UNKNOWN_STAGE_ID), -1);
});

/* --- защита от тихих ошибок ---------------------------------------------- */

check('обращение к неизвестной воронке падает с внятной ошибкой, а не молча обнуляет расчёт', () => {
  assert.throws(() => stageIndex('leads', STAGE_TECHNICAL_IDS.deals.proposalSent), /Неизвестная воронка/);
  assert.throws(() => capReachedIndexByCurrentStage('companies ', 3, ''), /Неизвестная воронка/);
  assert.throws(() => unitOfAccount(undefined), /Неизвестная воронка/);
});

check('обращение к неизвестной роли этапа падает с внятной ошибкой', () => {
  assert.throws(() => stageByRole(FUNNEL_IDS.companies, 'advanceReceived'), /Неизвестная роль этапа/);
  assert.throws(() => stageIdByRole(FUNNEL_IDS.deals, 'takenToWork'), /Неизвестная роль этапа/);
});

check('нецелая достигнутая глубина отвергается: молчаливый NaN в воронке недопустим', () => {
  assert.throws(() => capReachedIndexByCurrentStage(FUNNEL_IDS.deals, undefined, ''), /целым числом/);
  assert.throws(() => capReachedIndexByCurrentStage(FUNNEL_IDS.deals, 2.5, ''), /целым числом/);
  assert.throws(() => capReachedIndexByCurrentStage(FUNNEL_IDS.deals, Number.NaN, ''), /целым числом/);
});

check('воронку можно передавать и объектом, и идентификатором — результат одинаков', () => {
  assert.strictEqual(
    stageIndex(FUNNELS.deals, STAGE_TECHNICAL_IDS.deals.contractSigned),
    stageIndex(FUNNEL_IDS.deals, STAGE_TECHNICAL_IDS.deals.contractSigned)
  );
  assert.strictEqual(
    capReachedIndexByCurrentStage(FUNNELS.deals, 7, STAGE_TECHNICAL_IDS.deals.proposalSent),
    capReachedIndexByCurrentStage(FUNNEL_IDS.deals, 7, STAGE_TECHNICAL_IDS.deals.proposalSent)
  );
});

/* --- опорные ступени продукта -------------------------------------------- */

check('когорта Статики набирается по ступени «Взят в работу» первой воронки', () => {
  assert.strictEqual(COHORT_ENTRY.funnelId, FUNNEL_IDS.companies);
  assert.strictEqual(COHORT_ENTRY.name, 'Взят в работу');
  assert.strictEqual(COHORT_ENTRY.stageId, stageIdByRole(FUNNEL_IDS.companies, COHORT_ENTRY.role));
  assert.strictEqual(stageIndex(FUNNEL_IDS.companies, COHORT_ENTRY.stageId), 1);
});

check('главная конверсия идёт от «Взят в работу» к «Аванс получен» и пересекает стык', () => {
  assert.strictEqual(MAIN_CONVERSION.from.name, 'Взят в работу');
  assert.strictEqual(MAIN_CONVERSION.from.unit, UNITS.company);
  assert.strictEqual(MAIN_CONVERSION.to.name, 'Аванс получен');
  assert.strictEqual(MAIN_CONVERSION.to.unit, UNITS.deal);
  const from = crossFunnelPosition(MAIN_CONVERSION.from.stageId);
  const to = crossFunnelPosition(MAIN_CONVERSION.to.stageId);
  assert.ok(from < JUNCTION.companyIndex && to > JUNCTION.companyIndex, 'главная конверсия обязана пересекать стык');
});

check('«Передано в производство» стоит после коммерческого результата и не подменяет главную конверсию', () => {
  const operational = FUNNELS.deals.stages.filter((stage) => stage.operational === true);
  assert.strictEqual(operational.length, 1);
  assert.strictEqual(operational[0].name, 'Передано в производство');
  assert.strictEqual(operational[0].index, FUNNELS.deals.stages.length - 1);
  assert.notStrictEqual(MAIN_CONVERSION.to.stageId, operational[0].id);
  assert.ok(
    crossFunnelPosition(MAIN_CONVERSION.to.stageId) < crossFunnelPosition(operational[0].id),
    'коммерческий результат обязан идти раньше операционной ступени'
  );
});

if (failed) {
  console.error(`${failed}/${passed + failed} проверок домена не прошли`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed }));
