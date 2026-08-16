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
//
// Структурные правила проверяются на ДВУХ независимых конфигурациях (другое зерно,
// другой момент «сейчас»): снимок, устроенный верно только при одном удачном зерне,
// ничего не доказывает.
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

const TIME_ZONE = 'Europe/Moscow';
// Основная конфигурация — та, на которой демо показывают заказчику.
const MAIN = { seed: 20260815, now: new Date('2026-08-15T09:30:00.000Z') };
// Контрольная — другое зерно и другой момент: правила обязаны держаться и здесь.
const CONTROL = { seed: 777001, now: new Date('2026-07-09T15:20:00.000Z') };

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

/* ── Общие вспомогательные функции ──────────────────────────────────────── */

const COMPANY_STAGES = FUNNELS.companies.stages;
const DEAL_STAGES = FUNNELS.deals.stages;
const JUNCTION_COMPANY_STAGE_ID = COMPANY_STAGES[COMPANY_STAGES.length - 1].id;
const TAKEN_TO_WORK_STAGE_ID = COMPANY_STAGES[1].id;
const ADVANCE_STAGE_INDEX = DEAL_STAGES.length - 2;

const KNOWN_STAGE_IDS = {
  companies: new Set([...COMPANY_STAGES.map((stage) => stage.id), ...SERVICE_STAGE_IDS.companies, ...LOST_STAGE_IDS.companies]),
  deals: new Set([...DEAL_STAGES.map((stage) => stage.id), ...SERVICE_STAGE_IDS.deals, ...LOST_STAGE_IDS.deals])
};

function ms(value) {
  return Date.parse(value);
}

function groupBy(list, key) {
  const map = new Map();
  for (const item of list) {
    const bucket = map.get(item[key]);
    if (bucket) bucket.push(item);
    else map.set(item[key], [item]);
  }
  return map;
}

