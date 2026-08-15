// Проверки демонстрационного снимка.
//
// Запуск: node scripts/check-demo.mjs
//
// Проверки НЕ верят генератору на слово: каждый краевой случай ищется фактическим
// перебором снимка. Если правило перестанет выполняться — упадёт именно та проверка,
// которая формулирует правило, а не абстрактный «тест генератора».
//
// Детерминизм: «сейчас» и зерно заданы константами. `new Date()` без аргументов
// в ожиданиях не встречается — иначе результат зависел бы от дня запуска.
import assert from 'node:assert';
import { generateDemoSnapshot } from '../src/demo/generator.js';
import {
  FUNNELS,
  LOST_STAGE_IDS,
  SERVICE_STAGE_IDS,
  capReachedIndexByCurrentStage,
  isLostStageId,
  isServiceStageId,
  stageIndex
} from '../src/domain/funnels.js';
import { inPeriod, periodKeyFromDate, resolvePeriod } from '../src/domain/period.js';
import { EMPTY_CACHE, SNAPSHOT_VERSION } from '../src/storage/jsonStore.js';

const NOW = new Date('2026-08-15T09:30:00.000Z');
const SEED = 20260815;
const TIME_ZONE = 'Europe/Moscow';

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

const snapshot = generateDemoSnapshot({ seed: SEED, now: NOW, portalTimezone: TIME_ZONE });

/* ── Индексы по снимку. Строятся один раз, дальше все проверки ищут по ним ── */

const COMPANY_STAGES = FUNNELS.companies.stages;
const DEAL_STAGES = FUNNELS.deals.stages;
const JUNCTION_COMPANY_STAGE_ID = COMPANY_STAGES[COMPANY_STAGES.length - 1].id;
const TAKEN_TO_WORK_STAGE_ID = COMPANY_STAGES[1].id;
const ADVANCE_STAGE_INDEX = DEAL_STAGES.length - 2;

const nowMs = NOW.getTime();
const companyById = new Map(snapshot.companies.map((company) => [company.id, company]));
const dealById = new Map(snapshot.deals.map((deal) => [deal.id, deal]));

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const bucket = map.get(item[key]);
    if (bucket) bucket.push(item);
    else map.set(item[key], [item]);
  }
  return map;
}

const companyEvents = groupBy(snapshot.companyStageEvents, 'companyId');
const dealEvents = groupBy(snapshot.dealStageEvents, 'dealId');
const dealsByCompany = groupBy(snapshot.deals, 'companyId');

const assigneeByEntity = new Map();
for (const event of snapshot.assigneeEvents) {
  const key = `${event.entityType}:${event.entityId}`;
  const bucket = assigneeByEntity.get(key);
  if (bucket) bucket.push(event);
  else assigneeByEntity.set(key, [event]);
}

function ms(value) {
  return Date.parse(value);
}

// Индексы этапов сущности в порядке истории. Служебная стадия и отказ дают -1
// и в положительный путь не входят — на этом стоит вся математика воронки.
function indexes(funnelId, events) {
  return events.map((event) => stageIndex(funnelId, event.stageId));
}

function positiveIndexes(funnelId, events) {
  return indexes(funnelId, events).filter((index) => index >= 0);
}

function maxReached(funnelId, events) {
  const positives = positiveIndexes(funnelId, events);
  return positives.length === 0 ? -1 : Math.max(...positives);
}

/** Ответственный на момент события — последняя запись истории не позже момента. */
function managerAt(history, at) {
  let managerId = history.length > 0 ? history[0].managerId : null;
  for (const record of history) {
    if (ms(record.at) > ms(at)) break;
    managerId = record.managerId;
  }
  return managerId;
}

function entities() {
  const list = [];
  for (const company of snapshot.companies) {
    list.push({ kind: 'company', funnelId: 'companies', id: company.id, entity: company, events: companyEvents.get(company.id) ?? [] });
  }
  for (const deal of snapshot.deals) {
    list.push({ kind: 'deal', funnelId: 'deals', id: deal.id, entity: deal, events: dealEvents.get(deal.id) ?? [] });
  }
  return list;
}

const ALL_ENTITIES = entities();

/* ── 1. Детерминизм ─────────────────────────────────────────────────────── */

