/**
 * HTTP-клиент к VibeCode API Битрикс24.
 *
 * Единственное место в проекте, где происходит сетевой вызов к порталу. Отсюда
 * четыре обязательства, которым подчинён весь файл:
 *
 *  1. КЛЮЧ НЕ УТЕКАЕТ. Ключ читается только из серверной конфигурации, уходит
 *     исключительно в заголовок запроса и вычищается из любого текста ошибки.
 *     Отсутствие ключа — внятная ошибка ДО сетевого вызова, а не «fetch failed».
 *  2. ЗАПРОС ВСЕГДА ЗАВЕРШАЕТСЯ. На каждый запрос свой `AbortController` с таймаутом:
 *     зависший прокси не должен подвесить синхронизацию навсегда.
 *  3. ОТВЕТ-НЕ-JSON — ЭТО ОШИБКА, А НЕ ИСКЛЮЧЕНИЕ. Шлюз при таймауте отдаёт HTML-страницу;
 *     она обязана превратиться в ошибку с понятным текстом, а не в `SyntaxError` из JSON.parse.
 *  4. ДАННЫЕ НЕ ОБРЕЗАЮТСЯ МОЛЧА. Выборка постраничная: клиент идёт по курсору или
 *     смещению до конца, а упёршись в предохранитель — честно помечает выборку неполной.
 *
 * Ошибки упакованы единообразно: `code`, `status`, `retryable`. Признак `retryable`
 * ставится ЗДЕСЬ, потому что только здесь известна природа сбоя; вызывающий код
 * не должен угадывать её по тексту сообщения.
 */

import { config } from '../config.js';

/** Коды ошибок клиента. Различают природу сбоя, а не место в коде. */
export const BITRIX_ERROR_CODES = Object.freeze({
  /** Ключ не задан: сетевого вызова не было. */
  noApiKey: 'NO_API_KEY',
  /** Истёк таймаут запроса. */
  timeout: 'API_TIMEOUT',
  /** Сеть не дала ответа: DNS, обрыв соединения, отказ в подключении. */
  network: 'API_NETWORK',
  /** Ответ пришёл, но это не JSON (типично — HTML-страница шлюза). */
  badResponse: 'API_BAD_RESPONSE',
  /** Портал ответил ошибкой: HTTP-код или `success: false` в конверте. */
  api: 'API_ERROR',
  /** Выборка упёрлась в предохранитель постраничности. */
  paginationLimit: 'API_PAGINATION_LIMIT'
});

/** Заголовок с ключом. Вынесен константой, чтобы имя нельзя было разойтись по файлам. */
const API_KEY_HEADER = 'X-Api-Key';

/** Сетевые коды, при которых повтор имеет смысл. */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'
]);

/** HTTP-коды, при которых повтор имеет смысл: перегрузка и временная недоступность. */
function isRetryableStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return false;
  return code === 408 || code === 425 || code === 429 || code >= 500;
}

/**
 * Ошибка обращения к порталу в единой упаковке.
 * `retryable` — свойство самой ошибки, а не решение вызывающего кода.
 */
export function bitrixError(message, { code, status = null, retryable = false, cause = null } = {}) {
  const error = new Error(message);
  error.code = code || BITRIX_ERROR_CODES.api;
  error.status = status;
  error.retryable = Boolean(retryable);
  if (cause) error.cause = cause;
  return error;
}

/** Ошибка — истёкший таймаут (наш или прокси, сообщившего о своём). */
export function isTimeoutError(error) {
  if (!error) return false;
  if (error.code === BITRIX_ERROR_CODES.timeout) return true;
  return /tim(?:e|ed)\s*out|timeout|таймаут/i.test(String(error.message || ''));
}

/**
 * Ошибку имеет смысл повторить: сеть, таймаут, 5xx, перегрузка.
 * Бизнес-ошибка (404, 400, «сущность не найдена») повтору НЕ подлежит:
 * повторять её — терять время синхронизации на заведомо тот же ответ.
 */
export function isRetryableError(error) {
  if (!error) return false;
  if (error.code === BITRIX_ERROR_CODES.noApiKey) return false;
  if (typeof error.retryable === 'boolean') return error.retryable;
  if (isTimeoutError(error)) return true;
  if (isRetryableStatus(error.status)) return true;
  const code = error.code || error.cause?.code;
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  return /fetch failed|socket hang up|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(error.message || ''));
}

/** Вырезает ключ из текста: он не должен попасть ни в лог, ни в ответ API. */
export function redactApiKey(text, apiKey) {
  const value = String(text ?? '');
  // Длина ключа НЕ освобождает от редактирования: живой секрет, утёкший в
  // клиентский ответ, опаснее редкого случайного совпадения короткой строки.
  if (!apiKey) return value;
  return value.split(apiKey).join('***');
}

