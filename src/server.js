// HTTP-сервер дашборда: маршрутизация без фреймворка, раздача статики, пробы жизни и готовности.
//
// Сервер намеренно тонкий: он разбирает запрос, зовёт чужую функцию и упаковывает ответ.
// Формул воронки здесь нет и не будет — они живут в расчётном модуле (инвариант 9),
// иначе интерфейс, XLSX и API рано или поздно начнут показывать разные числа.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR, config, configDegraded, configIssues } from './config.js';
import { store } from './storage/jsonStore.js';
import { createApiRoutes } from './api/routes.js';
import { createSyncService } from './sync/service.js';

const PUBLIC_DIR = join(ROOT_DIR, 'public');

// Белый список: отдаём только то, что осмысленно для веб-интерфейса.
// Файл с любым другим расширением, случайно оказавшийся в public/, наружу не уедет.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const startedAt = Date.now();

// ── Ответы ────────────────────────────────────────────────────────────────────

export function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Ответы API не кэшируются никогда: пользователь смотрит на срез данных,
    // а не на статический документ.
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

// Единый конверт успеха и ошибки — интерфейсу не приходится гадать про форму ответа.
export function sendOk(res, data) {
  json(res, 200, { success: true, data });
}

export function sendError(res, status, code, message) {
  json(res, status, { success: false, error: { code, message } });
}

export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// ── Тело запроса ──────────────────────────────────────────────────────────────

// Поток дочитывается до конца даже при превышении лимита: если оборвать чтение,
// клиент получит разрыв соединения вместо внятного 413 и не поймёт, что произошло.
// При этом лишние байты не буферизуются — переполнить память таким запросом нельзя.
export async function readJsonBody(req, { limit = config.maxRequestBodyBytes } = {}) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      overflow = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (overflow) {
    throw httpError(413, 'PAYLOAD_TOO_LARGE', `Тело запроса больше допустимых ${limit} байт`);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Битый JSON — ошибка клиента, а не сбой сервера: 400, а не 500.
    throw httpError(400, 'BAD_JSON', 'Тело запроса не является корректным JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw httpError(400, 'BAD_JSON', 'Тело запроса должно быть JSON-объектом');
  }
  return parsed;
}

// ── Статика ───────────────────────────────────────────────────────────────────

// Защита от обхода каталога двойная и намеренно избыточная: сначала нормализация
// схлопывает '..', затем проверка префикса ловит всё, что всё-таки вышло за public/.
// Одной нормализации мало: кодированные и смешанные разделители на разных ОС ведут себя по-разному.
export function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, reason: 'bad-encoding' };
  }
  if (decoded.includes('\0')) return { ok: false, status: 400, reason: 'null-byte' };

  const requested = decoded === '/' || decoded === '' ? '/index.html' : decoded;
  // Ведущие разделители и '../' срезаем, чтобы путь гарантированно был относительным.
  const relative = normalize(requested).replace(/^(?:[/\\]|\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return { ok: false, status: 403, reason: 'traversal' };
  }
  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) return { ok: false, status: 404, reason: 'mime-not-allowed' };
  return { ok: true, filePath, mime, ext };
}

