/**
 * Проверки интеграции с Битрикс24: клиент, нормализация, оркестрация синхронизации.
 *
 * Реального портала нет и не будет в этой сессии (см. reference/REQUIRED_INPUTS.md) —
 * поэтому каждая проверка идёт на замоканном `fetch` или замоканном клиенте.
 * Ни одна проверка не должна пытаться выйти в сеть: это остановило бы CI.
 */

import assert from 'node:assert';
import {
  BITRIX_ERROR_CODES,
  bitrixError,
  createBitrixClient,
  isRetryableError,
  isTimeoutError,
  redactApiKey,
  withRetry
} from '../src/bitrix/client.js';
import {
  isDealLost,
  normalizeAssigneeEvent,
  normalizeCompany,
  normalizeDeal,
  normalizeStageEvent,
  normalizeUser,
  pendingAuditFields,
  resolvePortalFields
} from '../src/bitrix/normalize.js';
import { fetchBitrixSnapshot } from '../src/bitrix/fullSync.js';

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

/** Ответ fetch-подобной формы: .ok, .status, .text(). */
function fakeResponse(status, body, { ok } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok: ok ?? (status >= 200 && status < 300), status, text: async () => text };
}

// ═══════════════════════════════ КЛИЕНТ ═══════════════════════════════════════

// ── Таймаут ──────────────────────────────────────────────────────────────────

await check('таймаут распознан и упакован отдельным кодом', async () => {
  const client = createBitrixClient({
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      // Таймер клиента намеренно unref()-нут (не держит процесс в проде — там
      // событийный цикл и так жив на реальном сокете fetch). В изолированном
      // тесте больше ничего не занято, и без собственного ref-держателя событие
      // abort никогда не успело бы случиться раньше завершения процесса.
      const keepAlive = setInterval(() => {}, 1000);
      // Настоящий fetch реагирует на abort исключением AbortError — воспроизводим это.
      signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  });
  await assert.rejects(
    () => client.request('company'),
    (error) => {
      assert.strictEqual(error.code, BITRIX_ERROR_CODES.timeout);
      assert.strictEqual(error.retryable, true);
      assert.ok(isTimeoutError(error));
      return true;
    }
  );
});

// ── Не-JSON ответ ────────────────────────────────────────────────────────────

await check('HTML-страница шлюза превращается во внятную ошибку, а не в SyntaxError', async () => {
  const client = createBitrixClient({
    apiKey: 'test-key',
    fetchImpl: async () => fakeResponse(504, '<html><body><h1>504 Gateway Timeout</h1><script>track()</script></body></html>')
  });
  await assert.rejects(
    () => client.request('company'),
    (error) => {
      assert.strictEqual(error.code, BITRIX_ERROR_CODES.badResponse);
      assert.ok(!(error instanceof SyntaxError), 'ошибка не должна быть сырым SyntaxError');
      assert.ok(error.message.includes('Gateway Timeout'), 'сообщение не показывает, что реально пришло');
      assert.ok(!error.message.includes('<script>'), 'теги скриптов не должны попасть в сообщение целиком');
      return true;
    }
  );
});

await check('пустой ответ (0 байт) не роняет клиент', async () => {
  const client = createBitrixClient({
    apiKey: 'test-key',
    fetchImpl: async () => fakeResponse(200, '')
  });
  const body = await client.request('company');
  assert.deepStrictEqual(body, {});
});

// ── Различение ретраибельных и бизнес-ошибок ─────────────────────────────────

await check('сетевая ошибка и 5xx — ретраибельны; 404 — нет', () => {
  assert.strictEqual(isRetryableError(bitrixError('сеть', { code: 'API_NETWORK', retryable: true })), true);
  assert.strictEqual(isRetryableError({ status: 503, message: 'Service Unavailable' }), true);
  assert.strictEqual(isRetryableError({ code: 'ECONNRESET' }), true);
  assert.strictEqual(isRetryableError(bitrixError('не найдено', { code: 'API_ERROR', status: 404, retryable: false })), false);
  assert.strictEqual(isRetryableError(bitrixError('нет ключа', { code: BITRIX_ERROR_CODES.noApiKey })), false, 'отсутствие ключа не лечится повтором');
});

