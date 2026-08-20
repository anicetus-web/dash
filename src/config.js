// Единственное место чтения окружения. Остальной код берёт значения отсюда и
// process.env не трогает — иначе дефолты расползаются по файлам и расходятся.
//
// Принцип: битое значение НЕ роняет старт. Приложение обязано подниматься даже с кривым
// окружением, честно сообщая о проблеме: сервер, который не стартовал, диагностировать нечем.
import { fileURLToPath } from 'node:url';

// Корень проекта: config.js лежит в src/, значит '..' — каталог репозитория.
export const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

// Замечания к конфигурации на человеческом языке: печатаются при старте сервера
// и доступны коду (например, для блока предупреждений в интерфейсе).
const issues = [];

function note(message) {
  issues.push(message);
  console.warn(`[config] ${message}`);
}

function raw(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

// Числовой параметр: нечисловое или выходящее за границы значение логируется
// и заменяется дефолтом. NaN не должен утечь в setTimeout или в предел размера тела.
// Дробное значение там, где по смыслу нужно целое (порт, миллисекунды, счётчики),
// не менее опасно: PORT=3000.5 проходит проверку диапазона молча, а затем роняет
// server.listen() с RangeError уже после старта — и делает это с exit code 0,
// который системы оркестрации читают как чистое завершение, а не падение.
function num(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, integer = false } = {}) {
  const value = raw(name);
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    note(`${name}="${value}" — не число, беру дефолт ${fallback}`);
    return fallback;
  }
  if (integer && !Number.isInteger(parsed)) {
    note(`${name}=${parsed} — должно быть целым числом, беру дефолт ${fallback}`);
    return fallback;
  }
  if (parsed < min || parsed > max) {
    note(`${name}=${parsed} — вне допустимого диапазона [${min}; ${max}], беру дефолт ${fallback}`);
    return fallback;
  }
  return parsed;
}

function text(name, fallback = '') {
  const value = raw(name);
  return value === '' ? fallback : value;
}

// Флаг: принимаем и «1/0», и словесные формы. Непонятное значение — дефолт с замечанием.
function flag(name, fallback) {
  const value = raw(name).toLowerCase();
  if (value === '') return fallback;
  if (['1', 'true', 'yes', 'on', 'да'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'нет'].includes(value)) return false;
  note(`${name}="${value}" — не похоже на да/нет, беру дефолт ${fallback ? '1' : '0'}`);
  return fallback;
}

function oneOf(name, allowed, fallback) {
  const value = raw(name).toLowerCase();
  if (value === '') return fallback;
  if (allowed.includes(value)) return value;
  note(`${name}="${value}" — допустимо только ${allowed.join(' | ')}, беру дефолт ${fallback}`);
  return fallback;
}

// Часовой пояс проверяем через Intl: неизвестное имя ловится здесь, а не в расчёте периодов,
// где оно превратилось бы в исключение посреди запроса пользователя.
function timezone(name, fallback) {
  const value = raw(name);
  if (value === '') return fallback;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: value });
    return value;
  } catch {
    note(`${name}="${value}" — неизвестный часовой пояс, беру дефолт ${fallback}`);
    return fallback;
  }
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/**
 * Адрес портала по умолчанию — заведомо несуществующий домен-заглушка.
 *
 * Экспортируется, потому что на него смотрит не только предупреждение ниже:
 * построение ссылок на карточки CRM (`src/analytics/details.js`) обязано
 * ОТКЛЮЧАТЬ ссылку, пока адрес не задан. Иначе каждая строка детализации
 * ведёт на мёртвый example.bitrix24.ru, и это выглядит как сломанная ссылка,
 * а не как ненастроенный портал.
 */
export const PLACEHOLDER_PORTAL_URL = 'https://example.bitrix24.ru';