check('одно зерно и один момент «сейчас» дают побайтово тот же снимок', () => {
  const again = generateDemoSnapshot({ seed: SEED, now: NOW, portalTimezone: TIME_ZONE });
  assert.strictEqual(JSON.stringify(again), JSON.stringify(snapshot), 'повторный запуск дал другой снимок');
});

check('другое зерно даёт другой снимок — зерно действительно управляет данными', () => {
  const other = generateDemoSnapshot({ seed: SEED + 1, now: NOW, portalTimezone: TIME_ZONE });
  assert.notStrictEqual(JSON.stringify(other), JSON.stringify(snapshot), 'смена зерна ничего не изменила');
});

check('генератор не зовёт Math.random: подмена Math.random не меняет снимок', () => {
  const original = Math.random;
  Math.random = () => 0.42;
  try {
    const again = generateDemoSnapshot({ seed: SEED, now: NOW, portalTimezone: TIME_ZONE });
    assert.strictEqual(JSON.stringify(again), JSON.stringify(snapshot), 'снимок зависит от Math.random');
  } finally {
    Math.random = original;
  }
});

/* ── 2. Форма и объём ───────────────────────────────────────────────────── */

check('снимок отдан в той же форме, что хранит стор', () => {
  assert.deepStrictEqual(Object.keys(snapshot).sort(), Object.keys(EMPTY_CACHE).sort(), 'набор разделов снимка разошёлся с EMPTY_CACHE');
  assert.strictEqual(snapshot.version, SNAPSHOT_VERSION);
  assert.strictEqual(snapshot.source, 'demo');
  assert.strictEqual(snapshot.portalTimezone, TIME_ZONE);
  assert.deepStrictEqual(Object.keys(snapshot.stages).sort(), ['companies', 'deals']);
  assert.strictEqual(snapshot.sync.status, 'success');
  assert.strictEqual(typeof snapshot.sync.lastSuccessAt, 'string');
});

check('объём демо-набора укладывается в заявленный: компании, сделки, справочники', () => {
  const companies = snapshot.companies.length;
  const deals = snapshot.deals.length;
  assert.ok(companies >= 300 && companies <= 500, `компаний ${companies}, ожидалось 300–500`);
  assert.ok(deals >= 400 && deals <= 700, `сделок ${deals}, ожидалось 400–700`);
  assert.ok(snapshot.managers.length >= 6 && snapshot.managers.length <= 8, `менеджеров ${snapshot.managers.length}, ожидалось 6–8`);
  assert.ok(snapshot.sources.length >= 5 && snapshot.sources.length <= 7, `источников ${snapshot.sources.length}, ожидалось 5–7`);
  assert.ok(snapshot.kevFormats.length === 3, `форматов КЭВ ${snapshot.kevFormats.length}, ожидалось 3`);
});

check('история покрывает больше двенадцати месяцев', () => {
  const all = [...snapshot.companyStageEvents, ...snapshot.dealStageEvents].map((event) => ms(event.at));
  const spanDays = (Math.max(...all) - Math.min(...all)) / 86400000;
  assert.ok(spanDays >= 365, `история покрывает ${spanDays.toFixed(0)} дней, нужно не меньше 365`);
});

check('названия компаний уникальны и не содержат заглушек вроде «Тест» или «Компания 1»', () => {
  const titles = snapshot.companies.map((company) => company.title);
  assert.strictEqual(new Set(titles).size, titles.length, 'встретились одинаковые названия компаний');
  const bad = titles.filter((title) => /(lorem|test|тест|демо|пример|компания\s*\d|организация\s*\d)/i.test(title));
  assert.deepStrictEqual(bad, [], `названия-заглушки: ${bad.slice(0, 3).join(', ')}`);
  const emptyTitles = [...snapshot.companies, ...snapshot.deals].filter((item) => !item.title || item.title.trim() === '');
  assert.strictEqual(emptyTitles.length, 0, 'есть сущности без названия');
});

/* ── 3. Согласованность истории ─────────────────────────────────────────── */

check('ни одно событие истории не лежит в будущем', () => {
  const future = [
    ...snapshot.companyStageEvents.map((event) => event.at),
    ...snapshot.dealStageEvents.map((event) => event.at),
    ...snapshot.assigneeEvents.map((event) => event.at)
  ].filter((at) => ms(at) > nowMs);
  assert.deepStrictEqual(future, [], `событий позже «сейчас»: ${future.length}`);
});

