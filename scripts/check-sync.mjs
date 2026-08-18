/**
 * Проверки службы синхронизации (`src/sync/service.js`).
 *
 * Три обязательства перед пользователем (спека, «Синхронизация и состояние системы»):
 * одновременно не более одной синхронизации; новый снимок заменяет прежний только
 * после полного успеха; сбой не уничтожает последний успешный снимок. Проверяется
 * на поддельном хранилище и поддельных источниках — без файловой системы и сети.
 */

import assert from 'node:assert';
import { createSyncService, isDegradedSync } from '../src/sync/service.js';
import { createSource } from '../src/sync/source.js';

/** Хранилище в памяти той же формы, что `JsonStore`: load/save/getSnapshot/updateSync. */
function fakeStore(initial = {}) {
  let cache = {
    companies: [], deals: [], companyStageEvents: [], dealStageEvents: [], assigneeEvents: [],
    managers: [], sources: [], kevFormats: [], updatedAt: null,
    sync: { status: 'idle', lastStartedAt: null, lastSuccessAt: null, lastError: null, warnings: [] },
    ...initial
  };
  const history = [];
  return {
    async getSnapshot() { return cache; },
    async save(data) { cache = { ...cache, ...data, updatedAt: 'saved' }; history.push({ type: 'save', data: cache }); return cache; },
    async updateSync(patch) { cache = { ...cache, sync: { ...cache.sync, ...patch } }; history.push({ type: 'sync', patch }); return cache; },
    _history: history,
    _cache: () => cache
  };
}

/** Источник, отдающий заранее заданный снимок или бросающий ошибку. Считает вызовы. */
function fakeSource({ name = 'fake', result, error, delayMs = 0 } = {}) {
  let calls = 0;
  return {
    name,
    ready: true,
    blockedBy: null,
    async fetchSnapshot(options) {
      calls += 1;
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (error) throw error;
      return typeof result === 'function' ? result(options) : result;
    },
    calls: () => calls
  };
}

function validSnapshot(overrides = {}) {
  return {
    companies: [{ id: 'c1' }], deals: [{ id: 'd1' }],
    companyStageEvents: [], dealStageEvents: [], assigneeEvents: [],
    managers: [], sources: [], kevFormats: [], portalTimezone: 'Europe/Moscow',
    warnings: [],
    ...overrides
  };
}

let failed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error.message);
  }
};

// ── Единственность запуска ───────────────────────────────────────────────────

await check('два одновременных запроса дают одну синхронизацию, а не две', async () => {
  const store = fakeStore();
  const source = fakeSource({ result: validSnapshot(), delayMs: 20 });
  const service = createSyncService({ store, source });

  const a = service.run();
  const b = service.run();
  assert.strictEqual(a.started, true, 'первый запрос обязан запустить синхронизацию');
  assert.strictEqual(b.started, false, 'второй запрос не должен запускать вторую синхронизацию');
  assert.strictEqual(b.joined, true, 'второй запрос обязан присоединиться к идущей');
  await Promise.all([a.promise, b.promise]);
  assert.strictEqual(source.calls(), 1, `источник вызван ${source.calls()} раз вместо одного`);
});

await check('после завершения синхронизации новый запуск запускает новую', async () => {
  const store = fakeStore();
  const source = fakeSource({ result: validSnapshot() });
  const service = createSyncService({ store, source });

  await service.run().promise;
  const second = service.run();
  assert.strictEqual(second.started, true, 'запуск после завершения предыдущего обязан начать новую синхронизацию');
  await second.promise;
  assert.strictEqual(source.calls(), 2);
});

await check('isRunning отражает фактическое состояние во время и после запуска', async () => {
  const store = fakeStore();
  const source = fakeSource({ result: validSnapshot(), delayMs: 15 });
  const service = createSyncService({ store, source });
  const handle = service.run();
  assert.strictEqual(service.isRunning(), true);
  await handle.promise;
  assert.strictEqual(service.isRunning(), false);
});

// ── Успех и сохранение ────────────────────────────────────────────────────────

await check('успешная синхронизация сохраняет снимок и ставит lastSuccessAt', async () => {
  const store = fakeStore();
  const source = fakeSource({ result: validSnapshot() });
  const service = createSyncService({ store, source, now: () => new Date('2026-08-15T12:00:00.000Z') });

  await service.run().promise;
  const status = await service.getStatus();
  assert.strictEqual(status.lastSuccessAt, '2026-08-15T12:00:00.000Z');
  assert.strictEqual(status.counts.companies, 1);
  assert.strictEqual(status.lastError, null);
});