await check('withRetry повторяет только ретраибельную ошибку и останавливается на бизнес-ошибке', async () => {
  let attempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      attempts += 1;
      throw bitrixError('сущность не найдена', { code: 'API_ERROR', status: 404, retryable: false });
    }, { attempts: 5, sleep: async () => {} }),
    /не найдена/
  );
  assert.strictEqual(attempts, 1, 'бизнес-ошибка не должна повторяться');

  attempts = 0;
  const result = await withRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw bitrixError('перегрузка', { code: 'API_NETWORK', status: 503, retryable: true });
    return 'готово';
  }, { attempts: 5, sleep: async () => {} });
  assert.strictEqual(result, 'готово');
  assert.strictEqual(attempts, 3, 'ретраибельная ошибка обязана повториться нужное число раз');
});

// ── Ключ ──────────────────────────────────────────────────────────────────────

await check('отсутствие ключа — ошибка ДО сетевого вызова', async () => {
  let fetchCalled = false;
  const client = createBitrixClient({ apiKey: '', fetchImpl: async () => { fetchCalled = true; return fakeResponse(200, {}); } });
  await assert.rejects(() => client.request('company'), (error) => {
    assert.strictEqual(error.code, BITRIX_ERROR_CODES.noApiKey);
    return true;
  });
  assert.strictEqual(fetchCalled, false, 'без ключа сетевой вызов не должен происходить вовсе');
});

await check('ключ вычищается из текста ошибки', () => {
  const redacted = redactApiKey('доступ по ключу SECRET-KEY-42 запрещён', 'SECRET-KEY-42');
  assert.ok(!redacted.includes('SECRET-KEY-42'));
  assert.ok(redacted.includes('***'));
});

await check('ключ не попадает в текст сетевой ошибки', async () => {
  const client = createBitrixClient({
    apiKey: 'MY-SECRET-KEY',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED MY-SECRET-KEY@host'); }
  });
  await assert.rejects(() => client.request('company'), (error) => {
    assert.ok(!error.message.includes('MY-SECRET-KEY'), 'ключ утёк в сообщение об ошибке');
    return true;
  });
});

// ── Постраничность ────────────────────────────────────────────────────────────

await check('постраничный обход идёт по курсору до конца, не обрезая выборку', async () => {
  const pages = [
    { data: [{ id: '1' }, { id: '2' }], nextCursor: 'p2' },
    { data: [{ id: '3' }, { id: '4' }], nextCursor: 'p3' },
    { data: [{ id: '5' }] } // без курсора — конец
  ];
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 2,
    fetchImpl: async () => fakeResponse(200, { success: true, ...pages[Math.min(call++, pages.length - 1)] })
  });
  const { rows, truncated } = await client.listAll('company');
  assert.strictEqual(rows.length, 5, `получено ${rows.length} записей вместо 5 — постраничность обрезала выборку`);
  assert.strictEqual(truncated, false);
});

await check('обход по смещению работает, когда портал не отдаёт курсор', async () => {
  const pages = [
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })) },
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(3 + i) })) },
    { data: [{ id: '6' }] } // неполная страница — конец
  ];
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 3,
    fetchImpl: async () => fakeResponse(200, { success: true, ...pages[call++] })
  });
  const { rows } = await client.listAll('deal');
  assert.strictEqual(rows.length, 7);
});

