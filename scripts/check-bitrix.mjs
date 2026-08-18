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
  KEV_FORMAT_FIELD_KEY,
  PORTAL_FIELDS,
  companyCardId,
  findFieldDescription,
  isDealLost,
  normalizeAssigneeEvent,
  normalizeCompany,
  normalizeDeal,
  normalizeUser,
  pendingAuditFields,
  resolvePortalFields,
  stageHistoryEvent
} from '../src/bitrix/normalize.js';
import {
  BITRIX_ENTITIES,
  CALL_ROUTE_CANDIDATES,
  createLimiter,
  fetchBitrixSnapshot,
  indexCompaniesByCard,
  keepPreviousEventsForMissingOwners,
  linkDealsToCompanies,
  restoreMissingFromPrevious
} from '../src/bitrix/fullSync.js';
import { DEAL_CATEGORY_IDS, LOST_STAGE_IDS, STAGE_TECHNICAL_IDS } from '../src/domain/funnels.js';

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
    () => client.request('deals'),
    (error) => {
      assert.strictEqual(error.code, BITRIX_ERROR_CODES.timeout);
      assert.strictEqual(error.retryable, true);
      assert.ok(isTimeoutError(error));
      return true;
    }
  );
});

await check('таймаут во время чтения тела ответа тоже распознаётся как таймаут, а не как сетевая ошибка', async () => {
  const client = createBitrixClient({
    apiKey: 'test-key',
    timeoutMs: 20,
    // fetch() успевает разрешиться заголовками (ok/status), но .text() ещё
    // стримит тело — таймаут срабатывает уже ПОСЛЕ первого catch-блока.
    fetchImpl: (url, { signal }) => Promise.resolve({
      ok: true,
      status: 200,
      text: () => new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })
    })
  });
  await assert.rejects(
    () => client.request('deals'),
    (error) => {
      assert.strictEqual(error.code, BITRIX_ERROR_CODES.timeout, 'обрыв тела при таймауте должен классифицироваться как таймаут, не как сетевая ошибка');
      assert.strictEqual(error.retryable, true);
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
    () => client.request('deals'),
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
  const body = await client.request('deals');
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
  await assert.rejects(() => client.request('deals'), (error) => {
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

await check('короткий ключ тоже вычищается — длина не освобождает от редактирования', () => {
  const redacted = redactApiKey('доступ по ключу abc запрещён', 'abc');
  assert.ok(!redacted.includes('abc'), 'короткий ключ утёк из-за прежнего исключения для length<4');
  assert.ok(redacted.includes('***'));
});

await check('ключ не попадает в текст сетевой ошибки', async () => {
  const client = createBitrixClient({
    apiKey: 'MY-SECRET-KEY',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED MY-SECRET-KEY@host'); }
  });
  await assert.rejects(() => client.request('deals'), (error) => {
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
  const { rows, truncated } = await client.listAll('deals');
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
  const { rows } = await client.listAll('deals');
  assert.strictEqual(rows.length, 7);
});

await check('короткая страница В СЕРЕДИНЕ выборки не обрывает обход, пока портал сообщает больший total', async () => {
  // Так вела себя история стадий на бою: портал отдавал меньше запрошенного
  // (своё ограничение по времени ответа), обход считал это концом данных, и
  // воронка молча строилась на 13% журнала — без единого предупреждения.
  const pages = [
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })), total: 8 },
    { data: [{ id: '3' }], total: 8 },        // короткая страница в середине
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(4 + i) })), total: 8 },
    { data: [{ id: '7' }], total: 8 }
  ];
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 3,
    fetchImpl: async () => fakeResponse(200, { success: true, ...pages[Math.min(call++, pages.length - 1)] })
  });
  const { rows, truncated, total } = await client.listAll('stage-history');
  assert.strictEqual(rows.length, 8, `получено ${rows.length} записей вместо 8 — короткая страница снова оборвала выборку`);
  assert.strictEqual(truncated, false);
  assert.strictEqual(total, 8, 'общее число записей портала обязано возвращаться наружу — по нему видно недобор');
});

await check('короткая страница не считается концом данных и когда total портал не сообщает', async () => {
  // Именно этот случай был на бою: /stage-history общего числа записей не отдаёт,
  // а короткие страницы выдаёт в середине журнала. Конец выборки — только пустая
  // страница, поэтому за короткой обязан идти ещё один запрос.
  const pages = [
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(i) })) },
    { data: [{ id: '3' }] },                       // короткая — но не конец
    { data: Array.from({ length: 3 }, (_, i) => ({ id: String(4 + i) })) },
    { data: [] }                                   // пусто — вот это конец
  ];
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 3,
    fetchImpl: async () => fakeResponse(200, { success: true, ...pages[Math.min(call++, pages.length - 1)] })
  });
  const { rows, truncated } = await client.listAll('stage-history');
  assert.strictEqual(rows.length, 7, `получено ${rows.length} записей вместо 7 — короткая страница снова оборвала обход`);
  assert.strictEqual(truncated, false);
});

await check('страница целиком из уже виденных записей завершает обход, а не доводит его до предохранителя', async () => {
  // Портал может повторять последнюю порцию вместо пустой страницы. Без выхода
  // по «нет новых записей» полная выборка была бы объявлена обрезанной.
  let call = 0;
  const client = createBitrixClient({
    apiKey: 'k',
    pageSize: 2,
    maxPages: 10,
    fetchImpl: async () => {
      call += 1;
      const first = [{ id: '1' }, { id: '2' }];
      return fakeResponse(200, { success: true, data: call === 1 ? first : first, total: 99 });
    }
  });
  const { rows, pages: seen, truncated } = await client.listAll('stage-history');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(seen, 2, 'обход обязан остановиться на первой странице без новых записей');
  assert.strictEqual(truncated, false, 'исчерпанная выборка не должна помечаться неполной');
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
  const { rows, pages, truncated } = await client.listAll('deals');
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
  const { rows, truncated } = await client.listAll('deals');
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
  const { rows } = await client.listAll('deals');
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
  assert.strictEqual(isDealLost({}, LOST_STAGE_IDS.deals[0]), true, 'известная стадия отказа не распознана');
  assert.strictEqual(isDealLost({}, '3DB_D:ADVANCE_RECEIVED'), false, 'обычный этап ошибочно посчитан отказом');
});