check('история отсортирована по времени, а внутри сущности время строго возрастает', () => {
  for (const [name, list] of [
    ['компаний', snapshot.companyStageEvents],
    ['сделок', snapshot.dealStageEvents],
    ['ответственных', snapshot.assigneeEvents]
  ]) {
    for (let index = 1; index < list.length; index += 1) {
      assert.ok(ms(list[index - 1].at) <= ms(list[index].at), `история ${name} не отсортирована на позиции ${index}`);
    }
  }
  for (const item of ALL_ENTITIES) {
    for (let index = 1; index < item.events.length; index += 1) {
      assert.ok(
        ms(item.events[index - 1].at) < ms(item.events[index].at),
        `у ${item.kind} ${item.id} два события пришлись на один момент`
      );
    }
  }
});

check('каждая сделка ссылается на существующую компанию', () => {
  const orphans = snapshot.deals.filter((deal) => !companyById.has(deal.companyId));
  assert.deepStrictEqual(orphans.map((deal) => deal.id), [], 'есть сделки без компании');
  assert.strictEqual(snapshot.dataQuality.dealsWithoutCompany, 0);
  const strayCompanyEvents = snapshot.companyStageEvents.filter((event) => !companyById.has(event.companyId));
  const strayDealEvents = snapshot.dealStageEvents.filter((event) => !dealById.has(event.dealId));
  assert.strictEqual(strayCompanyEvents.length, 0, 'история ссылается на несуществующую компанию');
  assert.strictEqual(strayDealEvents.length, 0, 'история ссылается на несуществующую сделку');
});

check('сделка не открывается раньше, чем у её компании выявлена потребность', () => {
  for (const deal of snapshot.deals) {
    const junction = (companyEvents.get(deal.companyId) ?? []).find((event) => event.stageId === JUNCTION_COMPANY_STAGE_ID);
    assert.ok(junction, `у компании ${deal.companyId} есть сделка ${deal.id}, но нет события «Потребность выявлена»`);
    const first = (dealEvents.get(deal.id) ?? [])[0];
    assert.ok(first, `у сделки ${deal.id} нет истории`);
    assert.ok(ms(first.at) >= ms(junction.at), `сделка ${deal.id} открыта раньше выявления потребности у компании`);
  }
});

check('текущая стадия сущности — стадия её последнего события', () => {
  for (const item of ALL_ENTITIES) {
    const last = item.events[item.events.length - 1];
    assert.ok(last, `у ${item.kind} ${item.id} пустая история`);
    assert.strictEqual(item.entity.currentStageId, last.stageId, `${item.kind} ${item.id}: текущая стадия разошлась с историей`);
  }
});

check('положительный путь начинается с первого этапа воронки — отката без продвижения не бывает', () => {
  for (const item of ALL_ENTITIES) {
    const positives = positiveIndexes(item.funnelId, item.events);
    assert.ok(positives.length > 0, `${item.kind} ${item.id} не имеет ни одного положительного этапа`);
    assert.strictEqual(positives[0], 0, `${item.kind} ${item.id} начинает историю с этапа ${positives[0]}, а не с первого`);
    let peak = -1;
    for (const index of positives) {
      if (index < peak) assert.ok(peak >= 0, `${item.kind} ${item.id}: откат раньше любого продвижения`);
      peak = Math.max(peak, index);
    }
  }
});

check('откат подтверждён историей: под текущей стадией ниже максимума лежит событие максимума', () => {
  let rolledBack = 0;
  for (const item of ALL_ENTITIES) {
    const currentIndex = stageIndex(item.funnelId, item.entity.currentStageId);
    const peak = maxReached(item.funnelId, item.events);
    if (currentIndex < 0 || currentIndex >= peak) continue;
    rolledBack += 1;
    const peakEvent = item.events.find((event) => stageIndex(item.funnelId, event.stageId) === peak);
    const lastEvent = item.events[item.events.length - 1];
    assert.ok(peakEvent, `${item.kind} ${item.id}: максимум ${peak} не подтверждён событием`);
    assert.ok(ms(peakEvent.at) < ms(lastEvent.at), `${item.kind} ${item.id}: событие максимума не предшествует откату`);
  }
  assert.ok(rolledBack > 0, 'в снимке нет ни одного отката — краевой случай не представлен');
});