await check('предохранитель постраничности не уходит в бесконечный цикл и честно помечает выборку неполной', async () => {
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 2,
    maxPages: 3,
    // Курсор меняется на каждой странице: реальный бесконечный поток, а не залипший
    // курсор — иначе первой сработает другая защита (повтор курсора = конец выборки),
    // а не предохранитель числа страниц, который здесь и проверяется.
    fetchImpl: async () => fakeResponse(200, {
      success: true,
      data: [{ id: `a-${call}` }, { id: `b-${call}` }],
      nextCursor: `page-${call++}`
    })
  });
  const { rows, pages, truncated } = await client.listAll('company');
  assert.strictEqual(pages, 3, 'предохранитель не сработал на заданном числе страниц');
  assert.strictEqual(truncated, true, 'бесконечная выборка обязана быть помечена неполной, а не тихо оборвана');
  assert.strictEqual(rows.length, 6);
});

await check('повторившийся курсор распознаётся как конец выборки, а не как зацикливание', async () => {
  const pages = [
    { data: [{ id: '1' }], nextCursor: 'same' },
    { data: [{ id: '2' }], nextCursor: 'same' } // курсор не изменился — портал сигналит «дальше нечего»
  ];
  let call = 0;
  const client = createBitrixClient({ apiKey: 'k', maxPages: 50, fetchImpl: async () => fakeResponse(200, { success: true, ...pages[Math.min(call++, 1)] }) });
  const { rows, truncated } = await client.listAll('company');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(truncated, false, 'повтор курсора не должен помечаться как обрезанная выборка');
});

await check('дубли по ID между перекрывшимися страницами не считаются дважды', async () => {
  const pages = [
    { data: [{ id: '1' }, { id: '2' }], nextCursor: 'p2' },
    { data: [{ id: '2' }, { id: '3' }] } // '2' повторился
  ];
  let call = 0;
  const client = createBitrixClient({ apiKey: 'k', fetchImpl: async () => fakeResponse(200, { success: true, ...pages[call++] }) });
  const { rows } = await client.listAll('company');
  assert.strictEqual(rows.length, 3);
});

// ═══════════════════════════════ НОРМАЛИЗАЦИЯ ══════════════════════════════════

await check('normalizeCompany устойчива к разным регистрам имён полей', () => {
  const camel = normalizeCompany({ id: '1', title: 'ООО Ромашка', stageId: 'C:NEW', assignedById: '10' });
  const upper = normalizeCompany({ ID: '1', TITLE: 'ООО Ромашка', STAGE_ID: 'C:NEW', ASSIGNED_BY_ID: '10' });
  assert.strictEqual(camel.title, upper.title);
  assert.strictEqual(camel.assignedById, upper.assignedById);
});

await check('normalizeCompany и normalizeDeal корректно обрабатывают отсутствующие поля', () => {
  const company = normalizeCompany({ id: '42' });
  assert.strictEqual(company.id, '42');
  assert.strictEqual(company.sourceId, null, 'пустой источник должен стать null, а не пустой строкой или исключением');
  assert.strictEqual(company.assignedById, null);
  assert.ok(company.title.includes('42'), 'без названия должна остаться осмысленная заглушка с ID');

  const deal = normalizeDeal({ id: '99' });
  assert.strictEqual(deal.companyId, null, 'сделка без компании не должна выдумывать связь');
  assert.strictEqual(deal.kevFormatId, null);
});

await check('normalizeCompany и normalizeDeal без id дают null, а не запись-призрак', () => {
  assert.strictEqual(normalizeCompany({ title: 'без ID' }), null);
  assert.strictEqual(normalizeDeal({ title: 'без ID' }), null);
});

await check('isDealLost распознаёт явный флаг, семантику стадии и список стадий отказа', () => {
  assert.strictEqual(isDealLost({ isLost: true }, 'ANY_STAGE'), true, 'явный флаг не сработал');
  assert.strictEqual(isDealLost({ stageSemantics: 'F' }, 'ANY_STAGE'), true, 'семантика провала не распознана');
  assert.strictEqual(isDealLost({}, '3DB_D:LOSE'), true, 'известная стадия отказа не распознана');
  assert.strictEqual(isDealLost({}, '3DB_D:ADVANCE_RECEIVED'), false, 'обычный этап ошибочно посчитан отказом');
});