await check('normalizeAssigneeEvent даёт запись с типом сущности, менеджером и датой', () => {
  const event = normalizeAssigneeEvent({ entityId: '7', managerId: '3', at: '2026-02-01T00:00:00Z' }, { entityType: 'company' });
  assert.deepStrictEqual(event, { entityType: 'company', entityId: '7', managerId: '3', at: '2026-02-01T00:00:00.000Z' });
});

await check('normalizeAssigneeEvent для сделки не путает её с ID компании-владельца', () => {
  // Строка сделки может нести и её companyId (владение), и dealId одновременно —
  // без явного скоупа по entityType событие сделки рискует привязаться к ID компании.
  const raw = { companyId: 'c1', dealId: 'd1', managerId: 'm1', at: '2026-02-01T00:00:00Z' };
  const event = normalizeAssigneeEvent(raw, { entityType: 'deal' });
  assert.strictEqual(event.entityId, 'd1', 'событие сделки привязалось к companyId вместо dealId');
});

await check('normalizeUser собирает имя из того, что реально есть', () => {
  assert.strictEqual(normalizeUser({ id: '1', firstName: 'Ирина', lastName: 'Соколова' }).name, 'Соколова Ирина');
  assert.strictEqual(normalizeUser({ id: '2' }).name, 'Сотрудник 2', 'без единого имени должна остаться понятная заглушка');
});


await check('resolvePortalFields превращает заглушки и пустые значения в null', () => {
  const fields = resolvePortalFields({ companySourceField: '', dealSourceField: 'UF_CRM_123' });
  assert.strictEqual(fields.companySourceField, null);
  assert.strictEqual(fields.dealSourceField, 'UF_CRM_123');
  assert.strictEqual(fields.dealKevFormatField, null, 'незаменённая заглушка обязана стать null');
});

await check('после аудита портала не подтверждено ровно одно поле — формат КЭВ', () => {
  // Раньше проверка требовала «список не пуст», потому что заглушками были ВСЕ поля.
  // Теперь поля реальны, кроме одного: списка со значениями формата КЭВ среди 88
  // пользовательских полей сделки на портале нет (reference/PORTAL-AUDIT.md).
  // Отсюда точное равенство: любое новое «ожидающее» поле — регресс подстановки.
  const pending = pendingAuditFields({});
  assert.deepStrictEqual(pending.map((field) => field.key), [KEV_FORMAT_FIELD_KEY]);
  assert.strictEqual(pendingAuditFields({ [KEV_FORMAT_FIELD_KEY]: 'UF_CRM_KEV' }).length, 0);
});

await check('идентификаторы категорий берутся из доменной конфигурации, а не литералами', () => {
  assert.strictEqual(PORTAL_FIELDS.companyCategoryId, DEAL_CATEGORY_IDS.companies);
  assert.strictEqual(PORTAL_FIELDS.dealCategoryId, DEAL_CATEGORY_IDS.deals);
});

await check('companyCardId читает штатную карточку контрагента и не путает ноль со связью', () => {
  assert.strictEqual(companyCardId({ companyId: 4242 }), '4242');
  assert.strictEqual(companyCardId({ COMPANY_ID: '4242' }), '4242', 'верхний регистр имени поля не опознан');
  assert.strictEqual(companyCardId({ companyId: 0 }), null, 'companyId = 0 означает «карточки нет», а не связь с сущностью №0');
  assert.strictEqual(companyCardId({}), null);
});

await check('база — МНОЖЕСТВЕННОЕ перечисление: значение приходит массивом', () => {
  // Боевой прогон 18.08.2026: поле отдаёт `[493]`, а не `493`. Прежнее чтение скаляром
  // давало '' на массиве — молча, без ошибки, и база оказалась пустой у ВСЕХ записей.
  const fields = resolvePortalFields({});
  const key = String(PORTAL_FIELDS.companySourceField).replace(/^UF_CRM_/, 'ufCrm_');
  assert.strictEqual(normalizeCompany({ id: '1', [key]: [493] }, fields).sourceId, '493', 'массив из одного значения не сведён к ID');
  assert.strictEqual(normalizeCompany({ id: '2', [key]: '493' }, fields).sourceId, '493', 'скаляр обязан читаться тем же путём');
  assert.strictEqual(normalizeCompany({ id: '3', [key]: [] }, fields).sourceId, null, 'пустой массив — это «не заполнено», а не ID');
  assert.strictEqual(normalizeCompany({ id: '4' }, fields).sourceId, null);
  // Определения полей приходят как UF_CRM_…, записи — как ufCrm_…: оба написания читаются.
  assert.strictEqual(
    normalizeCompany({ id: '5', [PORTAL_FIELDS.companySourceField]: [493] }, fields).sourceId,
    '493',
    'написание поля из ОПРЕДЕЛЕНИЙ не прочитано'
  );
});

await check('стадия сущности читается из штатного stageId: обе воронки — категории сделок', () => {
  const fields = resolvePortalFields({});
  const company = normalizeCompany({ id: '1', stageId: STAGE_TECHNICAL_IDS.companies.takenToWork }, fields);
  const deal = normalizeDeal({ id: '2', stageId: STAGE_TECHNICAL_IDS.deals.proposalSent }, fields);
  assert.strictEqual(company.currentStageId, STAGE_TECHNICAL_IDS.companies.takenToWork);
  assert.strictEqual(deal.currentStageId, STAGE_TECHNICAL_IDS.deals.proposalSent);
});

await check('отсутствующее поле КЭВ не роняет нормализацию — сделка просто без формата', () => {
  const fields = resolvePortalFields({});
  assert.strictEqual(fields.dealKevFormatField, null, 'поля КЭВ на портале нет — оно обязано быть null');
  const deal = normalizeDeal({ id: '7', categoryId: 7, stageId: STAGE_TECHNICAL_IDS.deals.needIdentified }, fields);
  assert.strictEqual(deal.kevFormatId, null, 'нормализация без поля КЭВ должна дать null, а не упасть');
});