check('стадии снимка объявлены в доменной конфигурации и есть в справочнике стадий', () => {
  const known = {
    companies: new Set([...COMPANY_STAGES.map((stage) => stage.id), ...SERVICE_STAGE_IDS.companies, ...LOST_STAGE_IDS.companies]),
    deals: new Set([...DEAL_STAGES.map((stage) => stage.id), ...SERVICE_STAGE_IDS.deals, ...LOST_STAGE_IDS.deals])
  };
  for (const item of ALL_ENTITIES) {
    const funnelKey = item.kind === 'company' ? 'companies' : 'deals';
    for (const event of item.events) {
      assert.ok(known[funnelKey].has(event.stageId), `неизвестная стадия «${event.stageId}» у ${item.kind} ${item.id}`);
    }
    assert.ok(known[funnelKey].has(item.entity.currentStageId), `неизвестная текущая стадия у ${item.kind} ${item.id}`);
  }
  for (const funnelKey of ['companies', 'deals']) {
    const listed = new Set(snapshot.stages[funnelKey].map((stage) => stage.id));
    for (const id of known[funnelKey]) {
      assert.ok(listed.has(id), `стадия «${id}» отсутствует в справочнике снимка`);
    }
    for (const stage of snapshot.stages[funnelKey]) {
      assert.ok(stage.name && stage.name.trim() !== '', `у стадии «${stage.id}» нет подписи`);
    }
  }
});

check('ссылки сущностей ведут в справочники менеджеров, источников и форматов КЭВ', () => {
  const managers = new Set(snapshot.managers.map((manager) => manager.id));
  const sources = new Set(snapshot.sources.map((source) => source.id));
  const kevFormats = new Set(snapshot.kevFormats.map((format) => format.id));
  for (const company of snapshot.companies) {
    assert.ok(managers.has(company.assignedById), `компания ${company.id}: неизвестный ответственный`);
    assert.ok(company.sourceId === null || sources.has(company.sourceId), `компания ${company.id}: неизвестный источник`);
  }
  for (const deal of snapshot.deals) {
    assert.ok(managers.has(deal.assignedById), `сделка ${deal.id}: неизвестный ответственный`);
    assert.ok(deal.sourceId === null || sources.has(deal.sourceId), `сделка ${deal.id}: неизвестный источник`);
    assert.ok(deal.kevFormatId === null || kevFormats.has(deal.kevFormatId), `сделка ${deal.id}: неизвестный формат КЭВ`);
  }
  for (const event of snapshot.assigneeEvents) {
    assert.ok(managers.has(event.managerId), `история ответственных ссылается на неизвестного менеджера ${event.managerId}`);
    const exists = event.entityType === 'company' ? companyById.has(event.entityId) : dealById.has(event.entityId);
    assert.ok(exists, `история ответственных ссылается на несуществующую сущность ${event.entityType} ${event.entityId}`);
  }
});

check('у каждой сущности есть ответственный уже на первом событии истории', () => {
  for (const item of ALL_ENTITIES) {
    const history = assigneeByEntity.get(`${item.kind}:${item.id}`) ?? [];
    assert.ok(history.length > 0, `${item.kind} ${item.id} без истории ответственных`);
    assert.ok(
      ms(history[0].at) <= ms(item.events[0].at),
      `${item.kind} ${item.id}: первый ответственный назначен позже первого события`
    );
    const lastManager = history[history.length - 1].managerId;
    assert.strictEqual(item.entity.assignedById, lastManager, `${item.kind} ${item.id}: текущий ответственный разошёлся с историей`);
  }
});

/* ── 4. Краевые случаи. Ищем перебором, а не верим генератору ───────────── */

check('в снимке есть компании с несколькими потребностями и, значит, несколькими сделками', () => {
  const multi = [...dealsByCompany.values()].filter((list) => list.length > 1);
  assert.ok(multi.length >= 5, `компаний с несколькими сделками ${multi.length}, нужно хотя бы 5`);
  const ids = new Set(multi.flatMap((list) => list.map((deal) => deal.id)));
  assert.strictEqual(ids.size, multi.reduce((sum, list) => sum + list.length, 0), 'потребности одной компании ссылаются на одну сделку');
});

