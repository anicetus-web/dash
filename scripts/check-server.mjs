// Проверки HTTP-каркаса: пробы жизни и готовности, конверт ответа, защита статики
// от обхода каталога, поведение при слишком большом и битом теле запроса.
// Сервер поднимается на случайном порту — проверка не занимает 3000 и не мешает разработке.
import assert from 'node:assert';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Сотрудники — во временный каталог, ДО импорта config.js (он читает окружение
// на верхнем уровне при первом импорте): иначе проверка маршрута создала бы
// настоящего администратора в боевом data/users.json.
const workDir = await mkdtemp(join(tmpdir(), 'funnel-server-'));
process.env.USERS_FILE = join(workDir, 'users.json');

const { ROOT_DIR } = await import('../src/config.js');
const { createDashboardServer, httpError, readJsonBody, resolveStaticPath, sendError, sendOk } = await import('../src/server.js');

let failed = 0;

async function check(name, run) {
  try {
    await run();
    console.log(`ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} → ${error.message}`);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const PUBLIC_DIR = join(ROOT_DIR, 'public');
const server = createDashboardServer();
const base = await listen(server);

// Сессия для проверок, которым нужно видеть маршрутизацию ЗА охраной входа —
// сама охрана (401 без сессии) проверяется отдельно, ниже, намеренно без куки.
const setupResponse = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ login: 'checkadmin', name: 'Проверка', password: 'проверочный-пароль-1' })
});
const sessionCookie = setupResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
assert.ok(sessionCookie, 'не удалось создать сессию для проверок каркаса');

// Отдельный сервер под чтение тела: маршрутов с телом запроса в каркасе ещё нет,
// а поведение readJsonBody проверять надо на настоящем сокете, а не на подделке потока.
const bodyServer = http.createServer(async (req, res) => {
  try {
    const body = await readJsonBody(req, { limit: 64 });
    sendOk(res, body);
  } catch (error) {
    sendError(res, error.status || 500, error.code || 'APP_ERROR', error.message);
  }
});
const bodyBase = await listen(bodyServer);

await check('проба жизни отделена от состояния данных', async () => {
  const [health, ready] = await Promise.all([fetch(`${base}/health`), fetch(`${base}/ready`)]);
  const body = await health.json();
  await ready.json();
  // Платформенный healthcheck не должен перезапускать контейнер из-за пустого снимка,
  // поэтому /health обязан отвечать 200 даже тогда, когда /ready честно отвечает 503.
  assert.strictEqual(health.status, 200, 'liveness обязан отвечать 200 при любом состоянии данных');
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.companiesCount, undefined, 'состояние снимка — предмет /ready, а не /health');
  assert.ok(typeof body.uptimeSec === 'number');
});

await check('готовность объявляется только при наличии данных и рабочей конфигурации', async () => {
  const response = await fetch(`${base}/ready`);
  const body = await response.json();
  const expected = !body.configDegraded && body.companiesCount > 0 && body.syncStatus !== 'error';
  assert.strictEqual(body.ready, expected, 'признак готовности выводится из состояния снимка');
  assert.strictEqual(response.status, body.ready ? 200 : 503, 'неготовность отвечает 503, а не 200');
});

await check('без входа закрытый маршрут отвечает 401, а не 404 — не выдаёт, существует ли адрес', async () => {
  const response = await fetch(`${base}/api/несуществующий-маршрут`);
  assert.strictEqual(response.status, 401);
});

await check('ответы API не кэшируются и приходят в едином конверте', async () => {
  const response = await fetch(`${base}/api/несуществующий-маршрут`, { headers: { Cookie: sessionCookie } });
  const body = await response.json();
  assert.strictEqual(response.status, 404);
  assert.strictEqual(response.headers.get('cache-control'), 'no-store', 'срез данных нельзя отдавать из кэша браузера');
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.message.length > 0, 'ошибка объясняется словами');
});

await check('запрос статики чужим методом получает понятный отказ, а не файл', async () => {
  const response = await fetch(`${base}/index.html`, { method: 'DELETE' });
  const body = await response.json();
  assert.strictEqual(response.status, 405);
  assert.strictEqual(body.error.code, 'METHOD_NOT_ALLOWED');
});

