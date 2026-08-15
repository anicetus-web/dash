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

check('неизвестная ступень даёт внятную ошибку, а не пустой список', () => {
  const snap = snapshot(build([company('c1', { upTo: 2 })]));
  assert.throws(
    () => getStageDetails(snap, { stageRole: 'несуществующая' }, { now: NOW, timeZone: TZ }),
    (error) => error.code === 'BAD_STAGE'
  );
});

/* ─────────── Устойчивость ─────────── */

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

check('совпадающие источники компании и сделки предупреждения не вызывают', () => {
  const parts = [company('c1', { upTo: 5, sourceId: 's1' }), deal('d1', 'c1', { upTo: 2, sourceId: 's1' })];
  const result = dashboard(snapshot(build(parts)));
  assert.ok(
    !result.warnings.some((warning) => warning.code === 'SOURCE_NOT_INHERITED'),
    'ложное предупреждение на корректных данных'
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

check('первая ступень не имеет конверсии к предыдущей', () => {
  const result = dashboard(snapshot(build([company('c1', { upTo: 2 })])));
  assert.strictEqual(result.stages[0].conversionFromPrevious, null);
});

if (failed > 0) {
  console.error(`\n${failed} проверок расчётного модуля упало`);
  process.exit(1);
}
console.log('\nПроверки расчётного модуля пройдены');