async function serveStatic(req, res, url) {
  const resolved = resolveStaticPath(url.pathname);
  if (!resolved.ok) {
    const message = resolved.status === 403 ? 'Доступ запрещён' : 'Файл не найден';
    res.writeHead(resolved.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(message);
    return;
  }
  try {
    const file = await readFile(resolved.filePath);
    res.writeHead(200, {
      'Content-Type': resolved.mime,
      // Разметку не кэшируем: иначе после деплоя пользователь видит старый экран.
      'Cache-Control': resolved.ext === '.html' ? 'no-cache' : 'public, max-age=60',
      'Content-Length': file.length
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Файл не найден');
  }
}

// ── Пробы ─────────────────────────────────────────────────────────────────────

// Liveness: процесс жив. ВСЕГДА 200 и никогда не читает снимок — платформенная проба
// не должна перезапускать контейнер из-за пустых данных или сломанной синхронизации.
function handleHealth(res) {
  json(res, 200, {
    ok: true,
    build: config.buildTag,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000)
  });
}

// Readiness: приложению есть что показать. Пустой снимок — честный 503,
// это не поломка, а «данные ещё не приехали».
async function handleReady(res) {
  try {
    const snapshot = await store.getSnapshot();
    const companiesCount = Array.isArray(snapshot.companies) ? snapshot.companies.length : 0;
    const dealsCount = Array.isArray(snapshot.deals) ? snapshot.deals.length : 0;
    const syncStatus = snapshot.sync?.status || 'unknown';
    const ready = !configDegraded && companiesCount > 0 && syncStatus !== 'error';
    json(res, ready ? 200 : 503, {
      ready,
      companiesCount,
      dealsCount,
      syncStatus,
      configDegraded,
      dataSource: config.dataSource,
      snapshotAt: snapshot.updatedAt || null,
      lastSuccessAt: snapshot.sync?.lastSuccessAt || null
    });
  } catch (error) {
    // Проба готовности не имеет права отвечать 500: неготовность — это 503 с причиной.
    json(res, 503, { ready: false, reason: 'SNAPSHOT_UNREADABLE', message: error.message });
  }
}

// ── Маршруты API ──────────────────────────────────────────────────────────────

// Служба синхронизации одна на процесс: её единственность и есть защита
// от параллельных загрузок.
export const syncService = createSyncService({ store });

const routeApi = createApiRoutes({ store, sync: syncService, sendOk, httpError });

// ── Сервер ────────────────────────────────────────────────────────────────────

export function createDashboardServer() {
  return http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      sendError(res, 400, 'BAD_REQUEST', 'Некорректный адрес запроса');
      return;
    }
    // Единый catch вокруг всей маршрутизации: любой необработанный сбой обязан
    // превратиться в понятный JSON, а не в оборванное соединение.
    try {
      if (url.pathname === '/health') {
        handleHealth(res);
        return;
      }
      if (url.pathname === '/ready') {
        await handleReady(res);
        return;
      }
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (await routeApi(req, res, url)) return;
        sendError(res, 404, 'NOT_FOUND', `Маршрут ${url.pathname} не найден`);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `Метод ${req.method} для этого адреса не поддерживается`);
        return;
      }
      await serveStatic(req, res, url);
    } catch (error) {
      const status = error.status || 500;
      // Ошибка клиента — не сбой сервера. Стек здесь только зашумил бы журнал
      // и утопил настоящие проблемы: «неизвестная ступень» это неверный запрос,
      // а не поломка приложения.
      if (status >= 500) {
        console.error('[server]', error?.stack || error?.message || error);
      } else {
        console.warn(`[server] ${req.method} ${url.pathname} → ${status} ${error.code || ''}: ${error.message}`);
      }
      if (res.headersSent) {
        // Ответ уже начат — второй заголовок отправить нельзя, остаётся закрыть соединение.
        res.destroy();
        return;
      }
      // 5xx — сбой сервера, а не осознанно составленная ошибка (те везде создаются
      // через httpError()-подобные конструкторы с человеко-читаемым, безопасным
      // сообщением). Сырое error.message здесь может нести что угодно — путь на
      // диске, имя пользователя ОС — и не должно дойти до неаутентифицированного
      // клиента, хотя в лог (выше) оно уже ушло целиком.
      const clientMessage = status >= 500 ? 'Ошибка приложения' : (error.message || 'Ошибка приложения');
      sendError(res, status, error.code || 'APP_ERROR', clientMessage);
    }
  });
}

export function startServer({ port = config.port } = {}) {
  // Одиночный отвязанный отказ промиса не должен ронять процесс для всех пользователей.
  // Обработчики ставим только при реальном запуске, чтобы не глушить ошибки в проверках.
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
  });
  process.on('uncaughtException', (error) => {
    console.error('[uncaughtException]', error?.stack || error?.message || error);
  });

  const server = createDashboardServer();
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[server] порт ${port} уже занят — завершаюсь`);
      process.exit(1);
    }
    console.error('[server] ошибка сервера:', error?.stack || error?.message || error);
  });
  server.listen(port, async () => {
    const actual = server.address()?.port ?? port;

    // Пустой снимок при старте — обычная ситуация первого запуска. Ждать
    // планового тика десять минут незачем: наполняем сразу, чтобы дашборд
    // открывался с данными, а не с пустым экраном.
    try {
      const snapshot = await store.getSnapshot();
      if ((snapshot.companies?.length || 0) === 0) {
        console.log('[sync] снимок пуст — выполняю первичное наполнение');
        const { promise } = syncService.run();
        const result = await promise;
        if (result?.ok) {
          console.log(`[sync] снимок готов: компаний ${result.companies}, сделок ${result.deals}`);
        } else if (result?.error) {
          console.warn(`[sync] первичное наполнение не удалось: ${result.error}`);
        }
      }
    } catch (error) {
      console.warn('[sync] первичное наполнение пропущено:', error?.message || error);
    }

    syncService.start({ immediate: false });
    // Замечания к конфигурации уже напечатаны при её чтении — здесь только напоминаем итог,
    // чтобы одна и та же строка не дублировалась в журнале запуска.
    const degraded = configIssues.length > 0 ? `, замечаний к конфигурации: ${configIssues.length}` : '';
    console.log(
      `Дашборд воронки продаж слушает http://localhost:${actual} (источник данных: ${config.dataSource}${degraded})`
    );
  });
  return server;
}

// Запускаемся только при прямом вызове `node src/server.js`; при импорте из проверок — нет.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryPoint) startServer();