check('откат компании не стирает достигнутые этапы: исторический максимум выше текущей стадии', () => {
  const rolled = snapshot.companies.filter((company) => {
    const events = companyEvents.get(company.id) ?? [];
    const current = stageIndex('companies', company.currentStageId);
    return current >= 0 && current < maxReached('companies', events);
  });
  assert.ok(rolled.length >= 5, `откатившихся компаний ${rolled.length}, нужно хотя бы 5`);
  for (const company of rolled) {
    const events = companyEvents.get(company.id) ?? [];
    const peak = maxReached('companies', events);
    // Правило первой воронки: обрезки по текущей стадии нет никогда.
    assert.strictEqual(
      capReachedIndexByCurrentStage('companies', peak, company.currentStageId),
      peak,
      `компания ${company.id}: достигнутая глубина обрезана текущей стадией`
    );
  }
});

check('глубина активной сделки обрезается её текущей стадией', () => {
  const capped = snapshot.deals.filter((deal) => {
    if (deal.isLost) return false;
    const events = dealEvents.get(deal.id) ?? [];
    const peak = maxReached('deals', events);
    return capReachedIndexByCurrentStage('deals', peak, deal.currentStageId) < peak;
  });
  assert.ok(capped.length >= 3, `активных сделок с обрезкой ${capped.length}, нужно хотя бы 3`);
  for (const deal of capped) {
    assert.ok(!isLostStageId(deal.currentStageId), `сделка ${deal.id} помечена активной, но стоит в отказе`);
    assert.ok(stageIndex('deals', deal.currentStageId) >= 0, `сделка ${deal.id}: текущая стадия вне воронки, обрезки не будет`);
  }
});

check('сделка, откатившаяся и снова продвинувшаяся, не даёт дубля этапа', () => {
  const recovered = snapshot.deals.filter((deal) => {
    const positives = positiveIndexes('deals', dealEvents.get(deal.id) ?? []);
    let wentBack = false;
    for (let index = 1; index < positives.length; index += 1) {
      if (positives[index] < positives[index - 1]) wentBack = true;
      else if (wentBack && positives[index] > positives[index - 1]) return true;
    }
    return false;
  });
  assert.ok(recovered.length >= 3, `сделок с откатом и повторным продвижением ${recovered.length}, нужно хотя бы 3`);
  for (const deal of recovered) {
    const events = dealEvents.get(deal.id) ?? [];
    const unique = new Set(events.map((event) => event.stageId));
    assert.ok(unique.size < events.length, `сделка ${deal.id}: повторное прохождение не оставило следа в истории`);
  }
});

check('проигранная сделка сохраняет положительный путь, пройденный до отказа', () => {
  const lost = snapshot.deals.filter((deal) => deal.isLost);
  assert.ok(lost.length >= 10, `проигранных сделок ${lost.length}, нужно хотя бы 10`);
  for (const deal of lost) {
    const events = dealEvents.get(deal.id) ?? [];
    assert.ok(isLostStageId(deal.currentStageId), `сделка ${deal.id} помечена проигранной, но стоит не в отказе`);
    const peak = maxReached('deals', events);
    assert.ok(peak >= 0, `сделка ${deal.id}: путь до отказа не сохранён`);
    // Стадия отказа лежит вне воронки, поэтому обрезка не срезает достигнутое (инвариант 5).
    assert.strictEqual(capReachedIndexByCurrentStage('deals', peak, deal.currentStageId), peak, `сделка ${deal.id}: отказ срезал путь`);
  }
  const withPath = lost.filter((deal) => maxReached('deals', dealEvents.get(deal.id) ?? []) >= 1);
  assert.ok(withPath.length >= 10, `проигранных сделок, успевших пройти этапы, ${withPath.length}`);
});

check('есть сущности с пропущенными положительными этапами — расчёт обязан их докрасить', () => {
  const withGap = (item) => {
    const positives = positiveIndexes(item.funnelId, item.events);
    return positives.some((index, position) => position > 0 && index - positives[position - 1] > 1);
  };
  const companies = ALL_ENTITIES.filter((item) => item.kind === 'company' && withGap(item));
  const deals = ALL_ENTITIES.filter((item) => item.kind === 'deal' && withGap(item));
  assert.ok(companies.length >= 5, `компаний с пропущенными этапами ${companies.length}, нужно хотя бы 5`);
  assert.ok(deals.length >= 5, `сделок с пропущенными этапами ${deals.length}, нужно хотя бы 5`);
});

