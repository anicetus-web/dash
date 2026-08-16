/**
 * Интеграционные проверки HTTP-слоя.
 *
 * Поднимают настоящий сервер на свободном порту с изолированным снимком
 * и ходят по нему настоящими запросами. Расчёт проверяется в check-funnel.mjs;
 * здесь проверяется контракт: коды ответов, форма конверта, поведение при
 * неверных параметрах и согласованность агрегата с детализацией по сети.
 *
 * Контракт: docs/api-contract.md
 */

import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Изолируем снимок ДО импорта модулей: конфигурация читается на верхнем уровне,
// и подмена переменной после импорта уже ни на что не повлияет.
const workDir = await mkdtemp(join(tmpdir(), 'funnel-http-'));
process.env.SNAPSHOT_FILE = join(workDir, 'snapshot.json');
// Сотрудники — тоже во временный каталог: проверки не должны ни читать,
// ни портить настоящий файл учётных записей.
process.env.USERS_FILE = join(workDir, 'users.json');
process.env.DATA_SOURCE = 'demo';
process.env.SYNC_ENABLED = 'false';
process.env.BITRIX_PORTAL_URL = 'https://portal.example.bitrix24.ru';

const { createDashboardServer } = await import('../src/server.js');
const { store } = await import('../src/storage/jsonStore.js');
const { generateDemoSnapshot } = await import('../src/demo/generator.js');

const NOW = new Date('2026-08-15T12:00:00.000Z');

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

// ── Подготовка ────────────────────────────────────────────────────────────────

const snapshot = generateDemoSnapshot({ seed: 20260815, now: NOW, timeZone: 'Europe/Moscow' });
await store.save({
  ...snapshot,
  source: 'demo',
  sync: {
    status: 'success',
    lastStartedAt: NOW.toISOString(),
    lastSuccessAt: NOW.toISOString(),
    lastError: null,
    warnings: []
  }
});

const server = createDashboardServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// Все маршруты API закрыты входом, поэтому проверки контракта работают
// из-под настоящей сессии — так же, как реальный интерфейс. Отдельная проверка
// «без входа отвечает 401» идёт ниже: она сознательно ходит БЕЗ этой куки.
const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: 'checkadmin', name: 'Проверка', password: 'проверочный-пароль-1' })
});
const sessionCookie = setup.headers.get('set-cookie')?.split(';')[0] ?? '';
assert.ok(sessionCookie, 'не удалось создать сессию для проверок');

/** Запрос с разбором конверта. Возвращает и статус, и тело — оба проверяются. */
async function api(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { Cookie: sessionCookie, ...(options.headers || {}) }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`ответ не JSON: ${text.slice(0, 120)}`);
  }
  return { status: response.status, body, headers: response.headers };
}

const YEAR = 'mode=static&periodType=year&periodValue=2026';

// ── Пробы ─────────────────────────────────────────────────────────────────────

await check('/health отвечает 200 и не читает снимок', async () => {
  const response = await fetch(`${base}/health`);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.ok, true);
  // Проба живости намеренно без конверта: её читают платформенные механизмы.
  assert.strictEqual(body.success, undefined);
});

await check('/ready отвечает 200 при наполненном снимке', async () => {
  const response = await fetch(`${base}/ready`);
  assert.strictEqual(response.status, 200);
  const body = await response.json();
  assert.strictEqual(body.ready, true);
  assert.ok(body.companiesCount > 0);
});

// ── Конверт и ошибки ──────────────────────────────────────────────────────────