await check('нормализатор сделки не выдаёт карточку контрагента за связь воронок', () => {
  // companyId сделки указывает на карточку контрагента CRM, а в companies[] лежат
  // сделки категории 5. Положить карточку прямо в companyId значило бы дать «родителя»,
  // которого нет в companies[]. Карточка едет отдельным полем, перевод — в fullSync.
  const fields = resolvePortalFields({});
  const deal = normalizeDeal({ id: '7', companyId: 4242, stageId: STAGE_TECHNICAL_IDS.deals.needIdentified }, fields);
  assert.strictEqual(deal.companyId, null, 'карточка контрагента подставлена в связь воронок напрямую');
  assert.strictEqual(deal.companyCardId, '4242', 'карточка контрагента потеряна — связывать воронки будет нечем');
});

await check('stageHistoryEvent разводит записи журнала по воронкам и отбрасывает чужие', () => {
  const company = stageHistoryEvent({
    id: 1, typeId: 2, ownerId: 39281, categoryId: 5,
    stageId: STAGE_TECHNICAL_IDS.companies.takenToWork, createdAt: '2026-03-01T10:00:00Z'
  });
  assert.deepStrictEqual(company, {
    funnelId: 'companies',
    event: { companyId: '39281', stageId: STAGE_TECHNICAL_IDS.companies.takenToWork, at: '2026-03-01T10:00:00.000Z' }
  });

  const deal = stageHistoryEvent({
    id: 2, typeId: 2, ownerId: 55001, categoryId: 7,
    stageId: STAGE_TECHNICAL_IDS.deals.proposalSent, createdAt: '2026-03-02T10:00:00Z'
  });
  assert.deepStrictEqual(deal, {
    funnelId: 'deals',
    event: { dealId: '55001', stageId: STAGE_TECHNICAL_IDS.deals.proposalSent, at: '2026-03-02T10:00:00.000Z' }
  });

  assert.strictEqual(
    stageHistoryEvent({ ownerId: 3, categoryId: 1, stageId: 'C1:NEW', createdAt: '2026-03-01T10:00:00Z' }),
    null,
    'категория вне сквозной воронки («Прогрев», «Производство») не должна попадать в события'
  );
  assert.strictEqual(
    stageHistoryEvent({ ownerId: 4, categoryId: 7, stageId: STAGE_TECHNICAL_IDS.companies.newCompany, createdAt: '2026-03-01T10:00:00Z' }),
    null,
    'расхождение категории и префикса стадии — запись непонятно чья, её нельзя класть ни в одну воронку'
  );
  assert.strictEqual(
    stageHistoryEvent({ ownerId: 5, categoryId: 5, stageId: STAGE_TECHNICAL_IDS.companies.newCompany }),
    null,
    'событие без даты принято'
  );
});

await check('findFieldDescription находит поле и в массиве описаний, и вне зависимости от регистра', () => {
  // /v1/userfields/deals отдаёт МАССИВ описаний в конверте {success, data}, а не
  // карту «имя → описание», как классический crm.deal.fields.
  const body = { success: true, data: [{ fieldName: 'UF_CRM_694BF2A975BD0', items: [{ ID: '101', VALUE: 'Выписка' }] }] };
  assert.ok(findFieldDescription(body, 'UF_CRM_694BF2A975BD0'), 'поле не найдено в массиве описаний');
  assert.ok(findFieldDescription(body, 'ufCrm_694BF2A975BD0'), 'camelCase-написание того же поля не опознано');
  assert.strictEqual(findFieldDescription(body, 'UF_CRM_НЕТ_ТАКОГО'), null);
});

// ═══════════════════════════════ ОРКЕСТРАЦИЯ (fullSync) ═══════════════════════

const NOW = new Date('2026-08-15T12:00:00.000Z');
const C5 = STAGE_TECHNICAL_IDS.companies;
const C7 = STAGE_TECHNICAL_IDS.deals;

/**
 * Имя пользовательского поля в ЗАПИСИ портала: определения приходят как
 * `UF_CRM_…`, а записи — как `ufCrm_…`. Ключ строится из определения, чтобы
 * проверка ловила расхождение обоих написаний, а не повторяла литерал за кодом.
 */
const asRecordKey = (fieldId) => String(fieldId).replace(/^UF_CRM_/, 'ufCrm_');
const SOURCE_KEY = asRecordKey(PORTAL_FIELDS.companySourceField);

/**
 * Сделка воронки «Компании» (категория 5) в том виде, в каком её отдаёт /v1/deals.
 * База приходит МАССИВОМ — поле множественное; `companyId` указывает на карточку
 * контрагента, по которой и собирается связь воронок.
 */
function companyRow(id, extra = {}) {
  return {
    id, categoryId: Number(DEAL_CATEGORY_IDS.companies), title: `Компания ${id}`,
    stageId: C5.newCompany, assignedById: 10, companyId: 9000 + Number(id),
    createdAt: '2026-08-01T09:00:00Z', updatedAt: '2026-08-02T09:00:00Z',
    [SOURCE_KEY]: [101], ...extra
  };
}

/**
 * Сделка воронки «Сделки» (категория 7). Базы у неё нет — поле верхней воронки;
 * по умолчанию делит карточку контрагента с `companyRow('1')`.
 */
function dealRow(id, extra = {}) {
  return {
    id, categoryId: Number(DEAL_CATEGORY_IDS.deals), title: `Сделка ${id}`,
    stageId: C7.needIdentified, assignedById: 10, companyId: 9001,
    createdAt: '2026-08-03T09:00:00Z', updatedAt: '2026-08-04T09:00:00Z',
    ...extra
  };
}

