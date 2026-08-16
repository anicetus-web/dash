/**
 * Служба синхронизации.
 *
 * Три обязательства перед пользователем (спека, «Синхронизация и состояние системы»):
 *   1. Одновременно выполняется не более одной синхронизации.
 *   2. Новый снимок заменяет предыдущий ТОЛЬКО после полного успешного получения.
 *   3. Сбой не уничтожает последний успешный снимок — дашборд продолжает работать
 *      на нём и честно сообщает, что данные устарели.
 */

import { config } from '../config.js';
import { createSource } from './source.js';

/** Снимок пригоден к записи: пришли обе сущности и справочники не пусты. */
function validateSnapshot(snapshot) {
  const problems = [];
  if (!snapshot || typeof snapshot !== 'object') {
    problems.push('источник вернул не объект');
    return problems;
  }
  if (!Array.isArray(snapshot.companies)) problems.push('нет списка компаний');
  if (!Array.isArray(snapshot.deals)) problems.push('нет списка сделок');
  if (!Array.isArray(snapshot.companyStageEvents)) problems.push('нет истории стадий компаний');
  if (!Array.isArray(snapshot.dealStageEvents)) problems.push('нет истории стадий сделок');
  return problems;
}

/**
 * Признак деградации: загрузка прошла с ошибками И данных стало заметно меньше.
 *
 * Смысл в том, чтобы отличить нормальное уменьшение (сущности действительно
 * удалили) от частичной загрузки, при которой половина данных просто не приехала.
 * Второе — не повод перезаписывать хороший снимок плохим.
 */
export function isDegradedSync(previousCount, nextCount, hadWarnings) {
  if (!hadWarnings) return false;
  if (nextCount === 0) return previousCount > 0;
  return previousCount > 0 && nextCount < previousCount * 0.75;
}

export function createSyncService({ store, source = createSource(), now = () => new Date() } = {}) {
  let inFlight = null;
  let lastRunAt = null;

  async function performSync(options) {
    const startedAt = now().toISOString();
    await store.updateSync({ status: 'running', lastStartedAt: startedAt, lastError: null });

    try {
      // Снимок читается ДО запроса к источнику и передаётся ему явно: источник
      // может держать в снимке ту часть истории, чей перезапрос в ЭТОТ заход
      // не удался — иначе полная замена снимка на успехе стирает достигнутые
      // этапы у сущностей, чья история не пришла именно сейчас (тот самый
      // инцидент, который описан в reference/altech/src/sync/fullSync.js).
      const previous = await store.getSnapshot();
      const fetched = await source.fetchSnapshot({ ...options, previousSnapshot: previous });

      const problems = validateSnapshot(fetched);
      if (problems.length > 0) {
        // Непригодный снимок до записи не доходит: испортить хороший файл
        // недоделанными данными хуже, чем показать устаревшие.
        throw new Error(`Снимок не прошёл проверку: ${problems.join(', ')}`);
      }

      const previousCount = (previous.companies?.length || 0) + (previous.deals?.length || 0);
      const nextCount = fetched.companies.length + fetched.deals.length;
      const warnings = Array.isArray(fetched.warnings) ? fetched.warnings : [];

      if (isDegradedSync(previousCount, nextCount, warnings.length > 0)) {
        await store.updateSync({
          status: 'error',
          lastError: `Загрузка прошла с ошибками и вернула ${nextCount} сущностей вместо ${previousCount}. Прежний снимок сохранён.`,
          warnings: [...warnings, { code: 'DEGRADED_SYNC_SKIPPED', message: 'Снимок не заменён: загрузка неполная.' }]
        });
        return { ok: false, degraded: true, previousCount, nextCount };
      }

      const finishedAt = now().toISOString();
      // `warnings` — сигнал ЭТОГО захода синхронизации, а не часть формы снимка
      // (EMPTY_CACHE его не описывает: постоянное место предупреждений — sync.warnings,
      // собранный явно ниже). Без явного исключения поле просачивалось бы в сохранённый
      // JSON нетронутым через spread и расходилось бы с контрактом хранилища.
      const { warnings: _sourceWarnings, ...persisted } = fetched;
      await store.save({
        ...persisted,
        source: source.name,
        portalTimezone: fetched.portalTimezone || config.portalTimezone,
        sync: {
          status: 'success',
          lastStartedAt: startedAt,
          // Отметка успеха ставится только здесь: снимок уже получен целиком и проверен.
          lastSuccessAt: finishedAt,
          lastError: null,
          warnings
        }
      });

      lastRunAt = finishedAt;
      return { ok: true, companies: fetched.companies.length, deals: fetched.deals.length, warnings };
    } catch (error) {
      // Прежний снимок остаётся на месте: обновляется только блок состояния.
      await store.updateSync({
        status: 'error',
        lastError: error.message || 'Синхронизация не выполнена'
      });
      return { ok: false, error: error.message, code: error.code || null };
    }
  }

  /**
   * Запуск с защитой от параллельного выполнения.
   * Второй запрос ПРИСОЕДИНЯЕТСЯ к текущей синхронизации и получает её результат.
   * Отказывать второму запросу было бы неверно: пользователь просил свежие данные,
   * и он их получит — просто из уже идущей загрузки.
   */
  function run(options = {}) {
    if (inFlight) return { started: false, joined: true, promise: inFlight };
    const promise = performSync(options).finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return { started: true, joined: false, promise };
  }

  async function runManual(options = {}) {
    const handle = run(options);
    const result = await handle.promise;
    return { ...handle, result, promise: undefined };
  }

  async function getStatus() {
    const snapshot = await store.getSnapshot();
    const sync = snapshot.sync || {};
    const lastSuccess = sync.lastSuccessAt ? Date.parse(sync.lastSuccessAt) : null;
    return {
      status: inFlight ? 'running' : (sync.status || 'idle'),
      running: Boolean(inFlight),
      lastStartedAt: sync.lastStartedAt || null,
      lastSuccessAt: sync.lastSuccessAt || null,
      lastError: sync.lastError || null,
      snapshotAt: snapshot.updatedAt || null,
      stale: lastSuccess === null
        ? (snapshot.companies?.length || 0) > 0
        : now().getTime() - lastSuccess > config.snapshotStaleAfterMs,
      source: snapshot.source || source.name,
      sourceReady: source.ready,
      blockedBy: source.blockedBy,
      counts: {
        companies: snapshot.companies?.length || 0,
        deals: snapshot.deals?.length || 0,
        companyStageEvents: snapshot.companyStageEvents?.length || 0,
        dealStageEvents: snapshot.dealStageEvents?.length || 0,
        assigneeEvents: snapshot.assigneeEvents?.length || 0
      },
      dataQuality: snapshot.dataQuality || null,
      warnings: sync.warnings || []
    };
  }

  let timer = null;

  function start({ immediate = true } = {}) {
    if (!config.syncEnabled) return null;
    if (!source.ready) {
      console.warn(`[sync] источник «${source.name}» не готов: ${source.blockedBy}`);
      return null;
    }
    const tick = () => {
      run().promise?.catch((error) => console.error('[sync]', error?.message || error));
    };
    if (immediate) {
      const initial = setTimeout(tick, 1000);
      initial.unref?.();
    }
    timer = setInterval(tick, config.syncIntervalMs);
    // Таймер не удерживает процесс: приложение должно завершаться по сигналу,
    // а не ждать следующего тика синхронизации.
    timer.unref?.();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { run, runManual, getStatus, start, stop, isRunning: () => Boolean(inFlight), lastRunAt: () => lastRunAt };
}