check('есть повторные входы на один этап в пределах одного календарного месяца портала', () => {
  const repeats = ALL_ENTITIES.filter((item) => {
    const seen = new Map();
    for (const event of item.events) {
      if (isServiceStageId(event.stageId) || isLostStageId(event.stageId)) continue;
      const monthKey = periodKeyFromDate('month', event.at, TIME_ZONE);
      const key = `${event.stageId}|${monthKey}`;
      if (seen.has(key)) return true;
      seen.set(key, event.at);
    }
    return false;
  });
  assert.ok(repeats.length >= 3, `повторных входов на этап внутри месяца ${repeats.length}, нужно хотя бы 3`);
});

check('этапы одной сущности бывают пройдены разными ответственными', () => {
  const handed = [];
  for (const item of ALL_ENTITIES) {
    const history = assigneeByEntity.get(`${item.kind}:${item.id}`) ?? [];
    if (history.length < 2) continue;
    const owners = new Set(item.events.map((event) => managerAt(history, event.at)));
    if (owners.size < 2) continue;
    handed.push(item);
    const first = ms(item.events[0].at);
    const last = ms(item.events[item.events.length - 1].at);
    assert.ok(
      ms(history[1].at) > first && ms(history[1].at) < last,
      `${item.kind} ${item.id}: передача не попала в середину пути, разделения статистики не выйдет`
    );
  }
  assert.ok(handed.length >= 10, `сущностей с этапами от разных ответственных ${handed.length}, нужно хотя бы 10`);
});

check('записи без источника есть и совпадают со счётчиком качества данных', () => {
  const companies = snapshot.companies.filter((company) => company.sourceId === null);
  const deals = snapshot.deals.filter((deal) => deal.sourceId === null);
  assert.ok(companies.length >= 5, `компаний без источника ${companies.length}, нужно хотя бы 5`);
  assert.ok(deals.length >= 5, `сделок без источника ${deals.length}, нужно хотя бы 5`);
  assert.strictEqual(snapshot.dataQuality.companiesWithoutSource, companies.length, 'счётчик компаний без источника разошёлся с данными');
  assert.strictEqual(snapshot.dataQuality.dealsWithoutSource, deals.length, 'счётчик сделок без источника разошёлся с данными');
  // Источник не угадывается: у сделки без источника компания может его иметь.
  const inheritedFromCompany = deals.filter((deal) => (companyById.get(deal.companyId)?.sourceId ?? null) !== null);
  assert.ok(inheritedFromCompany.length > 0, 'нет ни одной сделки, потерявшей источник при переносе из компании');
});

check('сделки без формата КЭВ есть и совпадают со счётчиком качества данных', () => {
  const withoutKev = snapshot.deals.filter((deal) => deal.kevFormatId === null);
  assert.ok(withoutKev.length >= 10, `сделок без формата КЭВ ${withoutKev.length}, нужно хотя бы 10`);
  assert.strictEqual(snapshot.dataQuality.dealsWithoutKev, withoutKev.length, 'счётчик сделок без КЭВ разошёлся с данными');
  const filled = snapshot.deals.length - withoutKev.length;
  assert.ok(filled > withoutKev.length, 'заполненных форматов КЭВ должно быть больше, чем пустых');
});

check('часть сущностей заведена служебной стадией, не являющейся этапом воронки', () => {
  const withService = ALL_ENTITIES.filter((item) => item.events.some((event) => isServiceStageId(event.stageId)));
  assert.ok(withService.length >= 5, `сущностей со служебной стадией ${withService.length}, нужно хотя бы 5`);
  for (const item of withService) {
    assert.ok(isServiceStageId(item.events[0].stageId), `${item.kind} ${item.id}: служебная стадия стоит не первой`);
    assert.strictEqual(stageIndex(item.funnelId, item.events[0].stageId), -1, 'служебная стадия попала в этапы воронки');
  }
});

/* ── 5. Распределение по времени ────────────────────────────────────────── */