/** Клиент-подделка для fetchBitrixSnapshot: без сети, ответы заданы явно. */
function fakeClient({
  companies = [], deals = [], users = [], stageHistory = [], calls = [], callsRoute = null,
  dealFields = { success: true, data: [] },
  failEntity = null, failCategory = null, truncateEntity = null, pageCaps = null,
  paths = null
} = {}) {
  const dealsOfCategory = (categoryId) => {
    if (String(categoryId) === DEAL_CATEGORY_IDS.companies) return companies;
    if (String(categoryId) === DEAL_CATEGORY_IDS.deals) return deals;
    return [];
  };
  return {
    ready: true,
    // Настоящий повтор здесь не нужен — эти проверки не о ретраях (те покрыты
    // отдельно, "withRetry повторяет только ретраибельную ошибку"). Метод обязан
    // просто существовать: fullSync.js реально вызывает client.retry(...) везде,
    // где раньше вызывал сетевой метод напрямую.
    retry: (task) => task(),
    async listAll(entity, params = {}, listOptions = {}) {
      pageCaps?.push({ entity, maxPages: listOptions.maxPages ?? null });
      paths?.push(entity);
      if (failEntity === entity) throw new Error(`маршрут ${entity} недоступен`);
      if (entity === BITRIX_ENTITIES.deals) {
        if (failCategory !== null && String(params.categoryId) === String(failCategory)) {
          throw new Error(`выборка категории ${params.categoryId} недоступна`);
        }
        return { rows: dealsOfCategory(params.categoryId), pages: 1, truncated: truncateEntity === entity };
      }
      if (entity === BITRIX_ENTITIES.users) return { rows: users, pages: 1, truncated: false };
      if (entity === BITRIX_ENTITIES.stageHistory) {
        return { rows: stageHistory, pages: 1, truncated: truncateEntity === entity };
      }
      if (CALL_ROUTE_CANDIDATES.includes(entity)) {
        if (callsRoute !== null && entity !== callsRoute) {
          throw new Error(`маршрут ${entity} недоступен`);
        }
        return { rows: calls, pages: 1, truncated: false };
      }
      return { rows: [], pages: 1, truncated: false };
    },
    async fetchOne(entity) {
      paths?.push(entity);
      if (failEntity === entity) throw new Error(`маршрут ${entity} недоступен`);
      return entity === BITRIX_ENTITIES.dealFields ? dealFields : {};
    }
  };
}

await check('отсутствие ключа останавливает синхронизацию до первого сетевого вызова', async () => {
  await assert.rejects(
    () => fetchBitrixSnapshot({ client: { ready: false } }),
    (error) => { assert.strictEqual(error.code, 'NO_API_KEY'); return true; }
  );
});

await check('синхронизация ходит ТОЛЬКО по маршрутам во множественном числе', async () => {
  // Одиночные формы (`/v1/deal`, `/v1/user`) отвечают 404 ROUTE_NOT_FOUND —
  // именно на них ломалась прежняя версия синхронизации.
  const paths = [];
  await fetchBitrixSnapshot({ client: fakeClient({ paths }), now: NOW });
  assert.ok(paths.length > 0, 'синхронизация не сделала ни одного запроса');
  // Кандидаты маршрутов звонков — тоже законные адреса: единого имени у
  // телефонии нет, и синхронизация перебирает их, пока какой-нибудь не ответит.
  const allowed = new Set([...Object.values(BITRIX_ENTITIES), ...CALL_ROUTE_CANDIDATES]);
  for (const path of paths) {
    assert.ok(allowed.has(path), `запрошен неизвестный маршрут «${path}»`);
    assert.ok(!/^(company|deal|user)$/.test(path), `маршрут «${path}» в единственном числе — портал ответит 404`);
  }
  assert.ok(paths.includes('deals') && paths.includes('users'), 'сделки и сотрудники обязаны запрашиваться');
  assert.ok(paths.includes('userfields/deals'), 'описания полей читаются из userfields/deals');
  assert.ok(paths.includes('stage-history'), 'история стадий обязана запрашиваться');
  assert.ok(!paths.includes('assignee-history'), 'маршрута истории ответственных на портале нет — запрашивать его нечего');
});

await check('сделки категории 5 ложатся в companies[], категории 7 — в deals[]', async () => {
  const client = fakeClient({ companies: [companyRow('1'), companyRow('2')], deals: [dealRow('501')] });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.deepStrictEqual(snapshot.companies.map((c) => c.id), ['1', '2'], 'воронка «Компании» собирается из сделок категории 5');
  assert.deepStrictEqual(snapshot.deals.map((d) => d.id), ['501']);
  assert.strictEqual(snapshot.companies[0].currentStageId, C5.newCompany);
  assert.strictEqual(snapshot.deals[0].currentStageId, C7.needIdentified);
  assert.strictEqual(snapshot.companies[0].sourceId, '101', 'база/источник читается из поля в camelCase-написании');
});