await check('normalizeStageEvent отбрасывает событие без сущности, стадии или даты', () => {
  assert.strictEqual(normalizeStageEvent({ stageId: 'X', at: '2026-01-01' }, { entityType: 'deal', entityId: null }), null, 'событие без ID сущности принято');
  assert.strictEqual(normalizeStageEvent({ dealId: '1', at: '2026-01-01' }, { entityType: 'deal' }), null, 'событие без стадии принято');
  assert.strictEqual(normalizeStageEvent({ dealId: '1', stageId: 'X' }, { entityType: 'deal' }), null, 'событие без даты принято');
  const ok = normalizeStageEvent({ dealId: '1', stageId: 'X', at: '2026-01-01T00:00:00Z' }, { entityType: 'deal' });
  assert.deepStrictEqual(ok, { dealId: '1', stageId: 'X', at: '2026-01-01T00:00:00.000Z' });
});

await check('normalizeAssigneeEvent даёт запись с типом сущности, менеджером и датой', () => {
  const event = normalizeAssigneeEvent({ entityId: '7', managerId: '3', at: '2026-02-01T00:00:00Z' }, { entityType: 'company' });
  assert.deepStrictEqual(event, { entityType: 'company', entityId: '7', managerId: '3', at: '2026-02-01T00:00:00.000Z' });
});

await check('normalizeUser собирает имя из того, что реально есть', () => {
  assert.strictEqual(normalizeUser({ id: '1', firstName: 'Ирина', lastName: 'Соколова' }).name, 'Соколова Ирина');
  assert.strictEqual(normalizeUser({ id: '2' }).name, 'Сотрудник 2', 'без единого имени должна остаться понятная заглушка');
});

await check('resolvePortalFields превращает заглушки и пустые значения в null', () => {
  const fields = resolvePortalFields({ companySourceField: '', dealSourceField: 'UF_CRM_123' });
  assert.strictEqual(fields.companySourceField, null);
  assert.strictEqual(fields.dealSourceField, 'UF_CRM_123');
  assert.strictEqual(fields.dealCompanyLinkField, null, 'незаменённая заглушка обязана стать null');
});

await check('pendingAuditFields пуст только когда ВСЕ поля подтверждены', () => {
  assert.ok(pendingAuditFields({}).length > 0, 'без переопределений список ожидающих аудита не может быть пустым');
  const allConfirmed = {
    companySourceField: 'UF_1', dealSourceField: 'UF_2', dealKevFormatField: 'UF_3',
    dealCompanyLinkField: 'UF_4', companyStageField: 'UF_5', dealStageField: 'UF_6', dealCategoryId: '12'
  };
  assert.strictEqual(pendingAuditFields(allConfirmed).length, 0);
});

// ═══════════════════════════════ ОРКЕСТРАЦИЯ (fullSync) ═══════════════════════