/**
 * Короткая выдержка из не-JSON ответа: теги вырезаны, пробелы схлопнуты, длина обрезана.
 * Нужна, чтобы по сообщению было видно, ЧТО пришло (страница шлюза, текст ошибки прокси),
 * и при этом ошибка не тащила в лог килобайт HTML.
 */
export function responseExcerpt(text, limit = 160) {
  const clean = String(text ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return 'пустой ответ';
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

const sleepDefault = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

/**
 * Повтор с экспоненциальной задержкой ТОЛЬКО для повторяемых ошибок.
 * Бизнес-ошибка выбрасывается сразу — иначе синхронизация тратит попытки впустую.
 *
 * @param {Function} task   (attempt) => Promise
 * @param {object}   options attempts, baseDelayMs, maxDelayMs, sleep, onRetry
 */
export async function withRetry(task, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 3);
  const baseDelayMs = Number(options.baseDelayMs) || 300;
  const maxDelayMs = Number(options.maxDelayMs) || 4000;
  const sleep = options.sleep || sleepDefault;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      options.onRetry?.(error, attempt);
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/** Массив записей из конверта ответа, в каком бы виде портал его ни отдал. */
export function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const candidate of [body.data, body.items, body.result, body.rows]) {
    if (Array.isArray(candidate)) return candidate;
  }
  const data = body.data;
  if (data && typeof data === 'object') {
    for (const candidate of [data.items, data.result, data.rows, data.list]) {
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

/**
 * Курсор следующей страницы или `null`. Портал может назвать его по-разному —
 * перебираем известные написания, чтобы постраничность не отвалилась от переименования поля.
 */
export function nextCursorOf(body) {
  if (!body || typeof body !== 'object') return null;
  const holders = [body, body.paging, body.pagination, (body.data && !Array.isArray(body.data) ? body.data : null)];
  const keys = ['next', 'nextStart', 'nextCursor', 'cursor', 'nextPageToken', 'offset'];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of keys) {
      const value = holder[key];
      if (value === undefined || value === null || value === '' || value === false) continue;
      return String(value);
    }
  }
  return null;
}

/** Общее число записей, если портал его сообщает. Иначе `null`. */
export function totalOf(body) {
  if (!body || typeof body !== 'object') return null;
  const holders = [body, body.paging, body.pagination, (body.data && !Array.isArray(body.data) ? body.data : null)];
  for (const holder of holders) {
    if (!holder || typeof holder !== 'object') continue;
    const value = holder.total ?? holder.totalCount ?? holder.count;
    if (value === undefined || value === null) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function rowKey(row, index) {
  if (!row || typeof row !== 'object') return `#${index}`;
  const id = row.id ?? row.ID;
  return id === undefined || id === null || id === '' ? null : String(id);
}

/**
 * Клиент портала.
 *
 * @param {object} options apiKey, baseUrl, timeoutMs, fetchImpl, pageSize, maxPages, retry*
 */
export function createBitrixClient(options = {}) {
  const apiKey = options.apiKey ?? config.bitrixApiKey;
  const baseUrl = String(options.baseUrl ?? config.bitrixApiBase).replace(/\/+$/, '');
  const defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : config.bitrixTimeoutMs;
  // fetch инъектируется, чтобы проверки шли на замоканных ответах и никогда не ходили в сеть.
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const sleep = options.sleep || sleepDefault;
  const pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 200;
  // Предохранитель от бесконечного обхода, а не ограничение объёма: реальный
  // журнал переходов портала — под 70 000 записей, и портал охотно отдаёт
  // короткие страницы, поэтому страниц выходит кратно больше расчётных.
  // Настоящие признаки конца — пустая страница и страница без новых записей.
  const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : 1000;
  const retryAttempts = Number(options.retryAttempts) > 0 ? Number(options.retryAttempts) : 3;
  const retryBaseDelayMs = Number(options.retryBaseDelayMs) > 0 ? Number(options.retryBaseDelayMs) : 300;
  const retryMaxDelayMs = Number(options.retryMaxDelayMs) > 0 ? Number(options.retryMaxDelayMs) : 4000;

  const hide = (text) => redactApiKey(text, apiKey);

  function url(path, params) {
    const clean = String(path).replace(/^\/+/, '');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const suffix = query.toString();
    return `${baseUrl}/${clean}${suffix ? `?${suffix}` : ''}`;
  }

  /**
   * Один запрос к порталу. Ретраев здесь нет намеренно: повтор — решение уровня
   * синхронизации, которая умеет ещё и дробить окно.
   */
  async function request(path, requestOptions = {}) {
    // Проверка ключа ДО сетевого вызова: без неё пользователь получил бы «401» вместо
    // внятного «ключ не задан», а в демо-режиме — бессмысленный поход в интернет.
    if (!apiKey) {
      throw bitrixError(
        'Не задан ключ доступа к Битрикс24 (переменная окружения BITRIX_API_KEY). Запрос к порталу не отправлялся.',
        { code: BITRIX_ERROR_CODES.noApiKey, retryable: false }
      );
    }

    const timeoutMs = Number(requestOptions.timeoutMs) > 0 ? Number(requestOptions.timeoutMs) : defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const target = url(path, requestOptions.params);
    const hasBody = requestOptions.body !== undefined && requestOptions.body !== null;

    try {
      let response;
      try {
        response = await fetchImpl(target, {
          method: requestOptions.method || (hasBody ? 'POST' : 'GET'),
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
            [API_KEY_HEADER]: apiKey,
            ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
            ...(requestOptions.headers || {})
          },
          ...(hasBody ? { body: typeof requestOptions.body === 'string' ? requestOptions.body : JSON.stringify(requestOptions.body) } : {})
        });
      } catch (error) {
        if (timedOut || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw bitrixError(
            `Портал Битрикс24 не ответил за ${timeoutMs} мс. Данные за этот заход не получены.`,
            { code: BITRIX_ERROR_CODES.timeout, retryable: true, cause: error }
          );
        }
        throw bitrixError(
          `Не удалось связаться с Битрикс24: ${hide(error?.message || 'сеть недоступна')}.`,
          { code: BITRIX_ERROR_CODES.network, retryable: true, cause: error }
        );
      }

      const status = Number(response?.status ?? 0);
      let text;
      try {
        text = await response.text();
      } catch (error) {
        // Таймаут мог сработать уже ПОСЛЕ того, как fetch разрешился заголовками,
        // пока тело ещё стримилось — тогда обрыв ловится здесь, а не в первом
        // catch. Без этой проверки такой обрыв классифицируется как обычная
        // сетевая ошибка, хотя причина и повторяемость — те же, что у таймаута.
        if (timedOut || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
          throw bitrixError(
            `Портал Битрикс24 не ответил за ${timeoutMs} мс. Данные за этот заход не получены.`,
            { code: BITRIX_ERROR_CODES.timeout, status, retryable: true, cause: error }
          );
        }
        throw bitrixError(
          `Ответ Битрикс24 не удалось прочитать: ${hide(error?.message || 'поток оборван')}.`,
          { code: BITRIX_ERROR_CODES.network, status, retryable: true, cause: error }
        );
      }

      let body;
      if (String(text).trim() === '') {
        body = {};
      } else {
        try {
          body = JSON.parse(text);
        } catch {
          // Шлюз при таймауте отдаёт HTML-страницу. Это не «сломанный JSON» для
          // пользователя, а «портал сейчас недоступен» — так и сообщаем.
          throw bitrixError(
            `Битрикс24 вернул не JSON (HTTP ${status}): ${hide(responseExcerpt(text))}. Похоже на страницу шлюза, а не на ответ API.`,
            {
              code: BITRIX_ERROR_CODES.badResponse,
              status,
              // Страница шлюза почти всегда означает временную недоступность; клиентская
              // ошибка 4xx с HTML — настоящая бизнес-ошибка и повтору не подлежит.
              retryable: !(status >= 400 && status < 500) || isRetryableStatus(status)
            }
          );
        }
      }

      if (!response.ok || body?.success === false) {
        const message = body?.error?.message || body?.message || body?.error || `HTTP ${status}`;
        throw bitrixError(
          `Битрикс24 отклонил запрос (HTTP ${status}): ${hide(typeof message === 'string' ? message : JSON.stringify(message))}.`,
          {
            code: body?.error?.code || BITRIX_ERROR_CODES.api,
            status,
            retryable: isRetryableStatus(status)
          }
        );
      }

      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Постраничный обход. Портал может отдавать курсор, может — только смещение;
   * поддержаны оба, плюс предохранитель от бесконечного цикла.
   *
   * Возвращает `{ rows, pages, truncated }`. `truncated: true` означает, что
   * выборка НЕ полна: вызывающий обязан превратить это в предупреждение,
   * а не считать полученное всеми данными.
   */
  async function paginate(makeRequest, paginateOptions = {}) {
    const limit = Number(paginateOptions.pageSize) > 0 ? Number(paginateOptions.pageSize) : pageSize;
    const pageCap = Number(paginateOptions.maxPages) > 0 ? Number(paginateOptions.maxPages) : maxPages;
    const rows = [];
    const seenKeys = new Set();
    const seenCursors = new Set();
    let cursor = null;
    let offset = 0;
    let pages = 0;
    // Последнее сообщённое порталом общее число записей: по нему видно, выбрана
    // ли выборка целиком, и оно же уходит в диагностику синхронизации.
    let knownTotal = null;

    while (pages < pageCap) {
      const body = await makeRequest({ limit, offset, cursor });
      pages += 1;
      const pageRows = rowsOf(body);
      let added = 0;
      for (const [index, row] of pageRows.entries()) {
        const key = rowKey(row, offset + index);
        // Страницы могут перекрываться (данные меняются между запросами) —
        // дубли по ID отсекаем сразу, иначе сущность посчитается дважды.
        if (key !== null) {
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
        }
        rows.push(row);
        added += 1;
      }

      if (pageRows.length === 0) return { rows, pages, truncated: false, total: knownTotal };
      // Страница целиком из уже виденных записей — портал повторяет последнюю
      // порцию вместо пустой. Без этого выхода обход дошёл бы до предохранителя
      // и объявил полную выборку обрезанной.
      if (added === 0) return { rows, pages, truncated: false, total: knownTotal };

      const nextCursor = nextCursorOf(body);
      if (nextCursor !== null && !seenCursors.has(nextCursor)) {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
        offset += pageRows.length;
        continue;
      }
      if (nextCursor !== null) return { rows, pages, truncated: false, total: knownTotal }; // курсор повторился — конец

      offset += pageRows.length;
      const total = totalOf(body);
      if (total !== null) knownTotal = total;
      if (total !== null && rows.length >= total) return { rows, pages, truncated: false, total: knownTotal };
      // Короткая страница НЕ считается концом выборки. Этот портал отдаёт меньше
      // запрошенного и в середине журнала — своё ограничение по времени ответа, —
      // а общего числа записей по /stage-history не сообщает вовсе. Обход, который
      // видел в короткой странице конец данных, забирал 36 599 записей из ~69 000
      // (боевой прогон 18.08.2026) и объявлял выборку полной: воронка выглядела
      // рабочей, показывая числа вдвое меньше настоящих.
      //
      // Признаки конца остаются надёжные: пустая страница, страница без единой
      // новой записи (портал повторяет последнюю порцию) и выбранный total, если
      // портал его называет. Цена — один лишний запрос на выборку.
      cursor = null;
    }

    return { rows, pages, truncated: true, total: knownTotal };
  }

  /**
   * GET-выборка с постраничным обходом.
   *
   * Параметры уходят в строку запроса КАК ЕСТЬ, без обёртки `filter[...]`: этот
   * прокси понимает только прямые имена (`?ownerId=39281` отбирает, `?filter[ownerId]=39281`
   * молча игнорируется). Незнакомый параметр он не считает ошибкой — вызывающий
   * код обязан перепроверять отбор по полученным записям.
   */
  async function listAll(entity, params = {}, listOptions = {}) {
    return paginate(({ limit, offset, cursor }) => request(entity, {
      method: 'GET',
      timeoutMs: listOptions.timeoutMs,
      params: {
        ...params,
        limit,
        // Смещение называется `offset`, а НЕ `start` из классического REST
        // Битрикса. Прокси разбирает строку запроса строго и на `start` отвечает
        // 400 `Unknown filter field 'start'` — то есть неверное имя роняет
        // выборку целиком, а не просто игнорируется. Проверено на портале:
        // с `offset` постраничный обход отдаёт все записи, со `start` — ноль.
        ...(cursor === null ? { offset } : { cursor })
      }
    }), listOptions);
  }

  // POST-выборки `/{entity}/search` здесь намеренно нет: такого маршрута на
  // портале не подтверждено, а отбор он всё равно делает по прямым параметрам
  // строки запроса (см. listAll выше). Метод-обёртка над несуществующим
  // маршрутом только подсказывал бы вызывающему коду неверный путь.

  /** Одна страница без обхода — для метаданных вроде `/userfields/deals`. */
  async function fetchOne(entity, params = {}, oneOptions = {}) {
    return request(entity, { method: 'GET', params, timeoutMs: oneOptions.timeoutMs });
  }

  return {
    /** Ключ задан: без него сетевые вызовы бессмысленны. */
    ready: Boolean(apiKey),
    baseUrl,
    request,
    listAll,
    fetchOne,
    /** Повтор с экспоненциальной задержкой на настройках этого клиента. */
    retry: (task, retryOptions = {}) => withRetry(task, {
      attempts: retryAttempts,
      baseDelayMs: retryBaseDelayMs,
      maxDelayMs: retryMaxDelayMs,
      sleep,
      ...retryOptions
    })
  };
}