await check('снимок помечается источником, который его предоставил', async () => {
  const store = fakeStore();
  const source = fakeSource({ name: 'bitrix', result: validSnapshot() });
  const service = createSyncService({ store, source });
  await service.run().promise;
  assert.strictEqual((await store.getSnapshot()).source, 'bitrix');
});

await check('дисклеймер демо-источника доходит до статуса синхронизации, а не теряется', async () => {
  // Настоящий демо-источник, не подделка: проверяем реальный контракт между
  // src/demo/generator.js и src/sync/service.js — верхнеуровневое fetched.warnings
  // обязано попасть в sync.warnings, а не потеряться в отброшенном sync.warnings
  // самого снимка (который service.js полностью заменяет на успехе).
  const store = fakeStore();
  const service = createSyncService({ store, source: createSource('demo') });
  await service.run().promise;
  const status = await service.getStatus();
  assert.ok(
    status.warnings.some((w) => w.code === 'DEMO_DATA'),
    'дисклеймер о демо-данных не долетел до /api/sync-status'
  );
});

await check('транзитное поле warnings не просачивается в персистентный снимок на диске', async () => {
  const store = fakeStore();
  const service = createSyncService({ store, source: createSource('demo') });
  await service.run().promise;
  const persisted = await store.getSnapshot();
  assert.strictEqual(
    'warnings' in persisted, false,
    'поле warnings — сигнал захода синхронизации, а не часть формы снимка (EMPTY_CACHE его не описывает)'
  );
});

// ── Ошибка не уничтожает успешный снимок ─────────────────────────────────────

await check('ошибка синхронизации НЕ затирает прежний успешный снимок', async () => {
  const store = fakeStore({
    companies: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
    sync: { status: 'idle', lastStartedAt: null, lastSuccessAt: '2026-08-01T00:00:00.000Z', lastError: null, warnings: [] }
  });
  const source = fakeSource({ error: new Error('портал недоступен') });
  const service = createSyncService({ store, source });

  await service.run().promise;
  const snapshot = await store.getSnapshot();
  assert.strictEqual(snapshot.companies.length, 3, 'компании из прежнего снимка пропали после неудачной синхронизации');
  const status = await service.getStatus();
  assert.strictEqual(status.lastError, 'портал недоступен');
  // Дата последней УСПЕШНОЙ синхронизации не должна сдвигаться на неудачной попытке.
  assert.strictEqual(status.lastSuccessAt, '2026-08-01T00:00:00.000Z');
});

await check('ошибка файловой системы не отдаёт наружу путь и имя пользователя', async () => {
  const store = fakeStore();
  const fsError = new Error(
    "ENOENT: no such file or directory, open 'C:\\Users\\someone\\Desktop\\dash\\data\\snapshot.json.tmp'"
  );
  fsError.code = 'ENOENT';
  const source = fakeSource({ error: fsError });
  const service = createSyncService({ store, source });

  await service.run().promise;
  const status = await service.getStatus();
  assert.ok(status.lastError, 'ошибка обязана быть видна в статусе');
  assert.ok(!status.lastError.includes('someone'), 'имя пользователя ОС утекло в публичный статус');
  assert.ok(!status.lastError.includes('C:\\'), 'абсолютный путь утёк в публичный статус');
  assert.ok(status.lastError.includes('ENOENT'), 'код ошибки должен остаться для диагностики');
});

await check('снимок, не прошедший проверку формы, не сохраняется', async () => {
  const store = fakeStore({ companies: [{ id: 'old' }] });
  const source = fakeSource({ result: { companies: 'не массив' } });
  const service = createSyncService({ store, source });
  await service.run().promise;
  const snapshot = await store.getSnapshot();
  assert.strictEqual(snapshot.companies.length, 1, 'битый снимок подменил прежний');
  assert.strictEqual((await service.getStatus()).lastError !== null, true);
});

// ── Деградация ────────────────────────────────────────────────────────────────

