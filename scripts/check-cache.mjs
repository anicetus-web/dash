/**
 * Проверки кэшей: индекса снимка и рассчитанных ответов.
 *
 * Кэш — самый опасный вид оптимизации: ошибка здесь не роняет приложение,
 * а тихо показывает пользователю чужие или устаревшие числа. Поэтому
 * проверяется не «быстро ли стало», а ровно два утверждения: (1) кэш
 * действительно переиспользуется там, где данные и параметры совпадают;
 * (2) он НИКОГДА не переиспользуется, если изменился снимок, параметры
 * или временное окно.
 */

import assert from 'node:assert';
import { buildIndex, buildIndexUncached } from '../src/analytics/snapshot.js';
import { cacheSizeFor, cachedDashboard } from '../src/api/responseCache.js';

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

function snapshot(overrides = {}) {
  return {
    version: 1,
    updatedAt: '2026-08-16T10:00:00.000Z',
    source: 'test',
    portalTimezone: 'Europe/Moscow',
    companies: [{ id: 'c1', title: 'Компания', sourceId: 's1', currentStageId: 'X', assignedById: 'm1', createdAt: '2026-01-01T00:00:00.000Z' }],
    deals: [],
    companyStageEvents: [],
    dealStageEvents: [],
    assigneeEvents: [],
    managers: [], sources: [], kevFormats: [],
    ...overrides
  };
}

// ── Кэш индекса ───────────────────────────────────────────────────────────────

check('индекс одного и того же снимка переиспользуется, а не строится заново', () => {
  const snap = snapshot();
  const first = buildIndex(snap);
  const second = buildIndex(snap);
  assert.strictEqual(first, second, 'для одного объекта снимка должен вернуться тот же индекс');
});

check('НОВЫЙ снимок никогда не получает индекс прежнего', () => {
  const older = snapshot();
  const newer = snapshot({ companies: [...snapshot().companies, { id: 'c2', title: 'Вторая', sourceId: 's1', currentStageId: 'X', assignedById: 'm1', createdAt: '2026-01-02T00:00:00.000Z' }] });
  const a = buildIndex(older);
  const b = buildIndex(newer);
  assert.notStrictEqual(a, b, 'разные снимки обязаны получить разные индексы');
  assert.strictEqual(a.counts.companies, 1);
  assert.strictEqual(b.counts.companies, 2, 'новый снимок посчитан по старым данным — это и есть тихая порча цифр');
});

check('кэшированный индекс совпадает с построенным напрямую', () => {
  const snap = snapshot();
  const cached = buildIndex(snap);
  const direct = buildIndexUncached(snap);
  assert.deepStrictEqual(cached.counts, direct.counts, 'кэш изменил содержимое индекса');
  assert.strictEqual(cached.source, direct.source);
  assert.strictEqual(cached.hasAssigneeHistory, direct.hasAssigneeHistory);
});

check('не-объект вместо снимка не роняет кэш индекса', () => {
  for (const bad of [null, undefined, 'строка', 42]) {
    const index = buildIndex(bad);
    assert.strictEqual(index.counts.companies, 0, `битый вход ${String(bad)} должен дать пустой индекс, а не исключение`);
  }
});

// ── Кэш ответов ───────────────────────────────────────────────────────────────

check('тот же срез того же снимка считается ОДИН раз', () => {
  const snap = snapshot();
  const request = { mode: 'static', periodType: 'quarter' };
  let calls = 0;
  const compute = () => { calls += 1; return { value: calls }; };
  const now = 1_000_000;

  const first = cachedDashboard(snap, request, compute, now);
  const second = cachedDashboard(snap, request, compute, now);
  assert.strictEqual(calls, 1, 'повторный одинаковый запрос не должен пересчитываться');
  assert.strictEqual(first, second, 'должен вернуться тот же результат');
});

check('РАЗНЫЕ параметры среза считаются раздельно', () => {
  const snap = snapshot();
  let calls = 0;
  const compute = () => { calls += 1; return { value: calls }; };
  const now = 1_000_000;

  cachedDashboard(snap, { mode: 'static', periodType: 'quarter' }, compute, now);
  cachedDashboard(snap, { mode: 'dynamic', periodType: 'quarter' }, compute, now);
  cachedDashboard(snap, { mode: 'static', periodType: 'year' }, compute, now);
  cachedDashboard(snap, { mode: 'static', periodType: 'quarter', managerIds: 'm1' }, compute, now);
  assert.strictEqual(calls, 4, 'разные срезы обязаны считаться каждый сам по себе');
});