await check('сделка чужой категории отбрасывается, даже если портал проигнорировал параметр', async () => {
  // Портал молча игнорирует незнакомые параметры запроса (проверено на
  // filter[ownerId] у истории стадий) — тогда обе воронки получили бы все
  // категории портала разом. Второй отбор по полученным записям это ловит.
  const client = fakeClient({
    companies: [companyRow('1'), { ...companyRow('9'), categoryId: 11 }],
    deals: [dealRow('501')]
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.deepStrictEqual(snapshot.companies.map((c) => c.id), ['1'], 'сделка категории 11 попала в воронку «Компании»');
  assert.ok(snapshot.warnings.some((w) => w.code === 'ENTITY_CATEGORY_MISMATCH'), 'игнор параметра категории должен быть виден предупреждением');
});

await check('карточка контрагента раскладывает сделку второй воронки к её сущности первой', async () => {
  // Связь воронок: сделка C5 → карточка компании ← сделка C7. В снимке companies[] —
  // это сделки категории 5, поэтому карточка обязана превратиться в ID сделки C5,
  // а не остаться сырым ID карточки.
  const client = fakeClient({
    companies: [companyRow('1'), companyRow('2')],
    deals: [
      dealRow('501', { companyId: 9001 }),          // карточка сделки C5 №1
      dealRow('502', { companyId: '9002' }),        // та же карточка строкой — сделка C5 №2
      dealRow('503', { companyId: 7777 }),          // карточки нет среди сущностей первой воронки
      dealRow('504', { companyId: 0 })              // контрагент у сделки не заполнен
    ]
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  const byId = new Map(snapshot.deals.map((deal) => [deal.id, deal]));
  assert.strictEqual(byId.get('501').companyId, '1', 'карточка не переведена в ID сделки первой воронки');
  assert.strictEqual(byId.get('502').companyId, '2', 'строковый ID карточки не опознан как та же карточка');
  assert.strictEqual(byId.get('503').companyId, null, 'несопоставленной карточке нельзя выдумывать родителя');
  assert.strictEqual(byId.get('504').companyId, null, 'companyId = 0 — это отсутствие связи, а не сущность №0');
  assert.notStrictEqual(byId.get('501').companyId, '9001', 'в связь попал сырой ID карточки вместо сделки первой воронки');
  assert.strictEqual(snapshot.dataQuality.dealsWithoutCompany, 2, 'несвязанные сделки обязаны попасть в счётчик качества данных');
});

await check('одна карточка на несколько сущностей первой воронки: выбор детерминирован и назван вслух', async () => {
  // Компанию заводили дважды — обе сделки C5 смотрят на одну карточку. Родителем
  // берётся самая ранняя по createdAt, иначе два прогона синхронизации разошлись бы
  // в числах сквозной воронки без единого изменения на портале.
  const companies = [
    companyRow('20', { companyId: 5555, createdAt: '2026-08-05T09:00:00Z' }),
    companyRow('10', { companyId: 5555, createdAt: '2026-08-01T09:00:00Z' }), // самая ранняя
    companyRow('30', { companyId: 5555, createdAt: '2026-08-09T09:00:00Z' })
  ];
  const client = fakeClient({ companies, deals: [dealRow('501', { companyId: 5555 })] });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.strictEqual(snapshot.deals[0].companyId, '10', 'родителем выбрана не самая ранняя сущность');

  const collision = snapshot.warnings.find((w) => w.code === 'COMPANY_CARD_COLLISION');
  assert.ok(collision, 'столкновение карточек обязано быть видно предупреждением');
  assert.ok(/2 лишних/.test(collision.message), `в предупреждении нет числа столкновений: ${collision.message}`);

  // Порядок записей от портала не гарантирован — при любой перестановке ответ тот же.
  const reversed = await fetchBitrixSnapshot({
    client: fakeClient({ companies: [...companies].reverse(), deals: [dealRow('501', { companyId: 5555 })] }),
    now: NOW
  });
  assert.strictEqual(reversed.deals[0].companyId, '10', 'выбор родителя зависит от порядка страниц выборки');
});

await check('при равных датах создания родителем становится меньший ID', () => {
  const same = '2026-08-01T09:00:00.000Z';
  const { byCard, collidingCards, extraCompanies } = indexCompaniesByCard([
    { id: '77', companyCardId: '5555', createdAt: same },
    { id: '9', companyCardId: '5555', createdAt: same },
    { id: '12', companyCardId: null, createdAt: same } // без карточки — целью связи быть не может
  ]);
  assert.strictEqual(byCard.get('5555').id, '9', 'ID сравнены как строки: «12» < «9» дало бы не тот ответ');
  assert.strictEqual(collidingCards, 1);
  assert.strictEqual(extraCompanies, 1);
  assert.strictEqual(byCard.size, 1, 'сущность без карточки не должна попадать в индекс');
});

await check('сделка из прежнего снимка не теряет уже разрешённую связь', () => {
  // У восстановленной сделки карточки нет — её в снимке прежней версии не хранили.
  // Обнулить companyId значило бы потерять данные там, где новой информации нет.
  const warnings = [];
  const linked = linkDealsToCompanies(
    [{ id: '1', companyCardId: '9001', createdAt: '2026-08-01T09:00:00.000Z' }],
    [{ id: '501', companyId: '1' }, { id: '502', companyCardId: '9001', companyId: null }],
    warnings
  );
  assert.strictEqual(linked[0].companyId, '1', 'связь восстановленной сделки затёрта');
  assert.strictEqual(linked[1].companyId, '1');
  assert.deepStrictEqual(warnings, [], 'без столкновений предупреждению взяться неоткуда');
});

// База на этом портале заполняется только в верхней воронке. Без наследования
// фильтр по базе обнулял бы всю нижнюю половину сквозной воронки: сделка не
// совпала бы ни с одним выбранным значением, хотя её родитель этой базе принадлежит.
await check('сделка наследует базу от родителя, но своё значение не затирается', () => {
  const warnings = [];
  const linked = linkDealsToCompanies(
    [
      { id: '1', companyCardId: '9001', sourceId: '493', createdAt: '2026-08-01T09:00:00.000Z' },
      { id: '2', companyCardId: '9002', sourceId: null, createdAt: '2026-08-01T09:00:00.000Z' }
    ],
    [
      { id: '501', companyCardId: '9001', sourceId: null },
      { id: '502', companyCardId: '9001', sourceId: '777' },
      { id: '503', companyCardId: '9002', sourceId: null },
      { id: '504', companyCardId: '7777', sourceId: null }
    ],
    warnings
  );
  assert.strictEqual(linked[0].sourceId, '493', 'база не унаследована от родителя');
  assert.strictEqual(linked[1].sourceId, '777', 'собственная база сделки затёрта родительской');
  assert.strictEqual(linked[2].sourceId, null, 'у родителя базы нет — наследовать нечего');
  // Несвязанная сделка родителя не имеет: наследовать не от кого, связь пуста.
  assert.strictEqual(linked[3].companyId, null);
  assert.strictEqual(linked[3].sourceId, null);
});

await check('общий журнал истории стадий делится по категориям на две воронки', async () => {
  const client = fakeClient({
    companies: [companyRow('1')],
    deals: [dealRow('501')],
    stageHistory: [
      { id: 1, typeId: 2, ownerId: 1, categoryId: 5, stageId: C5.newCompany, createdAt: '2026-08-01T09:00:00Z' },
      { id: 2, typeId: 2, ownerId: 1, categoryId: 5, stageId: C5.takenToWork, createdAt: '2026-08-02T09:00:00Z' },
      { id: 3, typeId: 2, ownerId: 501, categoryId: 7, stageId: C7.needIdentified, createdAt: '2026-08-03T09:00:00Z' },
      { id: 4, typeId: 3, ownerId: 900, categoryId: 11, stageId: 'C11:NEW', createdAt: '2026-08-04T09:00:00Z' }
    ]
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.deepStrictEqual(
    snapshot.companyStageEvents,
    [
      { companyId: '1', stageId: C5.newCompany, at: '2026-08-01T09:00:00.000Z' },
      { companyId: '1', stageId: C5.takenToWork, at: '2026-08-02T09:00:00.000Z' }
    ],
    'события категории 5 обязаны лечь в историю первой воронки с ключом companyId'
  );
  assert.deepStrictEqual(
    snapshot.dealStageEvents,
    [{ dealId: '501', stageId: C7.needIdentified, at: '2026-08-03T09:00:00.000Z' }]
  );
});

await check('история ответственных на портале недоступна: массив пуст и об этом сказано', async () => {
  const snapshot = await fetchBitrixSnapshot({ client: fakeClient({ companies: [companyRow('1')] }), now: NOW });
  assert.deepStrictEqual(snapshot.assigneeEvents, [], 'маршрута нет — событий взяться неоткуда');
  assert.strictEqual(snapshot.dataQuality.assigneeHistoryAvailable, false);
  assert.ok(
    snapshot.warnings.some((w) => w.code === 'ASSIGNEE_HISTORY_UNAVAILABLE'),
    'пользователь обязан знать, что фильтр по менеджеру считает по ТЕКУЩЕМУ ответственному'
  );
});

await check('отсутствие поля КЭВ — спокойная пометка, а не сигнал о недонастройке', async () => {
  const snapshot = await fetchBitrixSnapshot({ client: fakeClient({ deals: [dealRow('501')] }), now: NOW });
  assert.deepStrictEqual(snapshot.kevFormats, [], 'справочник КЭВ без поля обязан остаться пустым, а не упасть');
  assert.ok(snapshot.warnings.some((w) => w.code === 'KEV_FIELD_ABSENT'), 'известный пробел портала должен быть назван своим кодом');
  assert.ok(
    !snapshot.warnings.some((w) => w.code === 'PORTAL_FIELDS_PENDING'),
    'КЭВ не должен подмешиваться к предупреждению о неподтверждённых полях — оно про недонастройку, а это разобранный пробел'
  );
});

await check('справочник источников собирается из определений полей сделки', async () => {
  const client = fakeClient({
    companies: [companyRow('1')],
    deals: [dealRow('501')],
    dealFields: {
      success: true,
      data: [{ fieldName: PORTAL_FIELDS.companySourceField, items: [{ ID: '101', VALUE: '2026.01.21 Выписка' }] }]
    }
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.deepStrictEqual(snapshot.sources, [{ id: '101', name: '2026.01.21 Выписка' }]);
  // Главное здесь — ФОРМА ID по обе стороны: в записи база лежит массивом (`[101]`),
  // в справочнике ключом служит ID элемента перечисления. Разойдись они — фильтр
  // «База» показывал бы человеческие названия, но не находил бы по ним ни одной записи.
  assert.ok(
    snapshot.sources.some((source) => source.id === snapshot.companies[0].sourceId),
    `база записи «${snapshot.companies[0].sourceId}» не совпала ни с одним ключом справочника`
  );
});

await check('сбой выборки одной воронки не роняет вторую и виден предупреждением', async () => {
  const client = fakeClient({ deals: [dealRow('501')], failCategory: DEAL_CATEGORY_IDS.companies });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.strictEqual(Array.isArray(snapshot.companies), true, 'снимок обязан остаться валидным даже при сбое одной воронки');
  assert.strictEqual(snapshot.companies.length, 0);
  assert.strictEqual(snapshot.deals.length, 1, 'вторая воронка не должна страдать из-за сбоя первой');
  assert.ok(snapshot.warnings.some((w) => w.code === 'ENTITY_FETCH_FAILED'), 'сбой выборки не отражён предупреждением');
});

await check('неудавшаяся выборка воронки восстанавливает её сущности из прежнего снимка', async () => {
  const client = fakeClient({ failCategory: DEAL_CATEGORY_IDS.companies });
  const previousSnapshot = { companies: [{ id: '1', title: 'Из прежнего снимка', currentStageId: C5.takenToWork }] };
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, previousSnapshot });
  assert.deepStrictEqual(snapshot.companies.map((c) => c.id), ['1'], 'сущности не должны исчезать из-за одного отказа маршрута');
  assert.ok(snapshot.warnings.some((w) => w.code === 'ENTITY_RESTORED_FROM_CACHE'));
});

await check('удавшаяся выборка НЕ подмешивает исчезнувшие сущности из прежнего снимка', async () => {
  const client = fakeClient({ companies: [companyRow('1')] });
  const previousSnapshot = { companies: [{ id: '1' }, { id: '2', title: 'Удалена на портале' }] };
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, previousSnapshot });
  assert.deepStrictEqual(snapshot.companies.map((c) => c.id), ['1'], 'реально удалённая сущность не должна возвращаться');
});

await check('недоступная история стадий сохраняет прежние события, а не обнуляет пройденные этапы', async () => {
  const client = fakeClient({ companies: [companyRow('1')], deals: [dealRow('501')], failEntity: BITRIX_ENTITIES.stageHistory });
  const previousSnapshot = {
    companyStageEvents: [{ companyId: '1', stageId: C5.takenToWork, at: '2026-07-01T00:00:00.000Z' }],
    dealStageEvents: [{ dealId: '501', stageId: C7.proposalSent, at: '2026-07-02T00:00:00.000Z' }]
  };
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, previousSnapshot });
  assert.deepStrictEqual(snapshot.companyStageEvents, previousSnapshot.companyStageEvents, 'отказ маршрута истории не должен стирать достигнутые этапы');
  assert.deepStrictEqual(snapshot.dealStageEvents, previousSnapshot.dealStageEvents);
  assert.ok(snapshot.warnings.some((w) => w.code === 'STAGE_HISTORY_UNAVAILABLE'));
});

await check('обрезанная история стадий дополняется прежними событиями по недостающим владельцам', async () => {
  const client = fakeClient({
    companies: [companyRow('1'), companyRow('2')],
    truncateEntity: BITRIX_ENTITIES.stageHistory,
    stageHistory: [{ id: 1, typeId: 2, ownerId: 1, categoryId: 5, stageId: C5.takenToWork, createdAt: '2026-08-02T09:00:00Z' }]
  });
  const previousSnapshot = {
    companyStageEvents: [
      { companyId: '1', stageId: C5.newCompany, at: '2026-07-01T00:00:00.000Z' }, // приехало заново — заменяется
      { companyId: '2', stageId: C5.takenToWork, at: '2026-07-02T00:00:00.000Z' } // до его страницы не дошли — сохраняется
    ]
  };
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, previousSnapshot });
  const byOwner = new Map(snapshot.companyStageEvents.map((event) => [event.companyId, event]));
  assert.strictEqual(byOwner.get('1').stageId, C5.takenToWork, 'у владельца со свежими событиями должны остаться НОВЫЕ');
  assert.strictEqual(byOwner.get('2').stageId, C5.takenToWork, 'владелец без свежих событий обязан сохранить прежние');
  assert.ok(snapshot.warnings.some((w) => w.code === 'STAGE_HISTORY_TRUNCATED'));
});