await check('isDegradedSync: пустой результат при живом снимке — деградация', () => {
  assert.strictEqual(isDegradedSync(500, 0, true), true);
});
await check('isDegradedSync: первое наполнение (prev=0) — не деградация', () => {
  assert.strictEqual(isDegradedSync(0, 500, true), false);
});
await check('isDegradedSync: просадка без предупреждений — реальное удаление, не деградация', () => {
  assert.strictEqual(isDegradedSync(500, 10, false), false);
});
await check('isDegradedSync: просадка с предупреждениями — деградация', () => {
  assert.strictEqual(isDegradedSync(500, 300, true), true);
});
await check('isDegradedSync: лёгкая просадка с предупреждениями в пределах нормы — не деградация', () => {
  assert.strictEqual(isDegradedSync(500, 490, true), false);
});
// Переключение demo → bitrix: демо-снимок и реальный портал несопоставимы по
// объёму, и первая настоящая синхронизация не должна отбраковываться из-за того,
// что генератор выдумал больше сущностей, чем есть у заказчика.
await check('isDegradedSync: смена источника снимает проверку деградации', () => {
  assert.strictEqual(isDegradedSync(900, 120, true, true), false);
  assert.strictEqual(isDegradedSync(900, 0, true, true), false);
  // Без смены источника та же просадка по-прежнему считается деградацией.
  assert.strictEqual(isDegradedSync(900, 120, true, false), true);
});

await check('деградировавшая синхронизация не заменяет снимок, но помечает ошибку', async () => {
  const store = fakeStore({
    companies: Array.from({ length: 500 }, (_, i) => ({ id: `c${i}` })),
    sync: { status: 'idle', lastStartedAt: null, lastSuccessAt: '2026-08-01T00:00:00.000Z', lastError: null, warnings: [] }
  });
  const source = fakeSource({
    result: validSnapshot({
      companies: [{ id: 'c1' }, { id: 'c2' }], // резкая просадка
      warnings: [{ code: 'WINDOW_FETCH_ERROR', message: 'окно не получено' }]
    })
  });
  const service = createSyncService({ store, source });
  const { result } = await service.runManual();
  assert.strictEqual(result.degraded, true);
  const snapshot = await store.getSnapshot();
  assert.strictEqual(snapshot.companies.length, 500, 'деградировавшая загрузка подменила здоровый снимок');
  const status = await service.getStatus();
  assert.strictEqual(status.lastSuccessAt, '2026-08-01T00:00:00.000Z', 'деградация не должна выглядеть как успех');
  assert.ok(status.lastError, 'деградация обязана оставить причину в статусе');
});

// ── Присоединение к текущей синхронизации получает её результат ─────────────

await check('присоединившийся запрос получает РЕЗУЛЬТАТ той же синхронизации, а не начинает свою', async () => {
  const store = fakeStore();
  let callCount = 0;
  const source = fakeSource({
    result: () => { callCount += 1; return validSnapshot({ companies: [{ id: `run-${callCount}` }] }); },
    delayMs: 20
  });
  const service = createSyncService({ store, source });

  const a = service.run();
  const b = service.run();
  const [resultA, resultB] = await Promise.all([a.promise, b.promise]);
  assert.strictEqual(resultA, resultB, 'присоединившийся запрос получил другой объект результата');
  assert.strictEqual(callCount, 1);
});

// ── Свежесть данных ───────────────────────────────────────────────────────────

await check('снимок без единой успешной синхронизации, но с данными — считается устаревшим', async () => {
  const store = fakeStore({
    companies: [{ id: 'seed' }],
    sync: { status: 'idle', lastStartedAt: null, lastSuccessAt: null, lastError: null, warnings: [] }
  });
  const service = createSyncService({ store, source: fakeSource({ result: validSnapshot() }) });
  const status = await service.getStatus();
  assert.strictEqual(status.stale, true, 'данные без даты успешной синхронизации должны считаться устаревшими');
});

await check('снимок без единой синхронизации И без данных — не помечается как устаревший (это пустой старт)', async () => {
  const store = fakeStore({ companies: [] });
  const service = createSyncService({ store, source: fakeSource({ result: validSnapshot() }) });
  const status = await service.getStatus();
  assert.strictEqual(status.stale, false);
});

if (failed > 0) {
  console.error(`\n${failed} проверок службы синхронизации упало`);
  process.exit(1);
}
console.log('\nПроверки службы синхронизации пройдены');
