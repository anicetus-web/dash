/**
 * Маршруты API.
 *
 * Каждый маршрут делает ровно три вещи: разбирает запрос, зовёт расчётный модуль,
 * упаковывает ответ. Формул здесь нет (инвариант 9) — иначе интерфейс, детализация
 * и XLSX однажды разойдутся в числах, и найти причину будет нечем.
 *
 * Контракт: docs/api-contract.md
 */

import { config } from '../config.js';
import { calculateDashboard } from '../analytics/dashboard.js';
import { getStageDetails, stageReference } from '../analytics/details.js';
import { NOT_SPECIFIED, buildIndex } from '../analytics/snapshot.js';
import { PERIOD_TYPES } from '../domain/period.js';
import { buildDashboardReport } from '../export/report.js';
import { cachedDashboard } from './responseCache.js';

/** Читает параметр среза из строки запроса. */
function sliceRequest(url) {
  const q = url.searchParams;
  return {
    mode: q.get('mode') === 'dynamic' ? 'dynamic' : 'static',
    periodType: q.get('periodType') || undefined,
    periodValue: q.get('periodValue') || undefined,
    from: q.get('from') || undefined,
    to: q.get('to') || undefined,
    sourceIds: q.get('sourceIds'),
    managerIds: q.get('managerIds'),
    kevFormats: q.get('kevFormats'),
    conversionFrom: q.get('conversionFrom') || undefined,
    conversionTo: q.get('conversionTo') || undefined
  };
}

/** Общие параметры расчёта: часовой пояс портала и адрес для ссылок на карточки. */
function calcOptions(snapshot) {
  return {
    timeZone: snapshot.portalTimezone || config.portalTimezone,
    portalUrl: config.bitrixPortalUrl,
    staleAfterMs: config.snapshotStaleAfterMs,
    dataSource: config.dataSource
  };
}

/** Справочник значений фильтра из снимка. «Не указано» всегда последним. */
function referenceList(dictionary, usedIds, noneName) {
  const items = [];
  for (const [id, name] of dictionary) {
    if (id === NOT_SPECIFIED) continue;
    items.push({ id, name });
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (usedIds.has(NOT_SPECIFIED)) items.push({ id: NOT_SPECIFIED, name: noneName });
  return items;
}

export function createApiRoutes({ store, sync, sendOk, httpError }) {
  return async function routeApi(req, res, url) {
    const path = url.pathname;

    // ── Рассчитанный дашборд ──────────────────────────────────────────────
    if (path === '/api/dashboard' && (req.method === 'GET' || req.method === 'HEAD')) {
      const request = sliceRequest(url);
      // Проверка «allHistory только для Статики» и откат неизвестного типа периода
      // к кварталу выполняются внутри calculateDashboard → computeSlice: так это
      // правило действует для ЛЮБОГО вызывающего, а не только для этого маршрута.
      const snapshot = await store.getSnapshot();
      // Тот же срез, запрошенный вторым и последующими пользователями, не
      // пересчитывается: 200 сотрудников смотрят в основном один и тот же
      // экран, а расчёт стоит десятки миллисекунд занятого событийного цикла.
      // Ключ включает сам снимок — новая синхронизация промахивается сама.
      sendOk(res, cachedDashboard(
        snapshot,
        request,
        () => calculateDashboard(snapshot, request, calcOptions(snapshot))
      ));
      return true;
    }

    // ── Справочники фильтров ──────────────────────────────────────────────
    if (path === '/api/reference' && (req.method === 'GET' || req.method === 'HEAD')) {
      const snapshot = await store.getSnapshot();
      const index = buildIndex(snapshot);

      const usedSources = new Set([...index.companies.values()].map((c) => c.sourceId));
      for (const deal of index.deals.values()) usedSources.add(deal.sourceId);
      const usedKev = new Set([...index.deals.values()].map((deal) => deal.kevFormatId));

      sendOk(res, {
        managers: referenceList(index.managers, new Set(), 'Не назначен'),
        sources: referenceList(index.sources, usedSources, 'Источник не указан'),
        kevFormats: referenceList(index.kevFormats, usedKev, 'Не указано'),
        stages: stageReference(),
        portalTimezone: snapshot.portalTimezone || config.portalTimezone,
        periodTypes: PERIOD_TYPES
      });
      return true;
    }

    // ── Детализация ступени ───────────────────────────────────────────────
    if (path === '/api/details' && (req.method === 'GET' || req.method === 'HEAD')) {
      const request = sliceRequest(url);
      request.stageRole = url.searchParams.get('stageRole') || '';
      request.page = url.searchParams.get('page');
      request.pageSize = url.searchParams.get('pageSize');
      // Фильтры ВНУТРИ модалки детализации — сужают уже отобранную ступень ещё раз,
      // отдельно от фильтров дашборда сверху (те уже разобраны в sliceRequest выше).
      request.detailSourceIds = url.searchParams.get('detailSourceIds');
      request.detailManagerIds = url.searchParams.get('detailManagerIds');
      request.detailKevFormats = url.searchParams.get('detailKevFormats');
      request.detailCurrentStage = url.searchParams.get('detailCurrentStage');
      request.detailSearch = url.searchParams.get('detailSearch');
      const snapshot = await store.getSnapshot();
      sendOk(res, getStageDetails(snapshot, request, calcOptions(snapshot)));
      return true;
    }

    // ── Выгрузка XLSX ────────────────────────────────────────────────────
    if (path === '/api/export.xlsx' && (req.method === 'GET' || req.method === 'HEAD')) {
      const request = sliceRequest(url);
      const snapshot = await store.getSnapshot();
      // Отдаёт бинарный файл, а не конверт {success,data}: это не JSON-ответ.
      const { buffer, fileName } = buildDashboardReport(snapshot, request, calcOptions(snapshot));
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store'
      });
      res.end(req.method === 'HEAD' ? undefined : buffer);
      return true;
    }

    // ── Состояние синхронизации ───────────────────────────────────────────
    if (path === '/api/sync-status' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendOk(res, await sync.getStatus());
      return true;
    }

    // ── Ручной запуск синхронизации ───────────────────────────────────────
    if (path === '/api/sync') {
      if (req.method !== 'POST') {
        throw httpError(405, 'METHOD_NOT_ALLOWED', 'Запуск синхронизации выполняется методом POST');
      }
      // Второй одновременный запрос присоединяется к текущей синхронизации
      // и получает её результат — параллельно они не выполняются никогда.
      const result = await sync.runManual();
      sendOk(res, { ...(await sync.getStatus()), started: result.started, joined: result.joined });
      return true;
    }

    return false;
  };
}