await check('без previousSnapshot отказ истории просто даёт пустую историю, а не падение', async () => {
  const client = fakeClient({ companies: [companyRow('1')], failEntity: BITRIX_ENTITIES.stageHistory });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });
  assert.deepStrictEqual(snapshot.companyStageEvents, []);
  assert.strictEqual(snapshot.companies.length, 1, 'сбой истории не должен стереть саму сущность');
});

await check('не заданная категория не блокирует вторую воронку, но помечается предупреждением', async () => {
  const client = fakeClient({ companies: [companyRow('1')], deals: [dealRow('501')] });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW, portalFields: { companyCategoryId: '' } });
  assert.strictEqual(snapshot.companies.length, 0);
  assert.strictEqual(snapshot.deals.length, 1, 'вторая воронка не должна страдать из-за незаданной категории первой');
  assert.ok(snapshot.warnings.some((w) => w.code === 'DEAL_CATEGORY_PENDING'));
});

await check('недоступная телефония не роняет синхронизацию и объясняет пустую карточку', async () => {
  // Ноль звонков как ИЗМЕРЕНИЕ («звонков не было») и отсутствие источника —
  // разные вещи: карточка «Звонки» обязана показывать причину, а не голый ноль.
  const snapshot = await fetchBitrixSnapshot({
    client: fakeClient({ deals: [dealRow('501')], failEntity: BITRIX_ENTITIES.calls }),
    now: NOW
  });
  assert.ok(!snapshot.calls?.length, 'синхронизация не должна выдумывать звонки');
  assert.ok(snapshot.warnings.some((w) => w.code === 'CALLS_UNAVAILABLE'),
    'пустая карточка звонков обязана объясняться предупреждением, а не молча давать ноль');
});