await check('успешный ответ приходит в конверте {success, data}', async () => {
  const { status, body } = await api(`/api/dashboard?${YEAR}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.success, true);
  assert.ok(body.data && typeof body.data === 'object');
});

await check('ответы API не кэшируются', async () => {
  const { headers } = await api(`/api/dashboard?${YEAR}`);
  assert.match(headers.get('cache-control') || '', /no-store/);
});

await check('несуществующий маршрут API даёт 404 в конверте ошибки', async () => {
  const { status, body } = await api('/api/такого-нет');
  assert.strictEqual(status, 404);
  assert.strictEqual(body.success, false);
  assert.ok(body.error.message, 'ошибка без сообщения бесполезна пользователю');
});

await check('«Вся история» в Динамике отклоняется с внятным кодом', async () => {
  const { status, body } = await api('/api/dashboard?mode=dynamic&periodType=allHistory');
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error.code, 'ALL_HISTORY_REQUIRES_STATIC');
});

await check('«Вся история» в Статике принимается', async () => {
  const { status, body } = await api('/api/dashboard?mode=static&periodType=allHistory');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.appliedRequest.period.type, 'allHistory');
});

await check('неизвестная ступень детализации даёт 400, а не пустой список', async () => {
  const { status, body } = await api(`/api/details?${YEAR}&stageRole=нет-такой`);
  assert.strictEqual(status, 400);
  assert.strictEqual(body.error.code, 'BAD_STAGE');
});

await check('битый тип периода не роняет запрос, а откатывается к кварталу', async () => {
  const { status, body } = await api('/api/dashboard?periodType=что-то-не-то');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.appliedRequest.period.type, 'quarter');
});

await check('синхронизация запускается только методом POST', async () => {
  const { status, body } = await api('/api/sync');
  assert.strictEqual(status, 405);
  assert.strictEqual(body.error.code, 'METHOD_NOT_ALLOWED');
});

// ── Форма ответа дашборда ─────────────────────────────────────────────────────

await check('ответ дашборда содержит все обязательные разделы контракта', async () => {
  const { body } = await api(`/api/dashboard?${YEAR}`);
  const data = body.data;
  for (const key of ['appliedRequest', 'freshness', 'stages', 'primaryConversion', 'totals', 'warnings']) {
    assert.ok(key in data, `в ответе нет раздела «${key}»`);
  }
  assert.ok(data.appliedRequest.period.timeZone, 'период без часового пояса');
});

await check('стык встречается ровно один раз и несёт два счётчика', async () => {
  const { body } = await api(`/api/dashboard?${YEAR}`);
  const junctions = body.data.stages.filter((stage) => stage.junction);
  assert.strictEqual(junctions.length, 1);
  assert.strictEqual(typeof junctions[0].companyCount, 'number');
  assert.strictEqual(junctions[0].unit, 'deal', 'после стыка единица учёта — сделка');
});

await check('единица учёта меняется на стыке ровно один раз', async () => {
  const { body } = await api(`/api/dashboard?${YEAR}`);
  const units = body.data.stages.map((stage) => stage.unit);
  const switches = units.filter((unit, i) => i > 0 && unit !== units[i - 1]).length;
  assert.strictEqual(switches, 1, `единица учёта меняется ${switches} раз вместо одного`);
});

await check('справочники содержат «Не указано» последним значением', async () => {
  const { body } = await api('/api/reference');
  for (const key of ['sources', 'kevFormats']) {
    const list = body.data[key];
    assert.ok(list.length > 0, `справочник «${key}» пуст`);
    assert.strictEqual(list.at(-1).id, '__none__', `в справочнике «${key}» «Не указано» не последнее`);
  }
});

// ── Согласованность слоёв ─────────────────────────────────────────────────────

await check('число каждой ступени совпадает с детализацией по сети', async () => {
  const { body } = await api(`/api/dashboard?${YEAR}`);
  for (const stage of body.data.stages) {
    const details = await api(`/api/details?${YEAR}&stageRole=${stage.role}&pageSize=500`);
    assert.strictEqual(
      details.body.data.count, stage.count,
      `ступень «${stage.name}»: агрегат ${stage.count}, детализация ${details.body.data.count}`
    );
  }
});

await check('постраничность не меняет общее количество', async () => {
  const first = await api(`/api/details?${YEAR}&stageRole=proposalSent&pageSize=10&page=1`);
  const second = await api(`/api/details?${YEAR}&stageRole=proposalSent&pageSize=10&page=2`);
  assert.strictEqual(first.body.data.count, second.body.data.count);
  assert.ok(first.body.data.pageCount > 1);
  const firstIds = first.body.data.rows.map((row) => row.id);
  const secondIds = second.body.data.rows.map((row) => row.id);
  // Страницы не должны пересекаться: иначе часть сущностей не увидеть никогда.
  assert.strictEqual(firstIds.filter((id) => secondIds.includes(id)).length, 0, 'страницы пересекаются');
});

await check('фильтры внутри модалки детализации доходят от строки запроса до ответа', async () => {
  const full = await api(`/api/details?${YEAR}&stageRole=proposalSent&pageSize=500`);
  assert.ok(full.body.data.rows.length > 1, 'нужно хотя бы 2 строки, иначе сузить нечем');
  assert.strictEqual(full.body.data.totalCount, full.body.data.count, 'без фильтров count и totalCount совпадают');

  const targetManagerId = full.body.data.rows[0].managerId;
  const filtered = await api(
    `/api/details?${YEAR}&stageRole=proposalSent&pageSize=500&detailManagerIds=${encodeURIComponent(targetManagerId)}`
  );
  assert.ok(filtered.body.data.count > 0, 'у выбранного менеджера должна остаться хотя бы одна строка');
  assert.ok(filtered.body.data.count <= full.body.data.count, 'фильтр не должен УВЕЛИЧИВАТЬ список');
  assert.strictEqual(
    filtered.body.data.totalCount, full.body.data.count,
    'totalCount — это count ступени ДО фильтра детализации, не меняется вместе с ним'
  );
  for (const row of filtered.body.data.rows) {
    assert.strictEqual(row.managerId, targetManagerId, 'в отфильтрованном списке не должно быть чужого менеджера');
  }
});

await check('строки детализации ведут на карточки портала и не содержат контактов', async () => {
  const { body } = await api(`/api/details?${YEAR}&stageRole=proposalSent&pageSize=5`);
  const rows = body.data.rows;
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.match(row.url || '', /^https:\/\/portal\.example\.bitrix24\.ru\/crm\/deal\/details\//);
    for (const key of Object.keys(row)) {
      assert.ok(
        !/phone|email|comment|contact/i.test(key),
        `в строке детализации контактное поле «${key}»`
      );
    }
  }
});

await check('фильтр КЭВ сужает воронку сделок и не трогает воронку компаний', async () => {
  const reference = await api('/api/reference');
  const kev = reference.body.data.kevFormats.find((item) => item.id !== '__none__');
  const all = await api(`/api/dashboard?${YEAR}`);
  const filtered = await api(`/api/dashboard?${YEAR}&kevFormats=${encodeURIComponent(kev.id)}`);
  const pick = (response, role) => response.body.data.stages.find((stage) => stage.role === role).count;

  assert.strictEqual(pick(all, 'takenToWork'), pick(filtered, 'takenToWork'), 'фильтр КЭВ обнулил первую воронку');
  assert.ok(pick(filtered, 'proposalSent') < pick(all, 'proposalSent'), 'фильтр КЭВ не сузил вторую воронку');
});

await check('пустой фильтр означает «все значения»', async () => {
  const all = await api(`/api/dashboard?${YEAR}`);
  const empty = await api(`/api/dashboard?${YEAR}&sourceIds=&managerIds=`);
  assert.strictEqual(
    empty.body.data.stages[1].count,
    all.body.data.stages[1].count,
    'пустой фильтр отсёк сущности вместо того, чтобы пропустить все'
  );
});

await check('фильтр по несуществующему источнику даёт пустой результат, а не ошибку', async () => {
  const { status, body } = await api(`/api/dashboard?${YEAR}&sourceIds=нет-такого-источника`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.data.stages.every((stage) => stage.count === 0), true);
  assert.strictEqual(body.data.filtersActive, true, 'дашборд обязан знать, что результат пуст из-за фильтров');
});

// ── Состояние синхронизации ───────────────────────────────────────────────────

await check('состояние синхронизации отдаёт свежесть и количества', async () => {
  const { status, body } = await api('/api/sync-status');
  assert.strictEqual(status, 200);
  assert.ok(body.data.lastSuccessAt);
  assert.ok(body.data.counts.companies > 0);
  assert.strictEqual(typeof body.data.stale, 'boolean');
});

await check('ключ доступа к Битриксу не появляется ни в одном ответе', async () => {
  // Подкладываем заведомо узнаваемое значение и проверяем, что оно не утекло.
  const secret = 'СЕКРЕТНЫЙ-КЛЮЧ-НЕ-ДОЛЖЕН-УТЕЧЬ';
  process.env.BITRIX_API_KEY = secret;
  for (const path of [`/api/dashboard?${YEAR}`, '/api/reference', '/api/sync-status', '/ready']) {
    const response = await fetch(base + path);
    const text = await response.text();
    assert.ok(!text.includes(secret), `ключ найден в ответе ${path}`);
  }
  delete process.env.BITRIX_API_KEY;
});

// ── Статика ───────────────────────────────────────────────────────────────────

// ── Охрана входа ──────────────────────────────────────────────────────────────
// Эти проверки НАМЕРЕННО ходят без сессионной куки: они и есть проверка того,
// что закрыто именно всё, а не только то, что вспомнили закрыть.

await check('без входа закрыты ВСЕ маршруты данных, а не только некоторые', async () => {
  const guarded = [
    `/api/dashboard?${YEAR}`,
    `/api/details?${YEAR}&stageRole=takenToWork`,
    `/api/export.xlsx?${YEAR}`,
    '/api/reference',
    '/api/sync-status',
    '/api/auth/users',
    '/api/auth/avatar'
  ];
  for (const path of guarded) {
    const response = await fetch(base + path);
    assert.strictEqual(response.status, 401, `${path} отдаётся без входа`);
  }
});

await check('без входа нельзя запустить синхронизацию', async () => {
  const response = await fetch(`${base}/api/sync`, { method: 'POST' });
  assert.strictEqual(response.status, 401);
});

await check('повторное создание администратора отклоняется', async () => {
  const response = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'second', password: 'пароль-второго-админа' })
  });
  assert.strictEqual(response.status, 409, 'открытый маршрут создания администратора остался доступен');
});

await check('сотрудник не может управлять сотрудниками', async () => {
  const created = await api('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Пётр Петров' })
  });
  assert.strictEqual(created.status, 200);
  // Логин выведен из имени транслитерацией, без ручного ввода.
  assert.strictEqual(created.body.data.user.login, 'petr.petrov');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'petr.petrov', password: created.body.data.password })
  });
  assert.strictEqual(login.status, 200, 'сотрудник не смог войти выданным паролем');
  const employeeCookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await fetch(`${base}/api/dashboard?${YEAR}`, { headers: { Cookie: employeeCookie } });
  assert.strictEqual(dashboard.status, 200, 'сотруднику дашборд должен быть доступен');

  const staff = await fetch(`${base}/api/auth/users`, { headers: { Cookie: employeeCookie } });
  assert.strictEqual(staff.status, 403, 'сотрудник получил доступ к управлению сотрудниками');
});

// 1×1 прозрачный PNG — реальный, валидный файл, не просто похожая на него строка.
const TINY_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

await check('своя аватарка: загрузка, отражение в /api/auth/me, удаление', async () => {
  const uploaded = await api('/api/auth/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarDataUrl: TINY_PNG })
  });
  assert.strictEqual(uploaded.status, 200);
  assert.strictEqual(uploaded.body.data.user.avatarDataUrl, TINY_PNG);

  const me = await api('/api/auth/me');
  assert.strictEqual(me.body.data.user.avatarDataUrl, TINY_PNG, 'аватарка должна быть видна сразу после загрузки');

  const removed = await api('/api/auth/avatar', { method: 'DELETE' });
  assert.strictEqual(removed.status, 200);
  assert.strictEqual(removed.body.data.user.avatarDataUrl, null, 'после удаления аватарки не должно остаться следа');
});

await check('аватарка отклоняет не-изображение и не-data-URL', async () => {
  const notImage = await api('/api/auth/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarDataUrl: 'data:text/plain;base64,aGVsbG8=' })
  });
  assert.strictEqual(notImage.status, 400);

  const notDataUrl = await api('/api/auth/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarDataUrl: 'https://example.com/avatar.png' })
  });
  assert.strictEqual(notDataUrl.status, 400, 'ссылка на внешний файл — не то же самое, что данные изображения');
});

await check('аватарка отклоняет слишком большой файл', async () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(300_001);
  const response = await api('/api/auth/avatar', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ avatarDataUrl: huge })
  });
  assert.strictEqual(response.status, 400);
});

await check('интерфейс отдаётся с корневого адреса', async () => {
  const response = await fetch(base + '/');
  assert.strictEqual(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  const html = await response.text();
  assert.match(html, /design-tokens\.css/);
  assert.match(html, /app\.js/);
});

await check('обход каталога наружу не выпускает', async () => {
  for (const path of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/package.json']) {
    const response = await fetch(base + path);
    assert.ok(response.status >= 400, `путь ${path} не заблокирован (${response.status})`);
    const text = await response.text();
    assert.ok(!text.includes('"name"'), `через ${path} утёк package.json`);
  }
});

await check('файл с недопустимым расширением наружу не отдаётся', async () => {
  const response = await fetch(base + '/../.env');
  assert.ok(response.status >= 400);
});

// ── Завершение ────────────────────────────────────────────────────────────────

await new Promise((resolve) => server.close(resolve));
await rm(workDir, { recursive: true, force: true });

if (failed > 0) {
  console.error(`\n${failed} проверок HTTP-слоя упало`);
  process.exit(1);
}
console.log('\nПроверки HTTP-слоя пройдены');
