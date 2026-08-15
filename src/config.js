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
function num(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const value = raw(name);
  if (value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    note(`${name}="${value}" — не число, беру дефолт ${fallback}`);
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

export const config = {
  // ── Сервер ──
  buildTag: text('BUILD_TAG', 'dev'),
  port: num('PORT', 3000, { min: 0, max: 65535 }),
  maxRequestBodyBytes: num('MAX_REQUEST_BODY_BYTES', 1024 * 1024, { min: 1024 }),

  // ── Данные ──
  // 'demo' — детерминированный генератор снимка, 'bitrix' — реальный портал за адаптером.
  dataSource: oneOf('DATA_SOURCE', ['demo', 'bitrix'], 'demo'),
  // Границы периодов считаются в поясе портала, а не в UTC (инвариант 11).
  portalTimezone: timezone('PORTAL_TIMEZONE', 'Europe/Moscow'),
  snapshotFile: text('SNAPSHOT_FILE', 'data/snapshot.json'),
  demoSeed: num('DEMO_SEED', 20260815, { min: 1 }),

  // ── Синхронизация ──
  syncEnabled: flag('SYNC_ENABLED', true),
  syncIntervalMs: num('SYNC_INTERVAL_MS', 10 * 60 * 1000, { min: 60 * 1000 }),
  snapshotStaleAfterMs: num('SNAPSHOT_STALE_AFTER_MS', 30 * 60 * 1000, { min: 60 * 1000 }),

  // ── Битрикс24 ──
  // Ключ живёт только здесь, на сервере. В ответы API и в браузер не попадает никогда.
  bitrixApiKey: text('BITRIX_API_KEY'),
  bitrixApiBase: withoutTrailingSlash(text('BITRIX_API_BASE', 'https://vibecode.bitrix24.tech/v1')),
  bitrixPortalUrl: withoutTrailingSlash(text('BITRIX_PORTAL_URL', 'https://example.bitrix24.ru')),
  bitrixTimeoutMs: num('BITRIX_TIMEOUT_MS', 20000, { min: 1000 })
};

// Ключ отсутствует, хотя выбран реальный источник, — приложение поднимется, но данных не получит.
// В демо-режиме ключ не нужен, и его отсутствие деградацией не считается.
export const bitrixKeyMissing = !config.bitrixApiKey;
export const configDegraded = config.dataSource === 'bitrix' && bitrixKeyMissing;

if (configDegraded) {
  note('DATA_SOURCE=bitrix, но BITRIX_API_KEY пуст — синхронизация невозможна, /ready вернёт 503');
}
if (config.dataSource === 'bitrix' && config.bitrixPortalUrl === 'https://example.bitrix24.ru') {
  note('BITRIX_PORTAL_URL не задан — ссылки на карточки поведут на заглушку example.bitrix24.ru');
}

// Копия, чтобы вызывающий код не мог дописать в список замечаний своё.
export const configIssues = Object.freeze([...issues]);