check('любой стандартный период даёт непустую когорту и непустое движение', () => {
  for (const type of ['week', 'month', 'quarter', 'year']) {
    const period = resolvePeriod({ type }, { now: NOW, timeZone: TIME_ZONE });
    const cohort = new Set(
      snapshot.companyStageEvents
        .filter((event) => event.stageId === TAKEN_TO_WORK_STAGE_ID && inPeriod(event.at, period))
        .map((event) => event.companyId)
    );
    const companyMoves = snapshot.companyStageEvents.filter((event) => inPeriod(event.at, period)).length;
    const dealMoves = snapshot.dealStageEvents.filter((event) => inPeriod(event.at, period)).length;
    assert.ok(cohort.size > 0, `период «${period.label}»: когорта Статики пуста`);
    assert.ok(companyMoves > 0, `период «${period.label}»: нет движения компаний`);
    assert.ok(dealMoves > 0, `период «${period.label}»: нет движения сделок`);
  }
});

check('события ложатся на рабочие часы портала, а не размазаны по суткам', () => {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', hour: '2-digit' });
  const hours = snapshot.companyStageEvents.map((event) => Number(formatter.format(ms(event.at))) % 24);
  const outside = hours.filter((hour) => hour < 6 || hour > 21);
  assert.strictEqual(outside.length, 0, `событий вне рабочего дня портала: ${outside.length}`);
  assert.ok(new Set(hours).size >= 5, 'все события пришлись на один и тот же час — выглядит синтетикой');
});

/* ── 6. Форма воронки: сужение и неровные конверсии ─────────────────────── */

// Счёт по правилам домена: пропущенные этапы докрашиваются (все этапы до достигнутого),
// первая воронка берёт исторический максимум, вторая обрезается текущей стадией.
function funnelCounts(funnelId, items) {
  const stages = FUNNELS[funnelId].stages;
  const counts = stages.map(() => 0);
  for (const item of items) {
    const peak = capReachedIndexByCurrentStage(funnelId, maxReached(funnelId, item.events), item.entity.currentStageId);
    for (let index = 0; index <= peak; index += 1) counts[index] += 1;
  }
  return counts;
}

const companyCounts = funnelCounts('companies', ALL_ENTITIES.filter((item) => item.kind === 'company'));
const dealCounts = funnelCounts('deals', ALL_ENTITIES.filter((item) => item.kind === 'deal'));

check('воронка сужается на каждом этапе обеих воронок', () => {
  for (const [name, counts] of [['компаний', companyCounts], ['сделок', dealCounts]]) {
    for (let index = 1; index < counts.length; index += 1) {
      assert.ok(counts[index] < counts[index - 1], `воронка ${name}: этап ${index} не уже предыдущего (${counts[index]} и ${counts[index - 1]})`);
    }
  }
});

check('конверсии между этапами разные и не ложатся ровными долями', () => {
  const conversions = [];
  for (const counts of [companyCounts, dealCounts]) {
    for (let index = 1; index < counts.length; index += 1) {
      conversions.push(Math.round((counts[index] / counts[index - 1]) * 1000) / 10);
    }
  }
  assert.strictEqual(new Set(conversions).size, conversions.length, `совпавшие конверсии: ${conversions.join(', ')}`);
  const round = conversions.filter((value) => Number.isInteger(value) && value % 5 === 0);
  assert.ok(round.length <= 2, `слишком много круглых конверсий (${round.join(', ')}) — на защите это читается как синтетика`);
});

check('до «Передано в производство» доходят единицы, а не половина сделок', () => {
  const junction = dealCounts[0];
  const production = dealCounts[dealCounts.length - 1];
  assert.ok(production > 0, 'ни одна сделка не дошла до производства — краевой случай не показать');
  assert.ok(production / junction <= 0.1, `в производство ушло ${production} из ${junction} — слишком много для правдоподобной воронки`);
});

check('главная конверсия «Взят в работу → Аванс получен» правдоподобна для B2B', () => {
  const takenToWork = companyCounts[1];
  const advance = dealCounts[ADVANCE_STAGE_INDEX];
  const value = (advance / takenToWork) * 100;
  assert.ok(takenToWork > 0, 'нет компаний, взятых в работу');
  assert.ok(value >= 2 && value <= 20, `главная конверсия ${value.toFixed(1)}% — вне правдоподобного диапазона 2–20%`);
});

/* ── Итог ───────────────────────────────────────────────────────────────── */

console.log(`\nПроверок ${passed + failed}, успешно ${passed}, упало ${failed}`);
if (failed) process.exit(1);
