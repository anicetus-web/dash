import { buildDashboardFromCache } from '../src/analytics/dashboard.js';

const snapshot = {
  updatedAt: '2026-06-11T00:00:00.000Z',
  sync: { lastSuccessAt: '2026-06-11T00:00:00.000Z', warnings: [] },
  sources: [{ id: 'forum', name: 'Форум BIM' }],
  deals: [
    { id: '1', stageId: 'C78:WON', amount: 100000, currency: 'RUB', managerId: '10', sourceId: 'forum' },
    { id: '2', stageId: 'C78:UC_SKQQAB', amount: 50000, currency: 'RUB', managerId: '10', sourceId: 'forum' },
    { id: '3', stageId: 'C78:UC_Z9A6KT', amount: 70000, currency: 'RUB', managerId: '10', sourceId: 'forum' },
    { id: '4', stageId: 'C78:UC_50O081', amount: 90000, currency: 'RUB', managerId: '10', sourceId: 'forum' },
    { id: '5', stageId: 'C78:WON', amount: 200000, currency: 'USD', managerId: '10', sourceId: 'forum' },
    { id: '6', stageId: 'C78:FINAL_INVOICE', amount: 40000, currency: 'RUB', managerId: '11', sourceId: 'forum' },
    { id: '7', stageId: 'C78:UC_QBAV17', amount: 60000, currency: 'RUB', managerId: '10', sourceId: 'forum' }
  ],
  stageEvents: [
    { id: 'e1', dealId: '1', stageId: 'C78:PREPARATION', createdAt: '2026-06-01T10:00:00.000Z' },
    { id: 'e2', dealId: '1', stageId: 'C78:UC_SKQQAB', createdAt: '2026-06-02T10:00:00.000Z' },
    { id: 'e3', dealId: '1', stageId: 'C78:WON', createdAt: '2026-06-03T10:00:00.000Z' },
    { id: 'e4', dealId: '2', stageId: 'C78:PREPARATION', createdAt: '2026-06-01T10:00:00.000Z' },
    { id: 'e5', dealId: '2', stageId: 'C78:UC_Z9A6KT', createdAt: '2026-06-02T10:00:00.000Z' },
    { id: 'e6', dealId: '2', stageId: 'C78:UC_SKQQAB', createdAt: '2026-06-04T10:00:00.000Z' },
    { id: 'e7', dealId: '3', stageId: 'C78:UC_Z9A6KT', createdAt: '2026-06-05T10:00:00.000Z' },
    { id: 'e8', dealId: '4', stageId: 'C78:UC_50O081', createdAt: '2026-06-06T10:00:00.000Z' },
    { id: 'e9', dealId: '5', stageId: 'C78:WON', createdAt: '2026-06-07T10:00:00.000Z' },
    { id: 'e10', dealId: '6', stageId: 'C78:UC_SKQQAB', createdAt: '2026-06-08T10:00:00.000Z' },
    { id: 'e11', dealId: '6', stageId: 'C78:FINAL_INVOICE', createdAt: '2026-06-09T10:00:00.000Z' }
  ]
};

const dashboard = buildDashboardFromCache(snapshot, {
  from: '2026-06-01',
  to: '2026-06-11',
  mode: 'static'
}, { now: new Date('2026-06-11T12:00:00.000Z') });

const dynamicDashboard = buildDashboardFromCache(snapshot, {
  from: '2026-06-01',
  to: '2026-06-11',
  mode: 'dynamic',
  managerId: '11'
}, { now: new Date('2026-06-11T12:00:00.000Z') });

const dynamicAllManagers = buildDashboardFromCache(snapshot, {
  from: '2026-06-01',
  to: '2026-06-11',
  mode: 'dynamic'
}, { now: new Date('2026-06-11T12:00:00.000Z') });

const quarterDashboard = buildDashboardFromCache(snapshot, {
  quarter: '2026-Q2',
  granularity: 'week',
  mode: 'dynamic'
}, {
  now: new Date('2026-06-11T12:00:00.000Z'),
  plans: { managerPlans: { 10: 200000, 11: 100000 } }
});

const checks = [
  ['static first stage cohort', dashboard.funnel[0].count === 2],
  ['rollback caps deal 2 at qualified', dashboard.funnel[1].count === 2 && dashboard.funnel[6].count === 1],
  ['contract amount uses signed contract and excludes USD', dashboard.kpis.contractSigned.value === 190000],
  ['work revenue includes meeting done and requisites current stages', dashboard.kpis.workRevenue.value === 130000 && dashboard.kpis.potential.value === 130000],
  ['contract average check uses signed contracts', dashboard.kpis.averageCheck.value === 95000],
  ['contract conversion cohort', dashboard.kpis.contractConversion.value === 50],
  ['deal cycle counts only deals that reached the start stage', dashboard.kpis.dealCycle.value === 2 && dashboard.kpis.dealCycle.count === 1],
  ['dynamic first stage stays equal to static cohort', dynamicAllManagers.funnel[0].count === dashboard.funnel[0].count],
  ['dynamic does not backfill stages before movement start', dynamicDashboard.funnel[0].count === 0 && dynamicDashboard.funnel[1].count === 1],
  ['dynamic fills skipped stages only inside movement range', dynamicDashboard.funnel[2].count === 1 && dynamicDashboard.funnel[3].count === 1],
  ['quarter defaults include trend buckets', quarterDashboard.trends.revenue.length > 0 && quarterDashboard.trends.preparation.length > 0],
  ['quarter sales plan sums manager plans', quarterDashboard.salesPlan.plan === 300000],
  ['source payment share has percentages', quarterDashboard.sourcePaymentShare.every((row) => typeof row.percent === 'number')],
  ['sources trend has labels and id-keyed series', Array.isArray(quarterDashboard.sourcesTrend?.labels) && (quarterDashboard.sourcesTrend?.series || []).every((s) => 'id' in s && Array.isArray(s.values))]
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length) {
  console.error(JSON.stringify({ failed, dashboard }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  kpis: dashboard.kpis,
  funnel: dashboard.funnel.map((stage) => ({ name: stage.name, count: stage.count, conversion: stage.conversion }))
}, null, 2));