/** Клиент-подделка для fetchBitrixSnapshot: без сети, ответы заданы явно. */
function fakeClient({
  companies = [], deals = [], users = [],
  companyFields = { fields: {} }, dealFields = { fields: {} },
  historyByOwner = {}, failHistoryOwners = new Set(), failAssigneeHistory = false,
  failSearch = null
} = {}) {
  return {
    ready: true,
    async searchAll(entity) {
      if (failSearch === entity) throw new Error(`выборка ${entity} недоступна`);
      if (entity === 'company') return { rows: companies, truncated: false };
      if (entity === 'deal') return { rows: deals, truncated: false };
      return { rows: [], truncated: false };
    },
    async listAll(entity, params = {}) {
      if (entity === 'user') return { rows: users };
      if (entity === 'stage-history') {
        if (failHistoryOwners.has(params.ownerId)) throw new Error(`история недоступна для ${params.ownerId}`);
        return { rows: historyByOwner[params.ownerId] || [] };
      }
      if (entity === 'assignee-history') {
        if (failAssigneeHistory) throw new Error('маршрут истории ответственных не существует на портале');
        return { rows: [] };
      }
      return { rows: [] };
    },
    async fetchOne(entity) {
      if (entity === 'company/fields') return companyFields;
      if (entity === 'deal/fields') return dealFields;
      return {};
    }
  };
}

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PORTAL_FIELDS_CONFIGURED = {
  companySourceField: 'UF_SRC_C', dealSourceField: 'UF_SRC_D', dealKevFormatField: 'UF_KEV',
  dealCompanyLinkField: 'UF_LINK', companyStageField: 'UF_C_STAGE', dealStageField: 'UF_D_STAGE',
  dealCategoryId: '12'
};

await check('отсутствие ключа останавливает синхронизацию до первого сетевого вызова', async () => {
  await assert.rejects(
    () => fetchBitrixSnapshot({ client: { ready: false } }),
    (error) => { assert.strictEqual(error.code, 'NO_API_KEY'); return true; }
  );
});

await check('сбой окна выборки компаний даёт предупреждение, а не падение всей синхронизации', async () => {
  const client = fakeClient({ failSearch: 'company', deals: [{ id: 'd1', UF_LINK: 'c1', UF_D_STAGE: 'X' }] });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: PORTAL_FIELDS_CONFIGURED });
  assert.strictEqual(Array.isArray(snapshot.companies), true, 'снимок обязан остаться валидным даже при сбое компаний');
  assert.strictEqual(snapshot.companies.length, 0);
  assert.ok(snapshot.warnings.some((w) => w.code === 'WINDOW_FETCH_ERROR'), 'сбой окна не отражён предупреждением');
});

await check('неподтверждённая категория сделок не блокирует компании, но помечает сделки предупреждением', async () => {
  const client = fakeClient({ companies: [{ id: 'c1', UF_SRC_C: 's1', UF_C_STAGE: 'ANY' }] });
  // Поля НЕ переданы — используются заглушки по умолчанию из normalize.js.
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.strictEqual(snapshot.companies.length, 1, 'компании не должны страдать из-за неподтверждённой категории сделок');
  assert.strictEqual(snapshot.deals.length, 0);
  assert.ok(snapshot.warnings.some((w) => w.code === 'DEAL_CATEGORY_PENDING'));
});

await check('недоступная история ответственных не роняет синхронизацию', async () => {
  const client = fakeClient({
    companies: [{ id: 'c1', UF_SRC_C: 's1', UF_C_STAGE: 'ANY' }],
    failAssigneeHistory: true
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: PORTAL_FIELDS_CONFIGURED });
  assert.strictEqual(snapshot.companies.length, 1, 'недоступность истории ответственных не должна стереть компании');
  assert.deepStrictEqual(snapshot.assigneeEvents, []);
  assert.strictEqual(snapshot.dataQuality.assigneeHistoryAvailable, false);
  assert.ok(snapshot.warnings.some((w) => w.code === 'ASSIGNEE_HISTORY_UNAVAILABLE'));
});