export const config = {
  // ── Сервер ──
  buildTag: text('BUILD_TAG', 'dev'),
  port: num('PORT', 3000, { min: 0, max: 65535, integer: true }),
  maxRequestBodyBytes: num('MAX_REQUEST_BODY_BYTES', 1024 * 1024, { min: 1024, integer: true }),

  // ── Данные ──
  // 'demo' — детерминированный генератор снимка, 'bitrix' — реальный портал за адаптером.
  dataSource: oneOf('DATA_SOURCE', ['demo', 'bitrix'], 'demo'),
  // Границы периодов считаются в поясе портала, а не в UTC (инвариант 11).
  portalTimezone: timezone('PORTAL_TIMEZONE', 'Europe/Moscow'),
  snapshotFile: text('SNAPSHOT_FILE', 'data/snapshot.json'),
  // Сотрудники и сессии — ОТДЕЛЬНЫМ файлом от снимка: снимок целиком заменяется
  // при каждой синхронизации, и учётные записи в нём стирались бы каждые 10 минут.
  usersFile: text('USERS_FILE', 'data/users.json'),
  // Ставить ли флаг Secure на куку сессии. За HTTPS (боевой режим) — обязательно;
  // на голом HTTP с ним кука не сохранится вовсе и вход перестанет работать,
  // поэтому по умолчанию выключено, а в DEPLOY.md прописано включить.
  cookieSecure: flag('COOKIE_SECURE', false),
  demoSeed: num('DEMO_SEED', 20260815, { min: 1, integer: true }),
  // Автосоздание первого администратора при пустом data/users.json — для PaaS
  // с эфемерным диском (Render/Railway на бесплатном плане), где том стирается
  // при каждом пересоздании контейнера и экран первого запуска иначе всплывал
  // бы заново после каждого сна/редеплоя. На постоянном диске (VPS) не нужно:
  // там экран первого запуска и так появляется РОВНО один раз, при первом
  // разворачивании. Пусто по умолчанию — тогда поведение не меняется никак.
  bootstrapAdminLogin: text('BOOTSTRAP_ADMIN_LOGIN'),
  bootstrapAdminPassword: text('BOOTSTRAP_ADMIN_PASSWORD'),
  bootstrapAdminName: text('BOOTSTRAP_ADMIN_NAME', 'Администратор'),

  // ── Синхронизация ──
  syncEnabled: flag('SYNC_ENABLED', true),
  // Раз в три часа, а не раз в десять минут. Полный заход перечитывает журнал
  // переходов целиком — под 350 страниц, — и на боевом портале такой ритм привёл
  // к блокировке REST со стороны Битрикса (OVERLOAD_LIMIT). Данные воронки
  // меняются медленнее, чем раз в десять минут, а цена ошибки — отключённый
  // портал у всего отдела продаж, а не только у дашборда.
  syncIntervalMs: num('SYNC_INTERVAL_MS', 3 * 60 * 60 * 1000, { min: 60 * 1000, integer: true }),
  snapshotStaleAfterMs: num('SNAPSHOT_STALE_AFTER_MS', 30 * 60 * 1000, { min: 60 * 1000, integer: true }),

  // ── Битрикс24 ──
  // Ключ живёт только здесь, на сервере. В ответы API и в браузер не попадает никогда.
  bitrixApiKey: text('BITRIX_API_KEY'),
  bitrixApiBase: withoutTrailingSlash(text('BITRIX_API_BASE', 'https://vibecode.bitrix24.tech/v1')),
  bitrixPortalUrl: withoutTrailingSlash(text('BITRIX_PORTAL_URL', PLACEHOLDER_PORTAL_URL)),
  bitrixTimeoutMs: num('BITRIX_TIMEOUT_MS', 20000, { min: 1000, integer: true }),
  // На сколько лет назад забирать компании и сделки. «Вся история выбранных баз»
  // (Статика) не должна упираться в произвольно короткую глубину синхронизации.
  bitrixHistoryYears: num('BITRIX_HISTORY_YEARS', 4, { min: 1, max: 15, integer: true }),
  // Сколько веток выборки опрашивать параллельно. Выше — быстрее синк, но больше
  // нагрузка на портал и выше риск упереться в троттлинг прокси.
  bitrixFetchConcurrency: num('BITRIX_FETCH_CONCURRENCY', 4, { min: 1, max: 16, integer: true }),
  // Минимальный промежуток между началами запросов к порталу. Портал держит
  // 10 запросов в секунду; 150 мс дают около семи и оставляют запас другим
  // приложениям портала. Ноль допустим только в проверках.
  bitrixMinRequestIntervalMs: num('BITRIX_MIN_REQUEST_INTERVAL_MS', 150, { min: 0, integer: true })
};

// Ключ отсутствует, хотя выбран реальный источник, — приложение поднимется, но данных не получит.
// В демо-режиме ключ не нужен, и его отсутствие деградацией не считается.
export const bitrixKeyMissing = !config.bitrixApiKey;
export const configDegraded = config.dataSource === 'bitrix' && bitrixKeyMissing;

if (configDegraded) {
  note('DATA_SOURCE=bitrix, но BITRIX_API_KEY пуст — синхронизация невозможна, /ready вернёт 503');
}
if (config.dataSource === 'bitrix' && config.bitrixPortalUrl === PLACEHOLDER_PORTAL_URL) {
  note('BITRIX_PORTAL_URL не задан — ссылки на карточки поведут на заглушку example.bitrix24.ru');
}
// Не блокирует старт (ключ мог быть намеренно тестовым), но короткий ключ —
// почти наверняка опечатка: настоящие ключи Битрикс24 на порядок длиннее,
// и предупредить об этом дешевле, чем потом объяснять сетевые 401.
if (config.bitrixApiKey && config.bitrixApiKey.length < 12) {
  note(`BITRIX_API_KEY подозрительно короткий (${config.bitrixApiKey.length} симв.) — похоже на опечатку`);
}

// Копия, чтобы вызывающий код не мог дописать в список замечаний своё.
export const configIssues = Object.freeze([...issues]);
