// Проверки раздела «Звонки» (src/analytics/calls.js + нормализация в snapshot.js).
//
// Звонки — единственный домен без стадий: они не проходят через воронку, и
// ошибка в них не всплывёт ни в одной другой проверке. Отдельно проверяется
// устойчивость к формам данных РЕАЛЬНОГО портала (числовые ID, 'Y'/'N',
// длительность строкой) — демо-генератор отдаёт уже «правильные» типы, и на
// нём такие ошибки не воспроизводятся.
import assert from 'node:assert';
import { calculateCalls } from '../src/analytics/calls.js';
import { buildIndexUncached } from '../src/analytics/snapshot.js';

const TZ = 'Europe/Moscow';
const NOW = new Date('2026-08-20T12:00:00.000Z');

const cases = [];
function check(name, run) {
  cases.push([name, run]);
}

function snapshot({ calls = [], companies = [], deals = [] } = {}) {
  return {
    source: 'bitrix',
    portalTimezone: TZ,
    updatedAt: NOW.toISOString(),
    companies, deals, calls,
    companyStageEvents: [], dealStageEvents: [], assigneeEvents: [],
    managers: [], sources: [], kevFormats: [], stages: { companies: [], deals: [] }
  };
}

const COMPANY = { id: 'c1', title: 'Компания', sourceId: 's1', assignedById: 'm1', currentStageId: '', createdAt: '2026-08-01T09:00:00.000Z' };
const DEAL = { id: 'd1', companyId: 'c1', title: 'Сделка', sourceId: 's1', kevFormatId: 'k1', assignedById: 'm1', currentStageId: '', createdAt: '2026-08-01T09:00:00.000Z' };

const DAY = { periodType: 'day', periodValue: '2026-08-10' };
const OPTIONS = { now: NOW, timeZone: TZ };

check('итоги считают всего, успешные и минуты за период', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true },
      { id: '2', companyId: 'c1', dealId: 'd1', at: '2026-08-10T10:00:00.000Z', durationMinutes: 3, success: false },
      { id: '3', companyId: 'c1', dealId: null, at: '2026-08-10T11:00:00.000Z', durationMinutes: 2.5, success: true },
      // За пределами дня — не должен попасть ни в итог, ни в график.
      { id: '4', companyId: 'c1', dealId: 'd1', at: '2026-08-11T09:00:00.000Z', durationMinutes: 100, success: true }
    ]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(result.total, 3, 'в итог попал звонок вне периода');
  assert.strictEqual(result.successful, 2);
  assert.strictEqual(result.minutes, 10.5);
});

check('сумма минут по столбцам графика совпадает с итогом', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:30:00.000Z', durationMinutes: 4, success: true },
      { id: '2', companyId: 'c1', dealId: 'd1', at: '2026-08-10T15:10:00.000Z', durationMinutes: 6, success: true }
    ]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  const fromSeries = result.series.reduce((sum, bucket) => sum + bucket.minutes, 0);
  assert.strictEqual(Math.round(fromSeries * 10) / 10, result.minutes, 'график и итог разошлись по минутам');
});

// ── Формы данных реального портала ───────────────────────────────────────────

check('числовые идентификаторы портала не роняют связь звонка с сущностью', () => {
  // Битрикс отдаёт ID числами. Ключи компаний и сделок в индексе — строки:
  // без приведения ни один звонок не попал бы в срез, а карточка показала бы нули.
  const snap = snapshot({
    companies: [{ ...COMPANY, id: 1000 }],
    deals: [{ ...DEAL, id: 5000, companyId: 1000 }],
    calls: [{ id: 9000, companyId: 1000, dealId: 5000, at: '2026-08-10T09:00:00.000Z', durationMinutes: 7, success: true }]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(result.total, 1, 'звонок с числовым ID потерялся');
  assert.strictEqual(result.minutes, 7);
});

check('длительность строкой суммируется как число, а не склеивается', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:00:00.000Z', durationMinutes: '5', success: 'Y' },
      { id: '2', companyId: 'c1', dealId: 'd1', at: '2026-08-10T10:00:00.000Z', durationMinutes: '3', success: 'Y' }
    ]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(result.minutes, 8, `минуты «${result.minutes}» — похоже на склейку строк`);
});

check('«N» Битрикса — это неуспешный звонок, а не истинная строка', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:00:00.000Z', durationMinutes: 1, success: 'N' },
      { id: '2', companyId: 'c1', dealId: 'd1', at: '2026-08-10T10:00:00.000Z', durationMinutes: 1, success: 'Y' }
    ]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(result.successful, 1, 'звонок со статусом «N» посчитан успешным');
});

check('битая дата звонка отбрасывается, а не превращается в NaN на графике', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: 'позавчера', durationMinutes: 5, success: true },
      { id: '2', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true }
    ]
  });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(result.total, 1);
  for (const bucket of result.series) {
    assert.ok(Number.isFinite(bucket.minutes), `в графике не число: ${bucket.minutes}`);
  }
});

// ── Фильтры ──────────────────────────────────────────────────────────────────