await check('слияние истории: сущность с неудавшимся перезапросом сохраняет ПРЕЖНИЕ события', async () => {
  const client = fakeClient({
    companies: [
      { id: 'c1', UF_SRC_C: 's1', UF_C_STAGE: 'STAGE_2' },
      { id: 'c2', UF_SRC_C: 's1', UF_C_STAGE: 'STAGE_2' }
    ],
    historyByOwner: {
      c1: [{ id: 'e1', STAGE_ID: 'STAGE_1', CREATED_AT: '2026-01-01T00:00:00Z' }]
      // у c2 перезапрос истории упадёт — своих новых событий не отдаст
    },
    failHistoryOwners: new Set(['c2'])
  });

  const previousSnapshot = {
    companyStageEvents: [
      { companyId: 'c1', stageId: 'OLD_STAGE_FOR_C1', at: '2025-01-01T00:00:00.000Z' }, // должно быть заменено
      { companyId: 'c2', stageId: 'STAGE_1', at: '2025-06-01T00:00:00.000Z' } // должно СОХРАНИТЬСЯ
    ]
  };

  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: PORTAL_FIELDS_CONFIGURED, previousSnapshot });

  const c1Events = snapshot.companyStageEvents.filter((e) => e.companyId === 'c1');
  const c2Events = snapshot.companyStageEvents.filter((e) => e.companyId === 'c2');

  assert.strictEqual(c1Events.length, 1);
  assert.strictEqual(c1Events[0].stageId, 'STAGE_1', 'у сущности с УСПЕШНЫМ перезапросом должны остаться НОВЫЕ события, а не старые');
  assert.strictEqual(c2Events.length, 1);
  assert.strictEqual(c2Events[0].stageId, 'STAGE_1', 'у сущности с НЕУДАВШИМСЯ перезапросом прежние события должны сохраниться');
  assert.ok(
    snapshot.warnings.some((w) => w.code === 'COMPANY_STAGE_HISTORY_PARTIAL'),
    'частичный сбой истории компаний не отражён предупреждением'
  );
});

await check('без previousSnapshot неудавшийся перезапрос просто даёт пустую историю, а не падение', async () => {
  const client = fakeClient({
    companies: [{ id: 'c1', UF_SRC_C: 's1', UF_C_STAGE: 'ANY' }],
    failHistoryOwners: new Set(['c1'])
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: PORTAL_FIELDS_CONFIGURED });
  assert.deepStrictEqual(snapshot.companyStageEvents, []);
  assert.strictEqual(snapshot.companies.length, 1, 'сбой истории не должен стереть саму компанию');
});

await check('полный happy path даёт валидный снимок со всеми разделами формы', async () => {
  const client = fakeClient({
    companies: [{ id: 'c1', TITLE: 'ООО Ромашка', UF_SRC_C: 's1', UF_C_STAGE: 'STAGE_1', ASSIGNED_BY_ID: 'm1' }],
    deals: [{ id: 'd1', TITLE: 'Сделка 1', UF_LINK: 'c1', UF_SRC_D: 's1', UF_KEV: 'k1', UF_D_STAGE: 'STAGE_D1' }],
    users: [{ id: 'm1', firstName: 'Ирина', lastName: 'Соколова' }],
    companyFields: { fields: { UF_SRC_C: { items: [{ ID: 's1', VALUE: 'Выставки' }] } } },
    dealFields: { fields: { UF_KEV: { items: [{ ID: 'k1', VALUE: 'Онлайн-встреча' }] } } }
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: PORTAL_FIELDS_CONFIGURED });

  for (const key of ['companies', 'deals', 'companyStageEvents', 'dealStageEvents', 'assigneeEvents', 'managers', 'sources', 'kevFormats']) {
    assert.ok(Array.isArray(snapshot[key]), `«${key}» должен быть массивом`);
  }
  assert.strictEqual(snapshot.companies[0].title, 'ООО Ромашка');
  assert.strictEqual(snapshot.deals[0].companyId, 'c1');
  assert.strictEqual(snapshot.managers[0].name, 'Соколова Ирина');
  assert.deepStrictEqual(snapshot.sources.find((s) => s.id === 's1'), { id: 's1', name: 'Выставки' });
  assert.strictEqual(snapshot.portalTimezone, 'Europe/Moscow');
});

if (failed > 0) {
  console.error(`\n${failed} проверок интеграции с Битрикс24 упало`);
  process.exit(1);
}
console.log('\nПроверки интеграции с Битрикс24 пройдены');
