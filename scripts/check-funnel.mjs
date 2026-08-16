/**
 * Проверки расчётного модуля.
 *
 * Проверяется бизнес-правило, а не факт вызова функции. Каждое название —
 * утверждение из CONTEXT.md или спеки, которое обязано выполняться.
 *
 * Фикстуры строятся конструкторами: снимок собирается из описания «компания
 * дошла до этапа N, откатилась на M», чтобы кейс читался, а не расшифровывался.
 */

import assert from 'node:assert';
import { FUNNELS, stageIdByRole } from '../src/domain/funnels.js';
import { calculateDashboard, computeSlice } from '../src/analytics/dashboard.js';
import { getStageDetails } from '../src/analytics/details.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const TZ = 'Europe/Moscow';

const C = (role) => stageIdByRole(FUNNELS.companies, role);
const D = (role) => stageIdByRole(FUNNELS.deals, role);

const COMPANY_CHAIN = ['newCompany', 'takenToWork', 'firstContact', 'decisionMaker', 'qualified', 'needIdentified'];
const DEAL_CHAIN = ['needIdentified', 'inputsReceived', 'proposalSent', 'proposalDefended', 'requisitesReceived',
  'contractApproval', 'contractSentForSigning', 'contractSigned', 'advanceReceived', 'handedToProduction'];

