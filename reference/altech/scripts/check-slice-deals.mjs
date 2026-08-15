import assert from 'node:assert';
import { buildDashboardFromCache, sliceDeals, inWorkDeals } from '../src/analytics/dashboard.js';

const ev = (dealId, stageId, day) => ({ id: `${dealId}-${stageId}`, dealId, stageId, createdAt: `2026-05-${String(day).padStart(2, '0')}T10:00:00.000Z` });
const CHAIN = ['C78:PREPARATION', 'C78:UC_SKQQAB', 'C78:PREPAYMENT_INVOIC', 'C78:EXECUTING', 'C78:FINAL_INVOICE', 'C78:UC_QBAV17', 'C78:UC_Z9A6KT', 'C78:UC_50O081'];
// сделка, прошедшая этапы 0..reachIndex; текущая стадия — последняя достигнутая
const deal = (id, reachIndex, amount, sourceId, managerId, extra = {}) => ({
  deal: { id, stageId: CHAIN[reachIndex], amount, currency: 'RUB', sourceId, managerId, ...extra },
  events: CHAIN.slice(0, reachIndex + 1).map((stage, i) => ev(id, stage, i + 1))
});

// d1,d2 — подписаны (reach 7); d3 в работе (reach 4=«Назначена встреча»); d4 квалифицирован (reach1).
const rows = [
  deal('d1', 7, 1000000, 's1', 'm1'),
  deal('d2', 7, 500000, 's2', 'm1'),
  deal('d3', 4, 300000, 's1', 'm2'),
  deal('d4', 1, 0, 's2', 'm2')
];
const snapshot = {
  updatedAt: '2026-06-01T00:00:00.000Z', sync: { lastSuccessAt: '2026-06-01T00:00:00.000Z', warnings: [] },
  sources: [{ id: 's1', name: 'Холодный' }, { id: 's2', name: 'Сайт' }],
  managers: [{ id: 'm1', name: 'Иванов' }, { id: 'm2', name: 'Петров' }],
  deals: rows.map((r) => r.deal),
  stageEvents: rows.flatMap((r) => r.events)
};
const FILTERS = { periodType: 'year', periodValue: '2026', mode: 'static' };
const dash = buildDashboardFromCache(snapshot, FILTERS);
const slice = (s, v) => sliceDeals(snapshot, FILTERS, { slice: s, sliceValue: v });

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok:', name); }
  catch (err) { failed += 1; console.error('FAIL:', name, '→', err.message); }
};

check('contracts: count = kpis.contractSigned.count', () => {
  assert.strictEqual(slice('contracts').count, dash.kpis.contractSigned.count);
  assert.strictEqual(slice('contracts').count, 2); // d1, d2
});
check('contracts: total = сумма подписанных', () => {
  assert.strictEqual(slice('contracts').total, 1500000);
});
check('funnelStage «Взят в работу» = funnel[0].count', () => {
  assert.strictEqual(slice('funnelStage', 'C78:PREPARATION').count, dash.funnel[0].count);
});
check('funnelStage «Договор подписан» = funnel[7].count = 2', () => {
  assert.strictEqual(slice('funnelStage', 'C78:UC_50O081').count, dash.funnel[7].count);
  assert.strictEqual(slice('funnelStage', 'C78:UC_50O081').count, 2);
});
check('manager m1: 2 подписанных (d1,d2)', () => {
  assert.strictEqual(slice('manager', 'm1').count, 2);
  assert.strictEqual(slice('manager', 'm1').total, 1500000);
});
check('manager m2: 0 подписанных', () => {
  assert.strictEqual(slice('manager', 'm2').count, 0);
});
check('source s1: 1 подписанный (d1; d3 не подписан)', () => {
  assert.strictEqual(slice('source', 's1').count, 1);
});
check('inWork: d3 (этап «Назначена встреча», index 4)', () => {
  assert.strictEqual(slice('inWork').count, 1);
  assert.strictEqual(slice('inWork').rows[0].id, 'd3');
});
check('inWork по менеджеру m2: d3', () => {
  assert.strictEqual(slice('inWork', 'm2').count, 1);
  assert.strictEqual(slice('inWork', 'm1').count, 0);
});
check('inWorkDeals прямой вызов: только этапы 3..6', () => {
  const ids = inWorkDeals(snapshot.deals, {}).map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['d3']); // d1/d2 подписаны(7), d4 квалифицирован(1)
});
check('неизвестный срез → null', () => {
  assert.strictEqual(slice('bogus', 'x'), null);
  assert.strictEqual(slice('funnelStage', 'C78:GARBAGE'), null);
});
check('строки среза содержат company/amount/stage/manager/source/eventDate', () => {
  const row = slice('contracts').rows[0];
  for (const key of ['id', 'company', 'amount', 'stage', 'manager', 'source', 'eventDate']) assert.ok(key in row, `нет ${key}`);
  assert.strictEqual(row.stage, 'Договор подписан');
});
check('сортировка по сумме убыв.', () => {
  const amounts = slice('contracts').rows.map((r) => r.amount);
  for (let i = 1; i < amounts.length; i += 1) assert.ok(amounts[i - 1] >= amounts[i]);
});

if (failed) {
  console.error(`\n${failed} проверок slice-deals упало`);
  process.exit(1);
}
console.log('\nвсе проверки slice-deals прошли');