check('КАЖДЫЙ параметр среза влияет на ключ — ни один не потерян', () => {
  const snap = snapshot();
  const base = { mode: 'static', periodType: 'quarter' };
  const variants = [
    { ...base, periodValue: '2026-Q1' },
    { ...base, from: '2026-01-01' },
    { ...base, to: '2026-03-31' },
    { ...base, sourceIds: 's1' },
    { ...base, managerIds: 'm1' },
    { ...base, kevFormats: 'online' },
    { ...base, conversionFrom: 'takenToWork' },
    { ...base, conversionTo: 'qualified' }
  ];
  let calls = 0;
  const compute = () => { calls += 1; return { value: calls }; };
  const now = 2_000_000;

  cachedDashboard(snap, base, compute, now);
  for (const variant of variants) cachedDashboard(snap, variant, compute, now);
  assert.strictEqual(
    calls, variants.length + 1,
    'какой-то параметр не попал в ключ кэша — пользователь получил бы чужой срез'
  );
});

check('НОВЫЙ снимок не отдаёт ответ, посчитанный по прежнему', () => {
  const older = snapshot();
  const newer = snapshot({ updatedAt: '2026-08-16T11:00:00.000Z' });
  const request = { mode: 'static', periodType: 'quarter' };
  const now = 3_000_000;

  const fromOld = cachedDashboard(older, request, () => ({ tag: 'старый' }), now);
  const fromNew = cachedDashboard(newer, request, () => ({ tag: 'новый' }), now);
  assert.strictEqual(fromOld.tag, 'старый');
  assert.strictEqual(fromNew.tag, 'новый', 'после синхронизации отдан ответ по прежнему снимку');
});

check('смена временного окна пересчитывает срез: границы периода не застывают', () => {
  const snap = snapshot();
  const request = { mode: 'static', periodType: 'quarter' };
  let calls = 0;
  const compute = () => { calls += 1; return { value: calls }; };
  // Момент выровнен по границе окна (кратен шагу округления) — иначе «+5 секунд»
  // могло бы случайно перевалить в следующее окно и проверка ловила бы не то.
  const windowStart = 15_000 * 100;

  cachedDashboard(snap, request, compute, windowStart);
  cachedDashboard(snap, request, compute, windowStart + 5_000);   // то же окно
  assert.strictEqual(calls, 1, 'внутри одного окна пересчёта быть не должно');

  cachedDashboard(snap, request, compute, windowStart + 60_000);  // заведомо следующее окно
  assert.strictEqual(calls, 2, 'при смене окна незакрытый период обязан пересчитаться');
});

check('кэш не растёт без предела: старые окна вычищаются', () => {
  const snap = snapshot();
  const compute = () => ({ ok: true });
  for (let i = 0; i < 50; i += 1) {
    // Каждый раз новое временное окно И новый срез — худший случай для роста.
    cachedDashboard(snap, { mode: 'static', periodValue: `v${i}` }, compute, 5_000_000 + i * 60_000);
  }
  const size = cacheSizeFor(snap);
  assert.ok(size <= 5, `записи прошлых окон не вычищены: в кэше ${size} записей`);
});

check('предел числа записей на снимок соблюдается', () => {
  const snap = snapshot();
  const compute = () => ({ ok: true });
  const now = 9_000_000;
  // Одно временное окно, много разных фильтров — вытеснение по предельному размеру.
  for (let i = 0; i < 400; i += 1) {
    cachedDashboard(snap, { mode: 'static', managerIds: `m${i}` }, compute, now);
  }
  const size = cacheSizeFor(snap);
  assert.ok(size <= 240, `кэш вырос выше предела: ${size} записей`);
});

check('битый снимок не кэшируется и не роняет вызов', () => {
  let calls = 0;
  const compute = () => { calls += 1; return { ok: true }; };
  cachedDashboard(null, { mode: 'static' }, compute, 1000);
  cachedDashboard(null, { mode: 'static' }, compute, 1000);
  assert.strictEqual(calls, 2, 'без снимка кэшировать нечем — обязан считаться каждый раз');
});

console.log(failed === 0 ? '\nПроверки кэшей пройдены' : `\n${failed} проверок кэшей упало`);
process.exit(failed === 0 ? 0 : 1);