// Индексы этапов сущности в порядке истории. Служебная стадия и отказ дают -1
// и в положительный путь не входят — на этом стоит вся математика воронки.
function positiveIndexes(funnelId, events) {
  return events.map((event) => stageIndex(funnelId, event.stageId)).filter((index) => index >= 0);
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

// Счёт по правилам домена: пропущенные этапы докрашиваются (засчитаны все этапы
// до достигнутого), первая воронка берёт исторический максимум, вторая обрезается
// текущей стадией активной сделки.
function funnelCounts(funnelId, items) {
  const counts = FUNNELS[funnelId].stages.map(() => 0);
  for (const item of items) {
    const peak = capReachedIndexByCurrentStage(funnelId, maxReached(funnelId, item.events), item.entity.currentStageId);
    for (let index = 0; index <= peak; index += 1) counts[index] += 1;
  }
  return counts;
}

/** Снимок и все индексы по нему: строятся один раз, дальше проверки только ищут. */
function buildModel({ seed, now }) {
  const snapshot = generateDemoSnapshot({ seed, now, portalTimezone: TIME_ZONE });
  const companyById = new Map(snapshot.companies.map((company) => [company.id, company]));
  const dealById = new Map(snapshot.deals.map((deal) => [deal.id, deal]));
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

  const companyItems = snapshot.companies.map((company) => ({
    kind: 'company',
    funnelId: 'companies',
    id: company.id,
    entity: company,
    events: companyEvents.get(company.id) ?? []
  }));
  const dealItems = snapshot.deals.map((deal) => ({
    kind: 'deal',
    funnelId: 'deals',
    id: deal.id,
    entity: deal,
    events: dealEvents.get(deal.id) ?? []
  }));

  return {
    seed,
    now,
    snapshot,
    companyById,
    dealById,
    companyEvents,
    dealEvents,
    dealsByCompany,
    assigneeByEntity,
    companyItems,
    dealItems,
    allItems: [...companyItems, ...dealItems],
    companyCounts: funnelCounts('companies', companyItems),
    dealCounts: funnelCounts('deals', dealItems)
  };
}

/* ------------------------------------------------------------------------- *
 * ЧАСТЬ 1. ПРАВИЛА, ОБЯЗАТЕЛЬНЫЕ ДЛЯ ЛЮБОГО СНИМКА ГЕНЕРАТОРА.
 * Прогоняются на двух конфигурациях.
 * ------------------------------------------------------------------------- */

function runSnapshotChecks(model, label) {
  const { snapshot, companyById, dealById, companyEvents, dealEvents, dealsByCompany, assigneeByEntity, allItems } = model;
  const nowMs = model.now.getTime();
  const name = (text) => `${text} [${label}]`;

  check(name('объём демо-набора укладывается в заявленный: компании, сделки, справочники'), () => {
    const companies = snapshot.companies.length;
    const deals = snapshot.deals.length;
    assert.ok(companies >= 300 && companies <= 500, `компаний ${companies}, ожидалось 300–500`);
    assert.ok(deals >= 400 && deals <= 700, `сделок ${deals}, ожидалось 400–700`);
    assert.ok(snapshot.managers.length >= 6 && snapshot.managers.length <= 8, `менеджеров ${snapshot.managers.length}, ожидалось 6–8`);
    assert.ok(snapshot.sources.length >= 5 && snapshot.sources.length <= 7, `источников ${snapshot.sources.length}, ожидалось 5–7`);
    assert.strictEqual(snapshot.kevFormats.length, 3, `форматов КЭВ ${snapshot.kevFormats.length}, ожидалось 3`);
  });

  check(name('история покрывает больше двенадцати месяцев'), () => {
    const all = [...snapshot.companyStageEvents, ...snapshot.dealStageEvents].map((event) => ms(event.at));
    const spanDays = (Math.max(...all) - Math.min(...all)) / 86400000;
    assert.ok(spanDays >= 365, `история покрывает ${spanDays.toFixed(0)} дней, нужно не меньше 365`);
  });

  check(name('ни одно событие истории не лежит в будущем'), () => {
    const future = [
      ...snapshot.companyStageEvents.map((event) => event.at),
      ...snapshot.dealStageEvents.map((event) => event.at),
      ...snapshot.assigneeEvents.map((event) => event.at)
    ].filter((at) => ms(at) > nowMs);
    assert.strictEqual(future.length, 0, `событий позже «сейчас»: ${future.length}, первое ${future[0]}`);
  });

  check(name('история отсортирована по времени, а внутри сущности время строго возрастает'), () => {
    for (const [what, list] of [
      ['компаний', snapshot.companyStageEvents],
      ['сделок', snapshot.dealStageEvents],
      ['ответственных', snapshot.assigneeEvents]
    ]) {
      for (let index = 1; index < list.length; index += 1) {
        assert.ok(ms(list[index - 1].at) <= ms(list[index].at), `история ${what} не отсортирована на позиции ${index}`);
      }
    }
    for (const item of allItems) {
      for (let index = 1; index < item.events.length; index += 1) {
        assert.ok(
          ms(item.events[index - 1].at) < ms(item.events[index].at),
          `у ${item.kind} ${item.id} два события пришлись на один момент`
        );
      }
    }
  });

  check(name('каждая сделка ссылается на существующую компанию'), () => {
    const orphans = snapshot.deals.filter((deal) => !companyById.has(deal.companyId)).map((deal) => deal.id);
    assert.deepStrictEqual(orphans, [], 'есть сделки без компании');
    assert.strictEqual(snapshot.dataQuality.dealsWithoutCompany, 0);
    const strayCompanyEvents = snapshot.companyStageEvents.filter((event) => !companyById.has(event.companyId));
    const strayDealEvents = snapshot.dealStageEvents.filter((event) => !dealById.has(event.dealId));
    assert.strictEqual(strayCompanyEvents.length, 0, 'история ссылается на несуществующую компанию');
    assert.strictEqual(strayDealEvents.length, 0, 'история ссылается на несуществующую сделку');
  });

  check(name('сделка не открывается раньше, чем у её компании выявлена потребность'), () => {
    for (const deal of snapshot.deals) {
      const junction = (companyEvents.get(deal.companyId) ?? []).find((event) => event.stageId === JUNCTION_COMPANY_STAGE_ID);
      assert.ok(junction, `у компании ${deal.companyId} есть сделка ${deal.id}, но нет события «Потребность выявлена»`);
      const first = (dealEvents.get(deal.id) ?? [])[0];
      assert.ok(first, `у сделки ${deal.id} нет истории`);
      assert.ok(ms(first.at) >= ms(junction.at), `сделка ${deal.id} открыта раньше выявления потребности у компании`);
    }
  });

  check(name('текущая стадия сущности — стадия её последнего события'), () => {
    for (const item of allItems) {
      const last = item.events[item.events.length - 1];
      assert.ok(last, `у ${item.kind} ${item.id} пустая история`);
      assert.strictEqual(item.entity.currentStageId, last.stageId, `${item.kind} ${item.id}: текущая стадия разошлась с историей`);
    }
  });

  check(name('положительный путь начинается с первого этапа воронки — отката без продвижения не бывает'), () => {
    for (const item of allItems) {
      const positives = positiveIndexes(item.funnelId, item.events);
      assert.ok(positives.length > 0, `${item.kind} ${item.id} не имеет ни одного положительного этапа`);
      assert.strictEqual(positives[0], 0, `${item.kind} ${item.id} начинает историю с этапа ${positives[0]}, а не с первого`);
      let peak = -1;
      for (const index of positives) {
        if (index < peak) assert.ok(peak > 0, `${item.kind} ${item.id}: откат раньше любого продвижения`);
        peak = Math.max(peak, index);
      }
    }
  });

  check(name('откат подтверждён историей: под текущей стадией ниже максимума лежит событие максимума'), () => {
    let rolledBack = 0;
    for (const item of allItems) {
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

  check(name('стадии снимка объявлены в доменной конфигурации и есть в справочнике стадий'), () => {
    for (const item of allItems) {
      const known = KNOWN_STAGE_IDS[item.funnelId];
      for (const event of item.events) {
        assert.ok(known.has(event.stageId), `неизвестная стадия «${event.stageId}» у ${item.kind} ${item.id}`);
      }
      assert.ok(known.has(item.entity.currentStageId), `неизвестная текущая стадия у ${item.kind} ${item.id}`);
    }
    for (const funnelId of ['companies', 'deals']) {
      const listed = new Set(snapshot.stages[funnelId].map((stage) => stage.id));
      for (const id of KNOWN_STAGE_IDS[funnelId]) {
        assert.ok(listed.has(id), `стадия «${id}» отсутствует в справочнике снимка`);
      }
      for (const stage of snapshot.stages[funnelId]) {
        assert.ok(stage.name && stage.name.trim() !== '', `у стадии «${stage.id}» нет подписи`);
      }
    }
  });

  check(name('ссылки сущностей ведут в справочники менеджеров, источников и форматов КЭВ'), () => {
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

  check(name('у каждой сущности есть ответственный уже на первом событии истории'), () => {
    for (const item of allItems) {
      const history = assigneeByEntity.get(`${item.kind}:${item.id}`) ?? [];
      assert.ok(history.length > 0, `${item.kind} ${item.id} без истории ответственных`);
      assert.ok(
        ms(history[0].at) <= ms(item.events[0].at),
        `${item.kind} ${item.id}: первый ответственный назначен позже первого события`
      );
      assert.strictEqual(
        item.entity.assignedById,
        history[history.length - 1].managerId,
        `${item.kind} ${item.id}: текущий ответственный разошёлся с историей`
      );
    }
  });

  /* ── Краевые случаи. Ищем перебором, а не верим генератору ── */

  check(name('в снимке есть компании с несколькими потребностями и, значит, несколькими сделками'), () => {
    const multi = [...dealsByCompany.values()].filter((list) => list.length > 1);
    assert.ok(multi.length >= 5, `компаний с несколькими сделками ${multi.length}, нужно хотя бы 5`);
    const ids = new Set(multi.flatMap((list) => list.map((deal) => deal.id)));
    const total = multi.reduce((sum, list) => sum + list.length, 0);
    assert.strictEqual(ids.size, total, 'потребности одной компании ссылаются на одну и ту же сделку');
  });

  check(name('откат компании не стирает достигнутые этапы: исторический максимум выше текущей стадии'), () => {
    const rolled = model.companyItems.filter((item) => {
      const current = stageIndex('companies', item.entity.currentStageId);
      return current >= 0 && current < maxReached('companies', item.events);
    });
    assert.ok(rolled.length >= 5, `откатившихся компаний ${rolled.length}, нужно хотя бы 5`);
    for (const item of rolled) {
      const peak = maxReached('companies', item.events);
      // Правило первой воронки: обрезки по текущей стадии нет никогда.
      assert.strictEqual(
        capReachedIndexByCurrentStage('companies', peak, item.entity.currentStageId),
        peak,
        `компания ${item.id}: достигнутая глубина обрезана текущей стадией`
      );
    }
  });

  check(name('глубина активной сделки обрезается её текущей стадией'), () => {
    const capped = model.dealItems.filter((item) => {
      if (item.entity.isLost) return false;
      const peak = maxReached('deals', item.events);
      return capReachedIndexByCurrentStage('deals', peak, item.entity.currentStageId) < peak;
    });
    assert.ok(capped.length >= 3, `активных сделок с обрезкой ${capped.length}, нужно хотя бы 3`);
    for (const item of capped) {
      assert.ok(!isLostStageId(item.entity.currentStageId), `сделка ${item.id} помечена активной, но стоит в отказе`);
      assert.ok(stageIndex('deals', item.entity.currentStageId) >= 0, `сделка ${item.id}: текущая стадия вне воронки, обрезки не будет`);
    }
  });

  check(name('сделка, откатившаяся и снова продвинувшаяся, не даёт дубля этапа'), () => {
    const recovered = model.dealItems.filter((item) => {
      const positives = positiveIndexes('deals', item.events);
      let wentBack = false;
      for (let index = 1; index < positives.length; index += 1) {
        if (positives[index] < positives[index - 1]) wentBack = true;
        else if (wentBack && positives[index] > positives[index - 1]) return true;
      }
      return false;
    });
    assert.ok(recovered.length >= 3, `сделок с откатом и повторным продвижением ${recovered.length}, нужно хотя бы 3`);
    for (const item of recovered) {
      const unique = new Set(item.events.map((event) => event.stageId));
      assert.ok(unique.size < item.events.length, `сделка ${item.id}: повторное прохождение не оставило следа в истории`);
    }
  });

  check(name('проигранная сделка сохраняет положительный путь, пройденный до отказа'), () => {
    const lost = model.dealItems.filter((item) => item.entity.isLost);
    assert.ok(lost.length >= 10, `проигранных сделок ${lost.length}, нужно хотя бы 10`);
    for (const item of lost) {
      assert.ok(isLostStageId(item.entity.currentStageId), `сделка ${item.id} помечена проигранной, но стоит не в отказе`);
      const peak = maxReached('deals', item.events);
      assert.ok(peak >= 0, `сделка ${item.id}: путь до отказа не сохранён`);
      // Стадия отказа лежит вне воронки, поэтому обрезка не срезает достигнутое (инвариант 5).
      assert.strictEqual(
        capReachedIndexByCurrentStage('deals', peak, item.entity.currentStageId),
        peak,
        `сделка ${item.id}: отказ срезал достигнутый путь`
      );
    }
    const withPath = lost.filter((item) => maxReached('deals', item.events) >= 1);
    assert.ok(withPath.length >= 10, `проигранных сделок, успевших пройти этапы, ${withPath.length}`);
  });

  check(name('есть сущности с пропущенными положительными этапами — расчёт обязан их докрасить'), () => {
    // Пропущенный этап — тот, у которого НЕТ события, хотя более поздний этап пройден.
    // Прыжок вверх после отката пропуском не считается: событие того этапа в истории есть.
    const withGap = (item) => {
      const positives = positiveIndexes(item.funnelId, item.events);
      const reached = new Set(positives);
      const peak = Math.max(...positives);
      for (let index = 0; index < peak; index += 1) {
        if (!reached.has(index)) return true;
      }
      return false;
    };
    const companies = model.companyItems.filter(withGap);
    const deals = model.dealItems.filter(withGap);
    assert.ok(companies.length >= 5, `компаний с пропущенными этапами ${companies.length}, нужно хотя бы 5`);
    assert.ok(deals.length >= 5, `сделок с пропущенными этапами ${deals.length}, нужно хотя бы 5`);
  });

  check(name('есть повторные входы на один этап в пределах одного календарного месяца портала'), () => {
    const repeats = allItems.filter((item) => {
      const seen = new Set();
      for (const event of item.events) {
        if (isServiceStageId(event.stageId) || isLostStageId(event.stageId)) continue;
        const key = `${event.stageId}|${periodKeyFromDate('month', event.at, TIME_ZONE)}`;
        if (seen.has(key)) return true;
        seen.add(key);
      }
      return false;
    });
    assert.ok(repeats.length >= 3, `повторных входов на этап внутри месяца ${repeats.length}, нужно хотя бы 3`);
  });

  check(name('этапы одной сущности бывают пройдены разными ответственными'), () => {
    const handed = [];
    for (const item of allItems) {
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

  check(name('записи без источника есть и совпадают со счётчиком качества данных'), () => {
    const companies = snapshot.companies.filter((company) => company.sourceId === null);
    const deals = snapshot.deals.filter((deal) => deal.sourceId === null);
    assert.ok(companies.length >= 5, `компаний без источника ${companies.length}, нужно хотя бы 5`);
    assert.ok(deals.length >= 5, `сделок без источника ${deals.length}, нужно хотя бы 5`);
    assert.strictEqual(snapshot.dataQuality.companiesWithoutSource, companies.length, 'счётчик компаний без источника разошёлся с данными');
    assert.strictEqual(snapshot.dataQuality.dealsWithoutSource, deals.length, 'счётчик сделок без источника разошёлся с данными');
    // Источник не угадывается: сделка могла потерять его при переносе из компании.
    const lostOnCopy = deals.filter((deal) => (companyById.get(deal.companyId)?.sourceId ?? null) !== null);
    assert.ok(lostOnCopy.length > 0, 'нет ни одной сделки, потерявшей источник при переносе из компании');
  });

  check(name('сделки без формата КЭВ есть и совпадают со счётчиком качества данных'), () => {
    const withoutKev = snapshot.deals.filter((deal) => deal.kevFormatId === null);
    assert.ok(withoutKev.length >= 10, `сделок без формата КЭВ ${withoutKev.length}, нужно хотя бы 10`);
    assert.strictEqual(snapshot.dataQuality.dealsWithoutKev, withoutKev.length, 'счётчик сделок без КЭВ разошёлся с данными');
    assert.ok(snapshot.deals.length - withoutKev.length > withoutKev.length, 'заполненных форматов КЭВ должно быть больше, чем пустых');
  });

  check(name('часть сущностей заведена служебной стадией, не являющейся этапом воронки'), () => {
    const withService = allItems.filter((item) => item.events.some((event) => isServiceStageId(event.stageId)));
    assert.ok(withService.length >= 5, `сущностей со служебной стадией ${withService.length}, нужно хотя бы 5`);
    for (const item of withService) {
      assert.ok(isServiceStageId(item.events[0].stageId), `${item.kind} ${item.id}: служебная стадия стоит не первой`);
      assert.strictEqual(stageIndex(item.funnelId, item.events[0].stageId), -1, 'служебная стадия попала в этапы воронки');
    }
  });

  check(name('любой стандартный период, успевший начаться, даёт непустую когорту и движение'), () => {
    for (const type of ['week', 'month', 'quarter', 'year']) {
      const period = resolvePeriod({ type }, { now: model.now, timeZone: TIME_ZONE });
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

  check(name('события ложатся на рабочие часы портала, а не размазаны по суткам'), () => {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hourCycle: 'h23', hour: '2-digit' });
    const hours = snapshot.companyStageEvents.map((event) => Number(formatter.format(ms(event.at))) % 24);
    const outside = hours.filter((hour) => hour < 6 || hour > 21);
    assert.strictEqual(outside.length, 0, `событий вне рабочего дня портала: ${outside.length}`);
    assert.ok(new Set(hours).size >= 5, 'все события пришлись на один и тот же час — так выглядит синтетика');
  });

  check(name('воронка сужается на каждом этапе обеих воронок'), () => {
    for (const [what, counts] of [['компаний', model.companyCounts], ['сделок', model.dealCounts]]) {
      for (let index = 1; index < counts.length; index += 1) {
        assert.ok(
          counts[index] < counts[index - 1],
          `воронка ${what}: этап ${index} не уже предыдущего (${counts[index]} и ${counts[index - 1]})`
        );
      }
    }
  });

  check(name('до «Передано в производство» доходят единицы, а не половина сделок'), () => {
    const junction = model.dealCounts[0];
    const production = model.dealCounts[model.dealCounts.length - 1];
    assert.ok(production > 0, 'ни одна сделка не дошла до производства — краевой случай не показать');
    assert.ok(production / junction <= 0.1, `в производство ушло ${production} из ${junction} — слишком много для правдоподобной воронки`);
  });

  check(name('главная конверсия «Взят в работу → Аванс получен» правдоподобна для B2B'), () => {
    const takenToWork = model.companyCounts[1];
    const advance = model.dealCounts[ADVANCE_STAGE_INDEX];
    assert.ok(takenToWork > 0, 'нет компаний, взятых в работу');
    const value = (advance / takenToWork) * 100;
    assert.ok(value >= 2 && value <= 20, `главная конверсия ${value.toFixed(1)}% — вне правдоподобного диапазона 2–20%`);
  });
}

/* ------------------------------------------------------------------------- *
 * ЧАСТЬ 2. ПРАВИЛА САМОГО ГЕНЕРАТОРА И ВНЕШНЕГО ВИДА ДЕМО.
 * Проверяются на конфигурации, которую показывают заказчику.
 * ------------------------------------------------------------------------- */

const main = buildModel(MAIN);

check('одно зерно и один момент «сейчас» дают побайтово тот же снимок', () => {
  const again = generateDemoSnapshot({ seed: MAIN.seed, now: MAIN.now, portalTimezone: TIME_ZONE });
  assert.strictEqual(JSON.stringify(again), JSON.stringify(main.snapshot), 'повторный запуск дал другой снимок');
});

check('другое зерно даёт другой снимок — зерно действительно управляет данными', () => {
  const other = generateDemoSnapshot({ seed: MAIN.seed + 1, now: MAIN.now, portalTimezone: TIME_ZONE });
  assert.notStrictEqual(JSON.stringify(other), JSON.stringify(main.snapshot), 'смена зерна ничего не изменила');
});

check('генератор не зависит от Math.random: подмена Math.random не меняет снимок', () => {
  const original = Math.random;
  Math.random = () => 0.42;
  try {
    const again = generateDemoSnapshot({ seed: MAIN.seed, now: MAIN.now, portalTimezone: TIME_ZONE });
    assert.strictEqual(JSON.stringify(again), JSON.stringify(main.snapshot), 'снимок зависит от Math.random');
  } finally {
    Math.random = original;
  }
});

check('часовой пояс портала принимается под обоими именами и правда влияет на календарь', () => {
  // Адаптер источника (`src/sync/source.js`) передаёт зону как `timeZone`, снимок хранит
  // её как `portalTimezone`. Молча проигнорированная зона сдвинула бы границы суток.
  const viaAlias = generateDemoSnapshot({ seed: MAIN.seed, now: MAIN.now, timeZone: 'Asia/Vladivostok' });
  const viaField = generateDemoSnapshot({ seed: MAIN.seed, now: MAIN.now, portalTimezone: 'Asia/Vladivostok' });
  assert.strictEqual(JSON.stringify(viaAlias), JSON.stringify(viaField), 'имя параметра зоны меняет результат');
  assert.strictEqual(viaField.portalTimezone, 'Asia/Vladivostok');
  assert.notStrictEqual(JSON.stringify(viaField), JSON.stringify(main.snapshot), 'смена пояса портала ничего не изменила');
});

check('снимок отдан в той же форме, что хранит стор', () => {
  // Возврат fetchSnapshot() — это EMPTY_CACHE плюс ОДНО дополнительное поле:
  // warnings — сигнал именно ЭТОГО захода синхронизации (src/sync/service.js читает
  // его и строит sync.warnings, а перед сохранением само поле явно вырезает —
  // в персистентном снимке на диске его нет). Тот же контракт использует
  // src/bitrix/fullSync.js — не особенность демо-источника, а общий adapter-контракт.
  assert.deepStrictEqual(
    Object.keys(main.snapshot).sort(),
    [...Object.keys(EMPTY_CACHE), 'warnings'].sort(),
    'набор разделов снимка разошёлся с EMPTY_CACHE + transient warnings'
  );
  assert.ok(Array.isArray(main.snapshot.warnings), 'warnings обязано быть массивом');
  assert.strictEqual(main.snapshot.version, SNAPSHOT_VERSION);
  assert.strictEqual(main.snapshot.source, 'demo');
  assert.strictEqual(main.snapshot.portalTimezone, TIME_ZONE);
  assert.deepStrictEqual(Object.keys(main.snapshot.stages).sort(), ['companies', 'deals']);
  assert.strictEqual(main.snapshot.sync.status, 'success');
  assert.strictEqual(typeof main.snapshot.sync.lastSuccessAt, 'string');
  assert.strictEqual(main.snapshot.dataQuality.assigneeHistoryAvailable, true);
});

check('названия компаний уникальны и не содержат заглушек вроде «Тест» или «Компания 1»', () => {
  const titles = main.snapshot.companies.map((company) => company.title);
  assert.strictEqual(new Set(titles).size, titles.length, 'встретились одинаковые названия компаний');
  const bad = titles.filter((title) => /(lorem|test|тест|демо|пример|компания\s*\d|организация\s*\d)/i.test(title));
  assert.deepStrictEqual(bad, [], `названия-заглушки: ${bad.slice(0, 3).join(', ')}`);
  const empty = [...main.snapshot.companies, ...main.snapshot.deals].filter((item) => !item.title || item.title.trim() === '');
  assert.strictEqual(empty.length, 0, 'есть сущности без названия');
});

check('названия сделок описывают объект строительства, а не номер записи', () => {
  const titles = main.snapshot.deals.map((deal) => deal.title);
  const unique = new Set(titles).size;
  assert.ok(unique / titles.length >= 0.7, `уникальных названий сделок ${unique} из ${titles.length} — слишком однообразно`);
  const suspicious = titles.filter((title) => /(сделка\s*\d|потребность\s*\d|lorem|test)/i.test(title));
  assert.deepStrictEqual(suspicious.slice(0, 3), [], 'названия сделок выглядят порядковыми номерами');
});

check('конверсии между этапами не ложатся ровными долями', () => {
  const conversions = [];
  for (const counts of [main.companyCounts, main.dealCounts]) {
    for (let index = 1; index < counts.length; index += 1) {
      conversions.push(Math.round((counts[index] / counts[index - 1]) * 1000) / 10);
    }
  }
  const distinct = new Set(conversions).size;
  assert.ok(distinct >= conversions.length - 2, `совпавших конверсий слишком много: ${conversions.join(', ')}`);
  const round = conversions.filter((value) => Number.isInteger(value) && value % 5 === 0);
  assert.ok(round.length <= 2, `слишком много круглых конверсий (${round.join(', ')}) — на защите это читается как синтетика`);
  const dealConversions = conversions.slice(main.companyCounts.length - 1);
  const spread = Math.max(...dealConversions) - Math.min(...dealConversions);
  assert.ok(spread >= 25, `разброс конверсий второй воронки ${spread.toFixed(1)} п.п. — воронка сужается слишком ровно`);
});

check('нагрузка распределена по менеджерам неравномерно, как в живом отделе', () => {
  const load = new Map(main.snapshot.managers.map((manager) => [manager.id, 0]));
  for (const company of main.snapshot.companies) load.set(company.assignedById, load.get(company.assignedById) + 1);
  const values = [...load.values()];
  assert.ok(Math.min(...values) > 0, 'есть менеджер без единой компании');
  assert.ok(Math.max(...values) / Math.min(...values) >= 1.3, 'компании разложены по менеджерам подозрительно ровно');
});

/* ── Прогон правил на двух конфигурациях ────────────────────────────────── */

runSnapshotChecks(main, 'демо-зерно');
runSnapshotChecks(buildModel(CONTROL), 'контрольное зерно');

console.log(`\nПроверок ${passed + failed}, успешно ${passed}, упало ${failed}`);
if (failed) process.exit(1);