check('база НЕ сужает звонки: разговор — работа менеджера, а не свойство сделки', () => {
  // Отбор звонков намеренно уже, чем у воронки: только период и менеджер. Фильтруя
  // звонки базой, карточка показывала бы «сколько звонили по сделкам с заполненным
  // полем» — число, которое падает от качества заполнения CRM, а не от работы отдела.
  const snap = snapshot({
    companies: [COMPANY, { ...COMPANY, id: 'c2', sourceId: 's2' }],
    deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: null, at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true },
      { id: '2', companyId: 'c2', dealId: null, at: '2026-08-10T10:00:00.000Z', durationMinutes: 9, success: true }
    ]
  });
  assert.strictEqual(calculateCalls(snap, DAY, OPTIONS).total, 2);
  const filtered = calculateCalls(snap, { ...DAY, sourceIds: 's1' }, OPTIONS);
  assert.strictEqual(filtered.total, 2, 'фильтр базы не должен сужать звонки');
  assert.strictEqual(filtered.minutes, 14);
});

check('формат КЭВ НЕ сужает звонки', () => {
  const snap = snapshot({
    companies: [COMPANY],
    deals: [DEAL, { ...DEAL, id: 'd2', kevFormatId: 'k2' }],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', at: '2026-08-10T09:00:00.000Z', durationMinutes: 4, success: true },
      { id: '2', companyId: 'c1', dealId: 'd2', at: '2026-08-10T10:00:00.000Z', durationMinutes: 8, success: true }
    ]
  });
  const filtered = calculateCalls(snap, { ...DAY, kevFormats: 'k1' }, OPTIONS);
  assert.strictEqual(filtered.total, 2);
  assert.strictEqual(filtered.minutes, 12);
});

check('звонок без привязки к воронке считается: он всё равно состоялся', () => {
  // Разговор может идти по сущности, которой нет в срезе, или вовсе без привязки.
  // Выкидывая такие, карточка занижала бы работу отдела.
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c-нет-такой', dealId: null, at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true },
      { id: '2', companyId: null, dealId: null, at: '2026-08-10T11:00:00.000Z', durationMinutes: 3, success: false }
    ]
  });
  const all = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(all.total, 2);
  assert.strictEqual(all.minutes, 8);
});

check('фильтр по менеджеру сужает звонки по ИХ менеджеру, а не по ответственному сделки', () => {
  // Разговор принадлежит тому, кто его вёл, даже если сделку потом передали.
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: 'd1', managerId: 'm-звонивший', at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true },
      { id: '2', companyId: 'c1', dealId: 'd1', managerId: 'm-другой', at: '2026-08-10T10:00:00.000Z', durationMinutes: 7, success: false }
    ]
  });
  const mine = calculateCalls(snap, { ...DAY, managerIds: 'm-звонивший' }, OPTIONS);
  assert.strictEqual(mine.total, 1, 'фильтр менеджера обязан сужать звонки');
  assert.strictEqual(mine.minutes, 5);
  assert.strictEqual(mine.successful, 1);
  assert.strictEqual(mine.unsuccessful, 0);
});

check('у звонка без своего менеджера берётся ответственный связанной сущности', () => {
  const snap = snapshot({
    companies: [{ ...COMPANY, assignedById: 'm-компании' }], deals: [DEAL],
    calls: [{ id: '1', companyId: 'c1', dealId: null, at: '2026-08-10T09:00:00.000Z', durationMinutes: 6, success: true }]
  });
  assert.strictEqual(calculateCalls(snap, { ...DAY, managerIds: 'm-компании' }, OPTIONS).total, 1);
});

check('успешные и неуспешные в сумме дают общее число', () => {
  const snap = snapshot({
    companies: [COMPANY], deals: [DEAL],
    calls: [
      { id: '1', companyId: 'c1', dealId: null, at: '2026-08-10T09:00:00.000Z', durationMinutes: 5, success: true },
      { id: '2', companyId: 'c1', dealId: null, at: '2026-08-10T10:00:00.000Z', durationMinutes: 2, success: false },
      { id: '3', companyId: 'c1', dealId: null, at: '2026-08-10T11:00:00.000Z', durationMinutes: 1, success: false }
    ]
  });
  const r = calculateCalls(snap, DAY, OPTIONS);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.successful, 1);
  assert.strictEqual(r.unsuccessful, 2);
  assert.strictEqual(r.successful + r.unsuccessful, r.total);
});

// ── Отсутствие данных ────────────────────────────────────────────────────────

check('пустой раздел звонков даёт нули и пустой график, а не падение', () => {
  const snap = snapshot({ companies: [COMPANY], deals: [DEAL], calls: [] });
  const result = calculateCalls(snap, DAY, OPTIONS);
  assert.deepStrictEqual(
    [result.total, result.successful, result.minutes],
    [0, 0, 0]
  );
  assert.ok(Array.isArray(result.series));
});

check('снимок без раздела звонков вовсе не роняет расчёт', () => {
  const snap = snapshot({ companies: [COMPANY], deals: [DEAL] });
  delete snap.calls;
  const index = buildIndexUncached(snap);
  assert.deepStrictEqual(index.calls, [], 'отсутствующий раздел не стал пустым массивом');
  assert.strictEqual(calculateCalls(snap, DAY, OPTIONS).total, 0);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error.message.split('\n')[0]);
  }
}
if (failed) {
  console.error(`${failed}/${cases.length} проверок звонков упало`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed: cases.length }));