await check('звонки телефонии раскладываются по воронкам по своим спискам ID', async () => {
  // Телефония знает только «сделка N». Какая это воронка — видно лишь по нашим
  // спискам: 501 — сущность верхней воронки, 701 — сделка нижней.
  const snapshot = await fetchBitrixSnapshot({
    client: fakeClient({
      companies: [companyRow('501')],
      deals: [dealRow('701')],
      calls: [
        { id: '1', CRM_ENTITY_TYPE: 'DEAL', CRM_ENTITY_ID: '501', CALL_START_DATE: '2026-08-10 09:00:00', CALL_DURATION: '300', CALL_FAILED_CODE: '200' },
        { id: '2', CRM_ENTITY_TYPE: 'DEAL', CRM_ENTITY_ID: '701', CALL_START_DATE: '2026-08-10 10:00:00', CALL_DURATION: '90', CALL_FAILED_CODE: '304' },
        { id: '3', CRM_ENTITY_TYPE: 'LEAD', CRM_ENTITY_ID: '501', CALL_START_DATE: '2026-08-10 11:00:00', CALL_DURATION: '600', CALL_FAILED_CODE: '200' },
        { id: '4', CRM_ENTITY_TYPE: 'DEAL', CRM_ENTITY_ID: '999', CALL_START_DATE: '2026-08-10 12:00:00', CALL_DURATION: '600', CALL_FAILED_CODE: '200' }
      ]
    }),
    now: NOW
  });

  assert.strictEqual(snapshot.calls.length, 2,
    'связь обязаны получить только звонки по сущностям наших воронок: лид и чужая сделка — мимо');
  const upper = snapshot.calls.find((c) => c.id === '1');
  assert.strictEqual(upper.companyId, '501');
  assert.strictEqual(upper.dealId, null);
  assert.strictEqual(upper.durationMinutes, 5, 'длительность телефонии приходит в СЕКУНДАХ и обязана переводиться в минуты');
  assert.strictEqual(upper.success, true, 'код завершения 200 — разговор состоялся');

  const lower = snapshot.calls.find((c) => c.id === '2');
  assert.strictEqual(lower.dealId, '701');
  assert.strictEqual(lower.success, false, 'код завершения не 200 — звонок неуспешен');
});

await check('звонки берутся с того маршрута портала, который отвечает, а не только с первого', async () => {
  // Единого имени у телефонии нет: где-то это выделенный маршрут, где-то звонок —
  // дело CRM с типом «звонок». Первый кандидат отвечает 404, значит обязан быть
  // опробован следующий, иначе карточка пустует при живых данных на портале.
  const snapshot = await fetchBitrixSnapshot({
    client: fakeClient({
      companies: [companyRow('501')],
      callsRoute: 'activities',
      calls: [
        { ID: 9, TYPE_ID: 2, OWNER_ID: '501', OWNER_TYPE_ID: 2, START_TIME: '2026-08-10 10:00:00', END_TIME: '2026-08-10 10:07:00', COMPLETED: 'Y' },
        { ID: 10, TYPE_ID: 4, OWNER_ID: '501', OWNER_TYPE_ID: 2, START_TIME: '2026-08-10 11:00:00', END_TIME: '2026-08-10 11:30:00', COMPLETED: 'Y' }
      ]
    }),
    now: NOW
  });
  assert.strictEqual(snapshot.calls.length, 1, 'дело CRM другого типа (письмо) звонком не является');
  assert.strictEqual(snapshot.calls[0].durationMinutes, 7,
    'у дела CRM длительности нет — она обязана выводиться из интервала начала и конца');
  assert.strictEqual(snapshot.calls[0].success, true);
  assert.strictEqual(snapshot.dataQuality.callsRoute, 'activities',
    'в диагностику обязан попасть маршрут, который реально отдал звонки');
});