/** День внутри периода расчёта (июль 2026 — текущий квартал относительно NOW). */
const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00.000Z`;
/** День заведомо раньше периода. */
const old = (n) => `2026-02-${String(n).padStart(2, '0')}T10:00:00.000Z`;

function snapshot({ companies = [], deals = [], companyEvents = [], dealEvents = [], assigneeEvents = [] } = {}) {
  return {
    version: 1,
    updatedAt: '2026-08-15T11:00:00.000Z',
    source: 'test',
    portalTimezone: TZ,
    companies,
    deals,
    companyStageEvents: companyEvents,
    dealStageEvents: dealEvents,
    assigneeEvents,
    managers: [{ id: 'm1', name: 'Первый менеджер' }, { id: 'm2', name: 'Второй менеджер' }],
    sources: [{ id: 's1', name: 'Выставки' }, { id: 's2', name: 'Тендеры' }],
    kevFormats: [{ id: 'online', name: 'Онлайн-встреча' }, { id: 'phone', name: 'Защита по телефону' }],
    stages: { companies: [], deals: [] },
    sync: { status: 'idle', lastStartedAt: null, lastSuccessAt: '2026-08-15T11:00:00.000Z', lastError: null, warnings: [] },
    dataQuality: {}
  };
}

/** Компания, прошедшая цепочку этапов до `upTo` включительно. */
function company(id, { upTo = 1, current = null, sourceId = 's1', manager = 'm1', days = day, extraEvents = [] } = {}) {
  const events = [];
  for (let i = 0; i <= upTo; i += 1) {
    events.push({ companyId: id, stageId: C(COMPANY_CHAIN[i]), at: days(i + 1) });
  }
  events.push(...extraEvents);
  return {
    entity: {
      id,
      title: `Компания ${id}`,
      sourceId,
      currentStageId: current === null ? C(COMPANY_CHAIN[upTo]) : current,
      assignedById: manager,
      createdAt: days(1)
    },
    events
  };
}

/** Сделка, прошедшая цепочку этапов до `upTo` включительно. */
function deal(id, companyId, { upTo = 0, current = null, sourceId = 's1', kev = 'online', manager = 'm1', isLost = false, days = day, extraEvents = [] } = {}) {
  const events = [];
  for (let i = 0; i <= upTo; i += 1) {
    events.push({ dealId: id, stageId: D(DEAL_CHAIN[i]), at: days(i + 10) });
  }
  events.push(...extraEvents);
  return {
    entity: {
      id,
      companyId,
      title: `Сделка ${id}`,
      sourceId,
      kevFormatId: kev,
      currentStageId: current === null ? D(DEAL_CHAIN[upTo]) : current,
      assignedById: manager,
      createdAt: days(10),
      isLost
    },
    events
  };
}

function build(parts) {
  const companies = [];
  const companyEvents = [];
  const deals = [];
  const dealEvents = [];
  for (const part of parts) {
    if (part.entity.companyId !== undefined) {
      deals.push(part.entity);
      dealEvents.push(...part.events);
    } else {
      companies.push(part.entity);
      companyEvents.push(...part.events);
    }
  }
  return { companies, companyEvents, deals, dealEvents };
}

function dashboard(snap, request = {}) {
  return calculateDashboard(snap, { periodType: 'quarter', periodValue: '2026-Q3', ...request }, { now: NOW, timeZone: TZ });
}

/** Количество на ступени по роли. */
function at(result, role) {
  const stage = result.stages.find((item) => item.role === role);
  assert.ok(stage, `Ступень «${role}» отсутствует в результате`);
  return stage.count;
}

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error.message);
  }
};

/* ─────────── Инвариант 1: дедупликация ─────────── */

check('компания не дублируется на ступени при повторном прохождении', () => {
  const c = company('c1', { upTo: 3 });
  // Повторный вход на «Первичный контакт» — сущность одна, ступень одна.
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(9) });
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap), 'firstContact'), 1);
});

check('сделка не дублируется на этапе при повторном прохождении', () => {
  const c = company('c1', { upTo: 5 });
  const d = deal('d1', 'c1', { upTo: 2 });
  d.events.push({ dealId: 'd1', stageId: D('proposalSent'), at: day(20) });
  const snap = snapshot(build([c, d]));
  assert.strictEqual(at(dashboard(snap), 'proposalSent'), 1);
});

/* ─────────── Инвариант 2: пропущенные этапы ─────────── */

check('пропущенные положительные этапы докрашиваются до достигнутого', () => {
  const c = company('c1', { upTo: 1 });
  // Прыжок сразу на «Квалификация пройдена», минуя два этапа.
  c.events.push({ companyId: 'c1', stageId: C('qualified'), at: day(8) });
  c.entity.currentStageId = C('qualified');
  const snap = snapshot(build([c]));
  const result = dashboard(snap);
  assert.strictEqual(at(result, 'firstContact'), 1, 'пропущенный «Первичный контакт» не докрашен');
  assert.strictEqual(at(result, 'decisionMaker'), 1, 'пропущенный «Вышел на ЛПР» не докрашен');
  assert.strictEqual(at(result, 'qualified'), 1);
});

/* ─────────── Инварианты 3–5: откаты в двух воронках ─────────── */

check('откат компании НЕ стирает достигнутые этапы первой воронки', () => {
  const c = company('c1', { upTo: 4 });
  // Компания откатилась на «Первичный контакт», но исторически была на «Квалификации».
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(9) });
  c.entity.currentStageId = C('firstContact');
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap), 'qualified'), 1, 'исторический максимум компании потерян');
});

check('откат активной сделки УБИРАЕТ её с этапов выше текущего', () => {
  const c = company('c1', { upTo: 5 });
  const d = deal('d1', 'c1', { upTo: 4 });
  // Сделка откатилась на «КП отправлено» и активна на нём.
  d.entity.currentStageId = D('proposalSent');
  const snap = snapshot(build([c, d]));
  const result = dashboard(snap);
  assert.strictEqual(at(result, 'proposalSent'), 1, 'сделка должна остаться на текущем этапе');
  assert.strictEqual(at(result, 'requisitesReceived'), 0, 'откат не убрал сделку с верхнего этапа');
});

check('правила откатов двух воронок ПРОТИВОПОЛОЖНЫ и не перепутаны', () => {
  // Один снимок, две сущности, оба отката одинаковой формы — результат обязан отличаться.
  const c = company('c1', { upTo: 4 });
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(9) });
  c.entity.currentStageId = C('firstContact');

  const c2 = company('c2', { upTo: 5 });
  const d = deal('d1', 'c2', { upTo: 4, current: D('proposalSent') });

  const snap = snapshot(build([c, c2, d]));
  const result = dashboard(snap);
  assert.strictEqual(at(result, 'qualified'), 2, 'компании сохраняют исторический максимум');
  assert.strictEqual(at(result, 'requisitesReceived'), 0, 'сделка обрезана текущей стадией');
});

check('повторное продвижение после отката восстанавливает этапы без дубля', () => {
  const c = company('c1', { upTo: 5 });
  const d = deal('d1', 'c1', { upTo: 4 });
  d.events.push({ dealId: 'd1', stageId: D('proposalSent'), at: day(20) });   // откат
  d.events.push({ dealId: 'd1', stageId: D('requisitesReceived'), at: day(22) }); // снова вверх
  d.entity.currentStageId = D('requisitesReceived');
  const snap = snapshot(build([c, d]));
  assert.strictEqual(at(dashboard(snap), 'requisitesReceived'), 1, 'сделка задвоилась после возврата');
});

check('проигранная сделка сохраняет положительный путь до отказа', () => {
  const c = company('c1', { upTo: 5 });
  const d = deal('d1', 'c1', { upTo: 3, current: 'LOST_DEAL', isLost: true });
  const snap = snapshot(build([c, d]));
  assert.strictEqual(at(dashboard(snap), 'proposalDefended'), 1, 'путь проигранной сделки потерян');
});

/* ─────────── Когорта Статики ─────────── */

check('когорта Статики отбирается по первому входу во «Взят в работу»', () => {
  const inside = company('c1', { upTo: 2 });
  const outside = company('c2', { upTo: 2, days: old });
  const snap = snapshot(build([inside, outside]));
  assert.strictEqual(at(dashboard(snap), 'takenToWork'), 1, 'в когорту попала компания вне периода');
});

check('компания, взятая в работу до периода, в когорту Статики не входит', () => {
  const c = company('c1', { upTo: 4, days: old });
  // Движение внутри периода есть, но вход в работу был раньше — для Статики не считается.
  c.events.push({ companyId: 'c1', stageId: C('needIdentified'), at: day(5) });
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap), 'takenToWork'), 0);
});

/* ─────────── Точка соединения ─────────── */

check('компания с несколькими потребностями даёт несколько сделок', () => {
  const c = company('c1', { upTo: 5 });
  const parts = [c, deal('d1', 'c1', { upTo: 1 }), deal('d2', 'c1', { upTo: 1 }), deal('d3', 'c1', { upTo: 1 })];
  const snap = snapshot(build(parts));
  const result = dashboard(snap);
  const junction = result.stages.find((stage) => stage.junction);
  assert.strictEqual(junction.count, 3, 'потребности считаются по сделкам');
  assert.strictEqual(junction.companyCount, 1, 'второй счётчик стыка считает компании');
});

check('два счётчика стыка согласованы между собой', () => {
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 0 }), deal('d2', 'c1', { upTo: 0 }),
    company('c2', { upTo: 5 }), deal('d3', 'c2', { upTo: 0 })
  ];
  const snap = snapshot(build(parts));
  const junction = dashboard(snap).stages.find((stage) => stage.junction);
  assert.strictEqual(junction.count, 3);
  assert.strictEqual(junction.companyCount, 2);
});

check('сделка обгоняет собственную историю компании на стыке — отдельное предупреждение, не молчание', () => {
  // companyCount стыка идёт из связи «сделка → компания», а не из истории самой
  // компании — эти два источника обычно совпадают, но не обязаны. c1 «обгоняет»
  // саму себя: у сделки этап стыка есть, а в истории компании его нет.
  const c1 = company('c1', { upTo: 2 }); // своя история НЕ доходит до needIdentified
  const d1 = deal('d1', 'c1', { upTo: 0 }); // но связанная сделка уже на стыке
  const c2 = company('c2', { upTo: 5 }); // дошла сама, полноценный случай
  const d2 = deal('d2', 'c2', { upTo: 0 });
  const snap = snapshot(build([c1, d1, c2, d2]));
  const result = dashboard(snap);
  const junction = result.stages.find((s) => s.junction);
  assert.strictEqual(junction.companyCount, 2, 'счётчик стыка по владению сделкой не проверяет историю компании');
  assert.ok(
    result.warnings.some((w) => w.code === 'DEAL_AHEAD_OF_COMPANY_STAGE'),
    'расхождение в эту сторону (сделка обогнала компанию) тоже должно быть видно'
  );
});

check('единица учёта меняется на стыке: до — компании, после — сделки', () => {
  const parts = [company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 1 }), deal('d2', 'c1', { upTo: 1 })];
  const result = dashboard(snapshot(build(parts)));
  assert.strictEqual(result.stages.find((s) => s.role === 'qualified').unit, 'company');
  assert.strictEqual(result.stages.find((s) => s.role === 'inputsReceived').unit, 'deal');
  assert.strictEqual(at(result, 'qualified'), 1, 'до стыка считаются компании');
  assert.strictEqual(at(result, 'inputsReceived'), 2, 'после стыка считаются сделки');
});

/* ─────────── Фильтры ─────────── */

check('фильтр КЭВ режет только вторую воронку, компании остаются', () => {
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 2, kev: 'online' }),
    company('c2', { upTo: 5 }), deal('d2', 'c2', { upTo: 2, kev: 'phone' }),
    company('c3', { upTo: 3 }) // до потребности не дошла, КЭВ у неё не существует
  ];
  const snap = snapshot(build(parts));
  const result = dashboard(snap, { kevFormats: 'online' });
  assert.strictEqual(at(result, 'takenToWork'), 3, 'фильтр КЭВ обнулил первую воронку');
  assert.strictEqual(at(result, 'proposalSent'), 1, 'фильтр КЭВ не применился ко второй воронке');
  const junction = result.stages.find((stage) => stage.junction);
  assert.strictEqual(junction.companyCount, 1, 'счётчик компаний стыка не сузился до отфильтрованных сделок');
});

check('фильтр КЭВ не вызывает ложного предупреждения «нет сделки» — асимметрия ожидаема', () => {
  // Обе компании дошли до стыка по своей истории; фильтр КЭВ (режет только
  // сделки, приложение А1) оставляет только одну из двух связанных сделок.
  // companyStageCount(2) > companyCount(1) здесь — ожидаемый эффект фильтра,
  // а не пропавшая сделка, и предупреждение об этом молчать не должно кричать.
  const c1 = company('c1', { upTo: 5 });
  const d1 = deal('d1', 'c1', { upTo: 0, kev: 'online' });
  const c2 = company('c2', { upTo: 5 });
  const d2 = deal('d2', 'c2', { upTo: 0, kev: 'phone' });
  const snap = snapshot(build([c1, d1, c2, d2]));
  const result = dashboard(snap, { kevFormats: 'online' });
  const junction = result.stages.find((s) => s.junction);
  assert.strictEqual(junction.companyCount, 1, 'счётчик стыка сузился фильтром КЭВ по сделкам');
  assert.ok(
    !result.warnings.some((w) => w.code === 'DEAL_WITHOUT_COMPANY'),
    'асимметрия из-за фильтра КЭВ — не повод для ложного предупреждения'
  );
});

check('несколько значений одного фильтра объединяются по ИЛИ', () => {
  const parts = [
    company('c1', { upTo: 2, sourceId: 's1' }),
    company('c2', { upTo: 2, sourceId: 's2' }),
    company('c3', { upTo: 2, sourceId: 's3' })
  ];
  const snap = snapshot(build(parts));
  assert.strictEqual(at(dashboard(snap, { sourceIds: 's1,s2' }), 'takenToWork'), 2);
});

check('пустой выбор фильтра означает «все значения»', () => {
  const parts = [company('c1', { upTo: 2, sourceId: 's1' }), company('c2', { upTo: 2, sourceId: 's2' })];
  const snap = snapshot(build(parts));
  assert.strictEqual(at(dashboard(snap, { sourceIds: '' }), 'takenToWork'), 2);
});

check('запись без источника попадает в «Источник не указан» и не входит в конкретную базу', () => {
  const parts = [company('c1', { upTo: 2, sourceId: null }), company('c2', { upTo: 2, sourceId: 's1' })];
  const snap = snapshot(build(parts));
  assert.strictEqual(at(dashboard(snap, { sourceIds: 's1' }), 'takenToWork'), 1, 'запись без источника попала в конкретную базу');
  assert.strictEqual(at(dashboard(snap, { sourceIds: '__none__' }), 'takenToWork'), 1, 'запись без источника не нашлась по «Источник не указан»');
});

check('пустой формат КЭВ попадает в «Не указано» и не входит в конкретный формат', () => {
  // Спека, Testing Decisions §17. Зеркальный сценарий §16 (пустой источник) уже
  // покрыт тестом выше — этот прямо не имел отдельной проверки, хотя логика
  // matches() в filters.js общая для обоих полей.
  const parts = [company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 2, kev: null }), deal('d2', 'c1', { upTo: 2, kev: 'online' })];
  const snap = snapshot(build(parts));
  assert.strictEqual(at(dashboard(snap, { kevFormats: 'online' }), 'proposalSent'), 1, 'сделка без КЭВ попала в конкретный формат');
  assert.strictEqual(at(dashboard(snap, { kevFormats: '__none__' }), 'proposalSent'), 1, 'сделка без КЭВ не нашлась по «Не указано»');
});

/* ─────────── Инвариант 7: атрибуция менеджера ─────────── */

check('этап до передачи относится прежнему менеджеру, последующие — новому', () => {
  const c = company('c1', { upTo: 4, manager: 'm2' });
  const snap = snapshot({
    ...build([c]),
    assigneeEvents: [
      { entityType: 'company', entityId: 'c1', managerId: 'm1', at: '2026-06-01T00:00:00.000Z' },
      // Передача после третьего события цепочки (day(3) — «Первичный контакт»).
      { entityType: 'company', entityId: 'c1', managerId: 'm2', at: day(4) }
    ]
  });
  const first = dashboard(snap, { managerIds: 'm1' });
  const second = dashboard(snap, { managerIds: 'm2' });
  assert.strictEqual(at(first, 'firstContact'), 1, 'ранний этап не отнесён прежнему менеджеру');
  assert.strictEqual(at(first, 'qualified'), 0, 'поздний этап ошибочно отнесён прежнему менеджеру');
  assert.strictEqual(at(second, 'qualified'), 1, 'поздний этап не отнесён новому менеджеру');
  assert.strictEqual(at(second, 'firstContact'), 0, 'ранний этап ошибочно отнесён новому менеджеру');
});

check('сущность не задваивается при выборе обоих менеджеров', () => {
  const c = company('c1', { upTo: 4 });
  const snap = snapshot({
    ...build([c]),
    assigneeEvents: [
      { entityType: 'company', entityId: 'c1', managerId: 'm1', at: '2026-06-01T00:00:00.000Z' },
      { entityType: 'company', entityId: 'c1', managerId: 'm2', at: day(4) }
    ]
  });
  assert.strictEqual(at(dashboard(snap, { managerIds: 'm1,m2' }), 'firstContact'), 1);
});

check('фильтр по менеджеру может законно дать конверсию свыше 100% в Статике — с пояснением, а не молча', () => {
  // Инвариант 7 в действии: c1 и c3 отработаны менеджером A до decisionMaker,
  // затем переданы менеджеру B. c2 весь путь у менеджера B, но дошла только
  // до firstContact. Под фильтром managerIds='m2': firstContact.count=1 (c2),
  // decisionMaker.count=2 (c1+c3, обе переданы РОВНО на decisionMaker) — соседние
  // ступени перестают быть вложенными множествами, конверсия законно > 100%.
  const c1 = company('c1', { upTo: 4 });
  const c3 = company('c3', { upTo: 4 });
  const c2 = company('c2', { upTo: 2 });
  const snap = snapshot({
    ...build([c1, c2, c3]),
    assigneeEvents: [
      { entityType: 'company', entityId: 'c1', managerId: 'm1', at: '2026-06-01T00:00:00.000Z' },
      { entityType: 'company', entityId: 'c1', managerId: 'm2', at: day(4) },
      { entityType: 'company', entityId: 'c3', managerId: 'm1', at: '2026-06-01T00:00:00.000Z' },
      { entityType: 'company', entityId: 'c3', managerId: 'm2', at: day(4) },
      { entityType: 'company', entityId: 'c2', managerId: 'm2', at: '2026-06-01T00:00:00.000Z' }
    ]
  });
  const result = dashboard(snap, { managerIds: 'm2' });
  assert.strictEqual(at(result, 'firstContact'), 1);
  assert.strictEqual(at(result, 'decisionMaker'), 2);
  const decisionMakerStage = result.stages.find((s) => s.role === 'decisionMaker');
  assert.ok(decisionMakerStage.conversionFromPrevious > 100, 'ожидали законное превышение 100% под фильтром менеджера');
  assert.ok(
    result.notices.some((n) => n.code === 'MANAGER_FILTER_RATIO_OVER_100'),
    'превышение 100% под фильтром менеджера должно сопровождаться пояснением, а не молчать'
  );
});

check('totals.companies совпадает со ступенью 0 без фильтра по менеджеру', () => {
  const parts = [company('c1', { upTo: 2, manager: 'm1' }), company('c2', { upTo: 2, manager: 'm2' })];
  const result = dashboard(snapshot(build(parts)));
  assert.strictEqual(result.totals.companies, at(result, 'newCompany'));
});

check('totals.companies и totals.deals учитывают фильтр по менеджеру, а не только сама воронка', () => {
  // Инвариант 7: менеджер атрибутируется на момент события, поэтому фильтр применяется
  // ВНУТРИ stageSets(), а не к кандидатскому пулу slice.companies/slice.deals. Без явного
  // пересчёта totals по объединению ступеней «В срезе» показывал бы прежний пул
  // целиком — расхождение с тем, что реально видно в самой воронке под тем же фильтром.
  const c1 = company('c1', { upTo: 4, manager: 'm1' });
  const c2 = company('c2', { upTo: 4, manager: 'm2' });
  const d1 = deal('d1', 'c1', { upTo: 2, manager: 'm1' });
  const snap = snapshot(build([c1, c2, d1]));

  const unfiltered = dashboard(snap);
  assert.strictEqual(unfiltered.totals.companies, 2);
  assert.strictEqual(unfiltered.totals.deals, 1);

  const filtered = dashboard(snap, { managerIds: 'm1' });
  assert.strictEqual(filtered.totals.companies, 1, 'totals.companies не сузился по фильтру менеджера');
  assert.strictEqual(filtered.totals.deals, 1);

  const excluded = dashboard(snap, { managerIds: 'm2' });
  assert.strictEqual(excluded.totals.deals, 0, 'сделка менеджера m1 не должна попасть в срез m2');
});

check('без истории ответственных сущность не теряется, но выдаётся предупреждение', () => {
  const c = company('c1', { upTo: 3, manager: 'm1' });
  const snap = snapshot(build([c]));
  const result = dashboard(snap, { managerIds: 'm1' });
  assert.strictEqual(at(result, 'firstContact'), 1, 'сущность потеряна из-за отсутствия истории');
  assert.ok(
    result.warnings.some((w) => w.code === 'ASSIGNEE_HISTORY_MISSING'),
    'нет предупреждения об отсутствии истории ответственных'
  );
});

/* ─────────── Режим Динамики ─────────── */

check('Динамика включает старую сущность, двигавшуюся в периоде', () => {
  const c = company('c1', { upTo: 2, days: old });
  c.events.push({ companyId: 'c1', stageId: C('decisionMaker'), at: day(6) });
  c.entity.currentStageId = C('decisionMaker');
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap, { mode: 'dynamic' }), 'decisionMaker'), 1);
});

check('Динамика исключает сущность, не двигавшуюся в периоде', () => {
  const c = company('c1', { upTo: 3, days: old });
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap, { mode: 'dynamic' }), 'decisionMaker'), 0);
});

check('Динамика докрашивает пропущенные этапы от предыдущей позиции, а не от нуля', () => {
  const c = company('c1', { upTo: 2, days: old });          // до периода дошла до «Первичного контакта»
  c.events.push({ companyId: 'c1', stageId: C('needIdentified'), at: day(6) }); // прыжок на стык
  c.entity.currentStageId = C('needIdentified');
  const snap = snapshot(build([c]));
  const result = dashboard(snap, { mode: 'dynamic' });
  assert.strictEqual(at(result, 'newCompany'), 0, 'докраска ушла задним числом к началу воронки');
  assert.strictEqual(at(result, 'firstContact'), 0, 'засчитан этап, пройденный до периода');
  assert.strictEqual(at(result, 'decisionMaker'), 1, 'пропущенный этап не докрашен');
  assert.strictEqual(at(result, 'qualified'), 1, 'пропущенный этап не докрашен');
});

check('Динамика не засчитывает обратный переход как прохождение', () => {
  const c = company('c1', { upTo: 4, days: old });
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(6) }); // откат внутри периода
  c.entity.currentStageId = C('firstContact');
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap, { mode: 'dynamic' }), 'firstContact'), 0, 'откат засчитан как движение');
});

check('Динамика засчитывает настоящий подъём в периоде даже ниже исторического пика до периода', () => {
  // Сделка: до периода дошла до requisitesReceived, откатилась до proposalSent
  // (тоже до периода), затем ВНУТРИ периода настояще продвинулась до
  // proposalDefended. Исторический пик выше — но само движение случилось
  // в периоде, и его нельзя терять из-за пика, достигнутого раньше.
  const c = company('c1', { upTo: 5, days: old });
  const d = deal('d1', 'c1', { upTo: 4, days: old }); // дошла до requisitesReceived, до периода
  d.events.push({ dealId: 'd1', stageId: D('proposalSent'), at: old(20) }); // откат, ещё до периода
  d.events.push({ dealId: 'd1', stageId: D('proposalDefended'), at: day(5) }); // настоящий подъём в периоде
  d.entity.currentStageId = D('proposalDefended');
  const snap = snapshot(build([c, d]));
  const result = dashboard(snap, { mode: 'dynamic' });
  assert.strictEqual(at(result, 'proposalSent'), 0, 'событие отката вне периода не должно засчитываться');
  assert.strictEqual(at(result, 'proposalDefended'), 1, 'настоящий подъём в периоде не должен теряться из-за пика до периода');
});

check('Динамика: та же проверка для воронки компаний (keepHistoricalMax)', () => {
  const c = company('c1', { upTo: 5, days: old }); // дошла до needIdentified, до периода
  c.events.push({ companyId: 'c1', stageId: C('takenToWork'), at: old(20) }); // откат, ещё до периода
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(6) }); // настоящий подъём в периоде
  c.entity.currentStageId = C('firstContact');
  const snap = snapshot(build([c]));
  const result = dashboard(snap, { mode: 'dynamic' });
  assert.strictEqual(at(result, 'takenToWork'), 0, 'событие отката вне периода не должно засчитываться');
  assert.strictEqual(at(result, 'firstContact'), 1, 'настоящий подъём в периоде не должен теряться из-за пика до периода');
});

check('Динамика считает повторный вход на этап один раз', () => {
  const c = company('c1', { upTo: 1, days: old });
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(5) });
  c.events.push({ companyId: 'c1', stageId: C('firstContact'), at: day(9) });
  c.entity.currentStageId = C('firstContact');
  const snap = snapshot(build([c]));
  assert.strictEqual(at(dashboard(snap, { mode: 'dynamic' }), 'firstContact'), 1);
});

/* ─────────── Конверсии ─────────── */

check('конверсия внутри первой воронки считается по компаниям', () => {
  const parts = [company('c1', { upTo: 4 }), company('c2', { upTo: 2 })];
  const result = dashboard(snapshot(build(parts)), { conversionFrom: 'takenToWork', conversionTo: 'qualified' });
  assert.strictEqual(result.selectedConversion.fromUnit, 'company');
  assert.strictEqual(result.selectedConversion.toUnit, 'company');
  assert.strictEqual(result.selectedConversion.value, 50);
});

check('конверсия внутри второй воронки считается по сделкам', () => {
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 4 }), deal('d2', 'c1', { upTo: 1 })
  ];
  const result = dashboard(snapshot(build(parts)), { conversionFrom: 'inputsReceived', conversionTo: 'requisitesReceived' });
  assert.strictEqual(result.selectedConversion.fromUnit, 'deal');
  assert.strictEqual(result.selectedConversion.value, 50);
});

check('конверсия через стык возвращает основной и дополнительный показатели', () => {
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 8 }),
    company('c2', { upTo: 5 }), deal('d2', 'c2', { upTo: 1 }),
    company('c3', { upTo: 2 })
  ];
  const result = dashboard(snapshot(build(parts)), { conversionFrom: 'takenToWork', conversionTo: 'advanceReceived' });
  const selected = result.selectedConversion;
  assert.ok(selected.crossesJunction, 'пересечение стыка не распознано');
  assert.strictEqual(selected.value, 50, 'основной показатель должен считаться от потребностей (1 из 2)');
  assert.ok(selected.secondary, 'дополнительный показатель отсутствует');
  assert.strictEqual(selected.secondary.baseUnit, 'company');
  assert.strictEqual(selected.secondary.baseCount, 3, 'база дополнительного показателя — компании верхней ступени');
  assert.ok(Math.abs(selected.secondary.value - 33.3) < 0.05, `ожидалось ~33.3%, получено ${selected.secondary.value}`);
});

check('конверсия, заканчивающаяся РОВНО на стыке, не тавтологична и не пересекает единицу учёта', () => {
  // Вырожденный случай: toRole === 'needIdentified' (сам стык). Стык несёт оба юнита
  // сразу, и без явного разрешения этой неоднозначности toRow совпадал бы с самим
  // junctionRow — основной показатель делил бы число само на себя (всегда 100%),
  // а дополнительный делил бы счётчик сделок на счётчик компаний (мог превышать 100%).
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 1 }), deal('d2', 'c1', { upTo: 1 }), // 1 компания, 2 потребности
    company('c2', { upTo: 4 }) // не дошла до стыка
  ];
  const result = dashboard(snapshot(build(parts)), { conversionFrom: 'qualified', conversionTo: 'needIdentified' });
  const selected = result.selectedConversion;
  assert.strictEqual(selected.crossesJunction, false, 'стык на конце диапазона не должен считаться пересечением');
  assert.strictEqual(selected.fromUnit, 'company');
  assert.strictEqual(selected.toUnit, 'company', 'конечная точка на стыке должна читаться в единице учёта начальной точки');
  assert.strictEqual(selected.toCount, 1, 'toCount обязан быть счётчиком КОМПАНИЙ стыка (companyCount), а не сделок');
  assert.strictEqual(selected.value, 50, '1 из 2 компаний дошла до стыка');
  assert.strictEqual(selected.secondary, undefined, 'без пересечения дополнительный показатель не нужен');
});

check('нулевой знаменатель даёт 0% и признак «не от чего считать», а не ошибку', () => {
  const snap = snapshot(build([]));
  const result = dashboard(snap, { conversionFrom: 'takenToWork', conversionTo: 'qualified' });
  assert.strictEqual(result.selectedConversion.value, 0);
  assert.strictEqual(result.selectedConversion.available, false);
});

check('конечный этап раньше начального отклоняется', () => {
  const parts = [company('c1', { upTo: 4 })];
  const result = dashboard(snapshot(build(parts)), { conversionFrom: 'qualified', conversionTo: 'takenToWork' });
  assert.strictEqual(result.selectedConversion.error, 'BAD_CONVERSION_RANGE');
});

check('главная конверсия считается от «Взят в работу» до «Аванс получен»', () => {
  const parts = [company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 8 }), company('c2', { upTo: 2 })];
  const result = dashboard(snapshot(build(parts)));
  assert.strictEqual(result.primaryConversion.fromRole, 'takenToWork');
  assert.strictEqual(result.primaryConversion.toRole, 'advanceReceived');
  assert.strictEqual(result.primaryConversion.toCount, 1);
});

check('«Передано в производство» помечено операционной ступенью и не заменяет главную конверсию', () => {
  const parts = [company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 9 })];
  const result = dashboard(snapshot(build(parts)));
  const operational = result.stages.find((stage) => stage.role === 'handedToProduction');
  assert.strictEqual(operational.operational, true);
  assert.strictEqual(result.primaryConversion.toRole, 'advanceReceived');
});

/* ─────────── Инвариант 8: детализация = число ступени ─────────── */

check('детализация каждой ступени совпадает с числом этой ступени', () => {
  const parts = [
    company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 9 }), deal('d2', 'c1', { upTo: 3 }),
    company('c2', { upTo: 5 }), deal('d3', 'c2', { upTo: 5 }),
    company('c3', { upTo: 3 }),
    company('c4', { upTo: 1 })
  ];
  const snap = snapshot(build(parts));
  const request = { periodType: 'quarter', periodValue: '2026-Q3' };
  const result = calculateDashboard(snap, request, { now: NOW, timeZone: TZ });

  for (const stage of result.stages) {
    const details = getStageDetails(snap, { ...request, stageRole: stage.role, pageSize: 500 },
      { now: NOW, timeZone: TZ, portalUrl: 'https://example.bitrix24.ru' });
    assert.strictEqual(
      details.count, stage.count,
      `ступень «${stage.name}»: агрегат ${stage.count}, детализация ${details.count}`
    );
    const unique = new Set(details.rows.map((row) => `${row.entityType}:${row.id}`));
    assert.strictEqual(
      unique.size, Math.min(stage.count, 500),
      `ступень «${stage.name}»: уникальных строк ${unique.size}, ожидалось ${stage.count}`
    );
  }
});

check('детализация не показывает дату этапа, в число которого агрегат сделку не засчитал (откат)', () => {
  const c = company('c1', { upTo: 5 });
  // История доходит до proposalSent (index 2), но текущая стадия откачена до
  // inputsReceived (index 1) — capByCurrentStage должен обрезать обе стороны одинаково.
  const d = deal('d1', 'c1', { upTo: 2, current: D('inputsReceived') });
  const snap = snapshot(build([c, d]));
  const request = { periodType: 'quarter', periodValue: '2026-Q3' };

  const proposalSentDetails = getStageDetails(snap, { ...request, stageRole: 'proposalSent' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(proposalSentDetails.count, 0, 'откат должен убрать сделку с этой ступени агрегата');

  const inputsReceivedDetails = getStageDetails(snap, { ...request, stageRole: 'inputsReceived' }, { now: NOW, timeZone: TZ });
  const row = inputsReceivedDetails.rows.find((r) => r.id === 'd1');
  assert.ok(row, 'сделка обязана остаться на своей фактической ступени');
  assert.ok(
    !row.stageDates.some((entry) => entry.role === 'proposalSent'),
    'stageDates не должен показывать дату этапа, в число которого сделка не засчитана'
  );
});

check('общее количество детализации считается до постраничной обрезки', () => {
  const parts = [company('c1', { upTo: 5 })];
  for (let i = 1; i <= 7; i += 1) parts.push(deal(`d${i}`, 'c1', { upTo: 1 }));
  const snap = snapshot(build(parts));
  const details = getStageDetails(snap,
    { periodType: 'quarter', periodValue: '2026-Q3', stageRole: 'inputsReceived', pageSize: 3 },
    { now: NOW, timeZone: TZ });
  assert.strictEqual(details.count, 7, 'общее количество обрезано лимитом страницы');
  assert.strictEqual(details.rows.length, 3);
  assert.strictEqual(details.pageCount, 3);
});

check('строки детализации не содержат контактных данных', () => {
  const parts = [company('c1', { upTo: 5 }), deal('d1', 'c1', { upTo: 2 })];
  const snap = snapshot(build(parts));
  const details = getStageDetails(snap,
    { periodType: 'quarter', periodValue: '2026-Q3', stageRole: 'proposalSent' },
    { now: NOW, timeZone: TZ });
  const forbidden = ['phone', 'email', 'comment', 'contact'];
  for (const row of details.rows) {
    for (const key of Object.keys(row)) {
      assert.ok(
        !forbidden.some((word) => key.toLowerCase().includes(word)),
        `в строке детализации найдено контактное поле «${key}»`
      );
    }
  }
});

check('фильтры внутри модалки детализации (источник/менеджер/КЭВ) сужают список ступени', () => {
  const c1 = company('c1', { upTo: 5 });
  const c2 = company('c2', { upTo: 5 });
  const d1 = deal('d1', 'c1', { upTo: 3, sourceId: 'sA', manager: 'mA', kev: 'online' });
  const d2 = deal('d2', 'c2', { upTo: 3, sourceId: 'sB', manager: 'mB', kev: 'offline' });
  const snap = snapshot(build([c1, c2, d1, d2]));
  const base = { periodType: 'quarter', periodValue: '2026-Q3', stageRole: 'proposalSent' };

  const all = getStageDetails(snap, base, { now: NOW, timeZone: TZ });
  assert.strictEqual(all.count, 2, 'без фильтров детализации видно обе сделки');
  assert.strictEqual(all.totalCount, 2, 'totalCount — это count ступени ДО фильтров детализации');

  const bySource = getStageDetails(snap, { ...base, detailSourceIds: 'sA' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(bySource.count, 1);
  assert.strictEqual(bySource.rows[0].id, 'd1');
  assert.strictEqual(bySource.totalCount, 2, 'totalCount не должен сужаться вместе с count');

  const byManager = getStageDetails(snap, { ...base, detailManagerIds: 'mB' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(byManager.count, 1);
  assert.strictEqual(byManager.rows[0].id, 'd2');

  const byKev = getStageDetails(snap, { ...base, detailKevFormats: 'offline' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(byKev.count, 1);
  assert.strictEqual(byKev.rows[0].id, 'd2');

  const combinedNothing = getStageDetails(
    snap, { ...base, detailSourceIds: 'sA', detailManagerIds: 'mB' }, { now: NOW, timeZone: TZ }
  );
  assert.strictEqual(combinedNothing.count, 0, 'фильтры детализации комбинируются по И, как и фильтры дашборда');
});

check('фильтр «текущий этап» внутри детализации бьёт по тому же имени, что видно в таблице', () => {
  // d1 сейчас ровно на разбираемой ступени, d2 — на разбираемую прошла, но уехала дальше.
  const c1 = company('c1', { upTo: 5 });
  const c2 = company('c2', { upTo: 5 });
  const d1 = deal('d1', 'c1', { upTo: 2 }); // current = proposalSent
  const d2 = deal('d2', 'c2', { upTo: 3 }); // current = proposalDefended
  const snap = snapshot(build([c1, c2, d1, d2]));
  const base = { periodType: 'quarter', periodValue: '2026-Q3', stageRole: 'proposalSent' };

  const all = getStageDetails(snap, base, { now: NOW, timeZone: TZ });
  assert.strictEqual(all.count, 2);
  assert.strictEqual(all.stageOptions.length, 2, 'у двух сделок на разных текущих этапах — два варианта фильтра');

  const targetName = all.rows.find((r) => r.id === 'd1').currentStageName;
  assert.ok(all.stageOptions.includes(targetName), 'варианты фильтра должны содержать реальное имя из строки');

  const filtered = getStageDetails(snap, { ...base, detailCurrentStage: targetName }, { now: NOW, timeZone: TZ });
  assert.strictEqual(filtered.count, 1);
  assert.strictEqual(filtered.rows[0].id, 'd1');
  // Варианты фильтра остаются полными и после его применения — иначе выбрать
  // другое значение стало бы нельзя (список схлопнулся бы сам под себя).
  assert.strictEqual(filtered.stageOptions.length, 2);
});

check('неизвестная ступень даёт внятную ошибку, а не пустой список', () => {
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  assert.throws(
    () => getStageDetails(snap, { stageRole: 'несуществующая' }, { now: NOW, timeZone: TZ }),
    (error) => error.code === 'BAD_STAGE'
  );
});

/* ─────────── Устойчивость ─────────── */

check('freshness.source отражает реальный источник снимка, а не всегда null', () => {
  // buildIndex() в snapshot.js использует локальное имя `source` для параметра
  // снимка — оно затеняет одноимённое поле снимка (demo/bitrix), и без явного
  // переноса это поле никогда не попадало бы в индекс, из-за чего freshness.source
  // в ответе /api/dashboard был бы всегда null независимо от активного источника.
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  assert.strictEqual(snap.source, 'test', 'фикстура должна задавать источник');
  const result = dashboard(snap);
  assert.strictEqual(result.freshness.source, 'test');
});

check('пустой снимок не роняет расчёт и помечается предупреждением', () => {
  const result = dashboard(snapshot({}));
  assert.strictEqual(result.stages.every((stage) => stage.count === 0), true);
  assert.ok(result.warnings.some((warning) => warning.code === 'SNAPSHOT_EMPTY'));
});

check('сделка без компании в сквозную воронку не попадает и даёт предупреждение', () => {
  const c = company('c1', { upTo: 5 });
  const orphan = deal('d9', 'нет-такой-компании', { upTo: 2 });
  const snap = snapshot(build([c, orphan]));
  const result = dashboard(snap);
  assert.strictEqual(at(result, 'proposalSent'), 0);
  assert.ok(result.warnings.some((warning) => warning.code === 'DEAL_WITHOUT_COMPANY'));
});

check('расхождение источника сделки и компании даёт предупреждение о настройке портала', () => {
  const c = company('c1', { upTo: 5, sourceId: 's1' });
  const d = deal('d1', 'c1', { upTo: 2, sourceId: 's2' }); // источник не перенёсся автоматизацией
  const result = dashboard(snapshot(build([c, d])));
  assert.ok(
    result.warnings.some((warning) => warning.code === 'SOURCE_NOT_INHERITED'),
    'дашборд промолчал о том, что источник не переносится в дочернюю сделку'
  );
});

check('пустой (не перенесённый) источник сделки тоже даёт предупреждение о настройке портала', () => {
  // Самый частый реальный случай: автоматизация Битрикса просто не отработала,
  // и источник сделки остался пустым — а не заполнился каким-то ДРУГИМ значением.
  const c = company('c1', { upTo: 5, sourceId: 's1' });
  const d = deal('d1', 'c1', { upTo: 2, sourceId: null });
  const result = dashboard(snapshot(build([c, d])));
  assert.ok(
    result.warnings.some((warning) => warning.code === 'SOURCE_NOT_INHERITED'),
    'пустой источник сделки при известном источнике компании должен считаться расхождением'
  );
});

check('совпадающие источники компании и сделки предупреждения не вызывают', () => {
  const parts = [company('c1', { upTo: 5, sourceId: 's1' }), deal('d1', 'c1', { upTo: 2, sourceId: 's1' })];
  const result = dashboard(snapshot(build(parts)));
  assert.ok(
    !result.warnings.some((warning) => warning.code === 'SOURCE_NOT_INHERITED'),
    'ложное предупреждение на корректных данных'
  );
});

check('на демо-снимке предупреждения о качестве данных портала скрыты, а пустой снимок — нет', () => {
  // dataSource='demo': расхождения — это преднамеренный шум генератора демо-данных
  // (нужен, чтобы прогнать эти самые ветки в остальных тестах), а не сигнал о
  // реальной проблеме на портале клиента, которого у демо-снимка ещё нет.
  const c = company('c1', { upTo: 5, sourceId: 's1' });
  const d = deal('d1', 'c1', { upTo: 2, sourceId: 's2' });
  const orphan = deal('d9', 'нет-такой-компании', { upTo: 2 });
  const demoResult = calculateDashboard(
    snapshot(build([c, d, orphan])),
    { periodType: 'quarter', periodValue: '2026-Q3' },
    { now: NOW, timeZone: TZ, dataSource: 'demo' }
  );
  assert.ok(
    !demoResult.warnings.some((w) => w.code === 'SOURCE_NOT_INHERITED' || w.code === 'DEAL_WITHOUT_COMPANY'),
    'предупреждения о качестве демо-данных не должны показываться зрителю демо'
  );

  const emptyDemoResult = calculateDashboard(snapshot({}), { periodType: 'quarter', periodValue: '2026-Q3' }, {
    now: NOW,
    timeZone: TZ,
    dataSource: 'demo'
  });
  assert.ok(
    emptyDemoResult.warnings.some((w) => w.code === 'SNAPSHOT_EMPTY'),
    'пустой снимок — структурный факт, а не шум демо-генератора, скрывать его нельзя и в demo-режиме'
  );
});

check('период с будущим концом обрезается текущим моментом', () => {
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  const result = dashboard(snap);
  assert.strictEqual(result.appliedRequest.period.clamped, true, 'текущий квартал должен быть обрезан «сейчас»');
  assert.ok(
    Date.parse(result.appliedRequest.period.to) <= NOW.getTime(),
    'расчётная граница периода ушла в будущее'
  );
});

check('порядок ступеней в ответе — сквозная последовательность без повторов стыка', () => {
  const result = dashboard(snapshot(build([company('c1', { upTo: 2 })])));
  const positions = result.stages.map((stage) => stage.position);
  assert.deepStrictEqual(positions, [...positions].sort((a, b) => a - b), 'ступени не по порядку');
  assert.strictEqual(new Set(positions).size, positions.length, 'позиции повторяются');
  assert.strictEqual(result.stages.filter((stage) => stage.junction).length, 1, 'стык встречается не один раз');
});

check('«Вся история» в Динамике отклоняется на уровне расчётного модуля, а не только HTTP', () => {
  // Правило обязано жить в computeSlice — иначе любой вызывающий помимо HTTP-маршрута
  // (выгрузка, будущая интеграция) мог бы получить бессмысленный срез без ошибки.
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  assert.throws(
    () => calculateDashboard(snap, { mode: 'dynamic', periodType: 'allHistory' }, { now: NOW, timeZone: TZ }),
    (error) => error.code === 'ALL_HISTORY_REQUIRES_STATIC' && error.status === 400
  );
});

check('«Вся история» в Статике не отклоняется расчётным модулем', () => {
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  const result = calculateDashboard(snap, { mode: 'static', periodType: 'allHistory' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(result.appliedRequest.period.type, 'allHistory');
});

check('неизвестный тип периода откатывается к кварталу с пояснением в warnings', () => {
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  const result = calculateDashboard(snap, { periodType: 'совсем-не-то' }, { now: NOW, timeZone: TZ });
  assert.strictEqual(result.appliedRequest.period.type, 'quarter');
  assert.ok(
    result.warnings.some((w) => w.code === 'PERIOD_NOTE' && w.message.includes('совсем-не-то')),
    'пользователь не узнал, что его тип периода не распознан'
  );
});

check('первая ступень не имеет конверсии к предыдущей', () => {
  const result = dashboard(snapshot(build([company('c1', { upTo: 2 })])));
  assert.strictEqual(result.stages[0].conversionFromPrevious, null);
});

if (failed > 0) {
  console.error(`\n${failed} проверок расчётного модуля упало`);
  process.exit(1);
}
console.log('\nПроверки расчётного модуля пройдены');