await check('обход каталога не выводит запрос за пределы public', async () => {
  // Кодированные '..' — единственный способ пронести обход через нормализацию клиента.
  const attempts = [
    '/%2e%2e/package.json',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
    '/..%5C..%5Cpackage.json',
    '/static/%2e%2e/%2e%2e/CONTEXT.md'
  ];
  for (const path of attempts) {
    const response = await fetch(`${base}${path}`);
    const text = await response.text();
    assert.notStrictEqual(response.status, 200, `${path} не должен отдавать файл`);
    assert.ok(!text.includes('"name"'), `${path} не должен раскрывать содержимое проекта`);
  }
});

await check('любой запрошенный путь разрешается внутрь public', async () => {
  const inside = ['/index.html', '/../package.json', '/../../etc/passwd.txt', '/a/b/../../c.css', '//evil.com/x.js'];
  for (const path of inside) {
    const resolved = resolveStaticPath(path);
    if (!resolved.ok) continue;
    assert.ok(
      resolved.filePath.startsWith(PUBLIC_DIR),
      `${path} разрешился за пределы public: ${resolved.filePath}`
    );
  }
});

await check('корень отдаёт стартовую страницу, а не список каталога', () => {
  const resolved = resolveStaticPath('/');
  assert.strictEqual(resolved.ok, true);
  assert.strictEqual(resolved.filePath, join(PUBLIC_DIR, 'index.html'));
  assert.strictEqual(resolved.mime, 'text/html; charset=utf-8');
});

await check('файл вне белого списка типов наружу не отдаётся', () => {
  for (const path of ['/settings.env', '/dump.sql', '/notes', '/snapshot.json.corrupt']) {
    const resolved = resolveStaticPath(path);
    assert.strictEqual(resolved.ok, false, `${path} не должен раздаваться`);
  }
  assert.strictEqual(resolveStaticPath('/app.js').mime, 'text/javascript; charset=utf-8');
  assert.strictEqual(resolveStaticPath('/styles.css').mime, 'text/css; charset=utf-8');
});

await check('битый адрес и нулевой байт отклоняются до обращения к файловой системе', () => {
  assert.strictEqual(resolveStaticPath('/%').ok, false, 'неразбираемое процентное кодирование');
  assert.strictEqual(resolveStaticPath('/index.html%00.js').ok, false, 'нулевой байт обрывает имя файла');
});

await check('слишком большое тело даёт 413 с объяснением, а не обрыв соединения', async () => {
  const response = await fetch(bodyBase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ данные: 'я'.repeat(500) })
  });
  const body = await response.json();
  assert.strictEqual(response.status, 413);
  assert.strictEqual(body.error.code, 'PAYLOAD_TOO_LARGE');
});

await check('битый JSON в теле — ошибка клиента, а не сбой сервера', async () => {
  const response = await fetch(bodyBase, { method: 'POST', body: '{ "mode": ' });
  const body = await response.json();
  assert.strictEqual(response.status, 400, 'битое тело не должно превращаться в 500');
  assert.strictEqual(body.error.code, 'BAD_JSON');
});

await check('корректное тело разбирается, пустое читается как пустой объект', async () => {
  const ok = await fetch(bodyBase, { method: 'POST', body: JSON.stringify({ mode: 'static' }) });
  assert.deepStrictEqual((await ok.json()).data, { mode: 'static' });
  const empty = await fetch(bodyBase, { method: 'POST', body: '' });
  assert.deepStrictEqual((await empty.json()).data, {});
  const notObject = await fetch(bodyBase, { method: 'POST', body: '[1,2,3]' });
  assert.strictEqual((await notObject.json()).error.code, 'BAD_JSON', 'тело обязано быть объектом запроса');
});

await check('ошибка маршрута доносится до клиента своим кодом и статусом', async () => {
  const error = httpError(422, 'BAD_PERIOD', 'Конец периода раньше начала');
  assert.strictEqual(error.status, 422);
  assert.strictEqual(error.code, 'BAD_PERIOD');
  assert.strictEqual(error.message, 'Конец периода раньше начала');
});

await close(server);
await close(bodyServer);

if (failed) {
  console.error(`\nПроверок сервера упало: ${failed}`);
  process.exit(1);
}
console.log('\nПроверки сервера пройдены');