await check('выборка звонков ограничена потолком страниц, а выборка воронки — нет', async () => {
  // Маршрут дел CRM отдаёт ВСЕ дела портала. Без потолка эта ветка тянет
  // синхронизацию дольше всех остальных вместе взятых, а пока синхронизация
  // идёт, снимка нет и дашборд показывает демо-цифры вместо воронки.
  const pageCaps = [];
  await fetchBitrixSnapshot({ client: fakeClient({ pageCaps, callsRoute: 'activities' }), now: NOW });
  const callRoutes = pageCaps.filter((c) => CALL_ROUTE_CANDIDATES.includes(c.entity));
  assert.ok(callRoutes.length > 0, 'звонки обязаны запрашиваться');
  for (const call of callRoutes) {
    assert.ok(Number(call.maxPages) > 0, `выборка звонков по «${call.entity}» идёт без потолка страниц`);
  }
  const history = pageCaps.find((c) => c.entity === 'stage-history');
  assert.strictEqual(history?.maxPages ?? null, null,
    'у истории стадий потолка быть не должно: её неполнота занижает саму воронку');
});

await check('ни один маршрут звонков не ответил — синхронизация продолжается с объяснением', async () => {
  const snapshot = await fetchBitrixSnapshot({
    client: fakeClient({ companies: [companyRow('501')], callsRoute: 'нет-такого-маршрута' }),
    now: NOW
  });
  assert.strictEqual(snapshot.calls.length, 0);
  assert.strictEqual(snapshot.dataQuality.callsRoute, null);
  assert.ok(snapshot.warnings.some((w) => w.code === 'CALLS_UNAVAILABLE'),
    'пустая карточка звонков обязана объясняться предупреждением, а не выглядеть нулём');
});

await check('звонок по сделке нижней воронки наследует компанию-родителя', async () => {
  // Иначе фильтр по базе выкинул бы такие звонки: база живёт только наверху.
  const parent = { ...companyRow('501'), companyId: '9001' };
  const child = { ...dealRow('701'), companyId: '9001' };
  const snapshot = await fetchBitrixSnapshot({
    client: fakeClient({
      companies: [parent],
      deals: [child],
      calls: [
        { id: '1', CRM_ENTITY_TYPE: 'DEAL', CRM_ENTITY_ID: '701', CALL_START_DATE: '2026-08-10 10:00:00', CALL_DURATION: '60', CALL_FAILED_CODE: '200' }
      ]
    }),
    now: NOW
  });
  const call = snapshot.calls[0];
  assert.strictEqual(call.dealId, '701');
  assert.strictEqual(call.companyId, '501', 'звонок по сделке обязан ссылаться на её сущность верхней воронки');
});

await check('createLimiter — ОДИН пул слотов на несколько независимых веток, а не свой на каждую', async () => {
  // Имитация реальной ситуации: два "источника" задач одновременно засыпают
  // один и тот же ограничитель, а не заводят каждый свой независимый пул воркеров.
  const limiter = createLimiter(3);
  let active = 0;
  let maxActive = 0;
  const task = () => new Promise((resolve) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    setTimeout(() => { active -= 1; resolve(); }, 5);
  });
  const branchA = Promise.all(Array.from({ length: 10 }, () => limiter(task)));
  const branchB = Promise.all(Array.from({ length: 10 }, () => limiter(task)));
  await Promise.all([branchA, branchB]);
  assert.ok(maxActive <= 3, `общий предел нарушен: одновременно выполнялось ${maxActive} задач вместо не более 3`);
});

await check('restoreMissingFromPrevious дополняет свежий список, не создавая дублей', () => {
  const warnings = [];
  const merged = restoreMissingFromPrevious([{ id: 'c2' }], [{ id: 'c1' }, { id: 'c2' }], warnings, 'компаний');
  assert.deepStrictEqual(merged.map((c) => c.id).sort(), ['c1', 'c2']);
  assert.ok(warnings.some((w) => w.code === 'ENTITY_RESTORED_FROM_CACHE'));

  const untouched = [{ id: 'c1' }];
  assert.deepStrictEqual(restoreMissingFromPrevious(untouched, [], [], 'компаний'), untouched);
});

await check('keepPreviousEventsForMissingOwners не трогает владельцев со свежими событиями', () => {
  const fresh = [{ dealId: 'd1', stageId: 'A', at: '2026-08-01T00:00:00.000Z' }];
  const previous = [
    { dealId: 'd1', stageId: 'СТАРОЕ', at: '2026-01-01T00:00:00.000Z' },
    { dealId: 'd2', stageId: 'B', at: '2026-01-02T00:00:00.000Z' }
  ];
  const merged = keepPreviousEventsForMissingOwners(fresh, previous, 'dealId');
  assert.deepStrictEqual(merged, [fresh[0], previous[1]]);
});

await check('полный happy path даёт валидный снимок со всеми разделами формы', async () => {
  const client = fakeClient({
    companies: [companyRow('1', { title: 'ООО Ромашка', assignedById: 'm1' })],
    deals: [dealRow('501', { title: 'Потребность 1', assignedById: 'm1' })],
    users: [{ id: 'm1', firstName: 'Ирина', lastName: 'Соколова' }],
    stageHistory: [{ id: 1, typeId: 2, ownerId: 1, categoryId: 5, stageId: C5.takenToWork, createdAt: '2026-08-02T09:00:00Z' }],
    dealFields: {
      success: true,
      data: [{ fieldName: PORTAL_FIELDS.companySourceField, items: [{ ID: '101', VALUE: '2026.01.21 Выписка' }] }]
    }
  });
  const snapshot = await fetchBitrixSnapshot({ client, now: NOW });

  for (const key of ['companies', 'deals', 'companyStageEvents', 'dealStageEvents', 'assigneeEvents', 'managers', 'sources', 'kevFormats']) {
    assert.ok(Array.isArray(snapshot[key]), `«${key}» должен быть массивом`);
  }
  assert.strictEqual(snapshot.companies[0].title, 'ООО Ромашка');
  assert.strictEqual(snapshot.deals[0].companyId, '1');
  assert.strictEqual(snapshot.managers[0].name, 'Соколова Ирина');
  assert.deepStrictEqual(snapshot.sources.find((s) => s.id === '101'), { id: '101', name: '2026.01.21 Выписка' });
  assert.strictEqual(snapshot.companyStageEvents.length, 1);
  assert.strictEqual(snapshot.portalTimezone, 'Europe/Moscow');
});

if (failed > 0) {
  console.error(`\n${failed} проверок интеграции с Битрикс24 упало`);
  process.exit(1);
}
console.log('\nПроверки интеграции с Битрикс24 пройдены');
