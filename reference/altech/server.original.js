import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSyncStatus, runExclusiveSync } from './src/sync/status.js';
import { store } from './src/storage/jsonStore.js';
import { salesPlanStore } from './src/storage/salesPlanStore.js';
import { dashboardSettingsStore } from './src/storage/dashboardSettingsStore.js';
import { buildDashboardFromCache, EXTRA_FILTER_KEYS, monthKeysForPeriod, periodContractDeals, sliceDeals } from './src/analytics/dashboard.js';
import { buildSalesInsights } from './src/ai/insights.js';
import { buildSalesReport } from './src/ai/report.js';
import { getChatAnswer } from './src/ai/chat.js';
import { gatewayBalance } from './src/ai/providers.js';
import { aiReportStore } from './src/storage/aiReportStore.js';
import { config, configDegraded } from './src/config.js';
import { fullSync } from './src/sync/fullSync.js';
import { startSyncScheduler } from './src/sync/scheduler.js';
import { startReportScheduler } from './src/sync/reportScheduler.js';
import { getDiagnostics, logProblem } from './src/diagnostics/log.js';
import { anonymizePlans, anonymizeSnapshot } from './src/demo/anonymize.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 3000);

async function getPublicSnapshot() {
  const snapshot = await store.getSnapshot();
  return config.demoMode ? anonymizeSnapshot(snapshot) : snapshot;
}

function publicPlans(plans) {
  return config.demoMode ? anonymizePlans(plans) : plans;
}

// Итерация 2: доп-фильтры среза из query/body ('' = фильтр не активен).
function extraFiltersFromQuery(searchParams) {
  return Object.fromEntries(EXTRA_FILTER_KEYS.map((key) => [key, searchParams.get(key) || '']));
}
function extraFiltersFromBody(body) {
  return Object.fromEntries(EXTRA_FILTER_KEYS.map((key) => [key, typeof body[key] === 'string' ? body[key] : '']));
}
const VIBE_API_KEY = process.env.VIBE_API_KEY || '';
const VIBE_BASE = process.env.VIBE_BASE || 'https://vibecode.bitrix24.tech/v1';
const DASHBOARD_SNAPSHOT_FILE = process.env.DASHBOARD_SNAPSHOT_FILE || '';

const FUNNEL_STAGE_NAMES = [
  'Взят в работу',
  'Квалифицирован',
  'Выявлена потребность',
  'Получены исходники',
  'Назначена встреча',
  'Встреча проведена',
  'Реквизиты получены',
  'Договор подписан / Аванс оплачен'
];

const STAGE_ALIASES = {
  'Договор подписан / Аванс оплачен': [
    'Договор подписан/Аванс получен',
    'Договор подписан аванс получен',
    'Аванс получен'
  ]
};

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

let cachedReference = null;
let cachedReferenceAt = 0;
const REFERENCE_TTL_MS = 5 * 60 * 1000;
const DASHBOARD_CACHE_TTL_MS = Number(process.env.DASHBOARD_CACHE_TTL_MS || 5 * 60 * 1000);
const dashboardCache = new Map();
const activityCache = new Map();

function getCached(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (item.expiresAt && item.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  return item;
}

function setCached(map, key, data) {
  map.set(key, { data, expiresAt: Date.now() + DASHBOARD_CACHE_TTL_MS });
  if (map.size > 80) map.delete(map.keys().next().value);
}

async function cachedCall(map, key, producer) {
  const cached = getCached(map, key);
  if (cached?.data) return cached.data;
  if (cached?.promise) return cached.promise;
  const promise = producer()
    .then((data) => {
      setCached(map, key, data);
      return data;
    })
    .catch((error) => {
      map.delete(key);
      throw error;
    });
  map.set(key, { promise, expiresAt: Date.now() + 2 * 60 * 1000 });
  return promise;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const MAX_BODY = 1 * 1024 * 1024; // 1 МБ — тел планов/настроек/чата с запасом
  const chunks = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) { over = true; continue; } // дренируем, не буферизуем — защита от OOM
    chunks.push(chunk);
  }
  if (over) {
    const error = new Error('Тело запроса слишком большое');
    error.status = 413;
    error.code = 'PAYLOAD_TOO_LARGE';
    throw error;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function currentMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function valueOf(record, keys, fallback = undefined) {
  for (const key of keys) {
    if (record && record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return record[key];
    }
  }
  return fallback;
}

function numberOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const clean = value.split('|')[0].replace(/\s/g, '').replace(',', '.');
    const parsed = Number(clean);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toIsoBoundary(value, endOfDay = false) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value || '')
    ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
    : new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function splitIsoWindows(fromIso, toIso, days = 31) {
  const windows = [];
  let cursor = new Date(fromIso).getTime();
  const end = new Date(toIso).getTime();
  const step = days * 24 * 60 * 60 * 1000;
  while (Number.isFinite(cursor) && cursor <= end) {
    const next = Math.min(cursor + step - 1, end);
    windows.push({
      from: new Date(cursor).toISOString(),
      to: new Date(next).toISOString()
    });
    cursor = next + 1;
  }
  return windows.length ? windows : [{ from: fromIso, to: toIso }];
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function vibe(path, options = {}) {
  if (!VIBE_API_KEY) {
    const error = new Error('VIBE_API_KEY is not configured');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 45000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await fetch(`${VIBE_BASE}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'X-Api-Key': VIBE_API_KEY,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    text = await res.text();
  } catch (error) {
    const wrapped = new Error(error.name === 'AbortError' ? 'Данные недоступны: API не ответил вовремя' : 'Ошибка подключения к API');
    wrapped.code = error.name === 'AbortError' ? 'API_TIMEOUT' : 'API_CONNECTION_ERROR';
    throw wrapped;
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { success: false, error: { message: text || `HTTP ${res.status}` } };
  }
  if (!res.ok || body?.success === false) {
    const message = body?.error?.message || body?.message || `HTTP ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.code = body?.error?.code;
    error.details = body?.error || body;
    throw error;
  }
  return body;
}

async function listEntity(entity, params = {}, options = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const suffix = qs.toString() ? `?${qs}` : '';
  const body = await vibe(`/${entity}${suffix}`, options);
  return Array.isArray(body.data) ? body.data : [];
}

async function searchEntity(entity, payload = {}, options = {}) {
  const body = await vibe(`/${entity}/search`, {
    ...options,
    method: 'POST',
    body: JSON.stringify(payload)
  });
  return Array.isArray(body.data) ? body.data : [];
}

async function safeCall(label, fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return {
      ok: false,
      label,
      data: null,
      error: {
        code: error.code || 'UNAVAILABLE',
        message: error.message || 'Данные недоступны'
      }
    };
  }
}

function categoryName(category) {
  return valueOf(category, ['name', 'title', 'NAME', 'TITLE'], '');
}

function categoryId(category) {
  return String(valueOf(category, ['id', 'ID', 'categoryId', 'CATEGORY_ID'], ''));
}

function statusName(status) {
  return valueOf(status, ['name', 'title', 'NAME', 'TITLE', 'statusName', 'STATUS_NAME'], '');
}

function statusId(status) {
  return String(valueOf(status, ['statusId', 'STATUS_ID', 'id', 'ID'], ''));
}

function statusEntityId(status) {
  return String(valueOf(status, ['entityId', 'ENTITY_ID'], ''));
}

function belongsToCategory(status, category) {
  if (!category) return true;
  const id = categoryId(category);
  const entityId = statusEntityId(status).toUpperCase();
  const sid = statusId(status).toUpperCase();
  if (id === '0') return entityId === 'DEAL_STAGE' || !entityId.includes('DEAL_STAGE_');
  return entityId === `DEAL_STAGE_${id}` || sid.startsWith(`C${id}:`);
}

function buildStageMap(statuses, category) {
  return FUNNEL_STAGE_NAMES.map((name, index) => {
    const targets = [name, ...(STAGE_ALIASES[name] || [])].map(normalizeText);
    const status = statuses.find((item) => belongsToCategory(item, category) && targets.includes(normalizeText(statusName(item))))
      || statuses.find((item) => belongsToCategory(item, category) && targets.some((target) => normalizeText(statusName(item)).includes(target)))
      || null;
    return {
      index,
      name,
      id: status ? statusId(status) : null,
      source: status ? 'bitrix-status' : 'configured-name'
    };
  });
}

function dealCurrentStageIndex(deal, stages) {
  const currentStage = String(valueOf(deal, ['stageId', 'STAGE_ID'], ''));
  const byId = stages.findIndex((stage) => stage.id && stage.id === currentStage);
  if (byId >= 0) return byId;
  const byName = stages.findIndex((stage) => normalizeText(currentStage).includes(normalizeText(stage.name)));
  return byName;
}

function dealId(deal) {
  return String(valueOf(deal, ['id', 'ID'], ''));
}

function dealAmount(deal) {
  return numberOf(valueOf(deal, ['amount', 'opportunity', 'OPPORTUNITY', 'sum', 'SUM'], 0));
}

function dealAssignedById(deal) {
  return String(valueOf(deal, ['assignedById', 'ASSIGNED_BY_ID', 'responsibleId', 'RESPONSIBLE_ID'], ''));
}

function dealSourceId(deal) {
  return String(valueOf(deal, ['sourceId', 'SOURCE_ID'], ''));
}

function historyDealId(record) {
  return String(valueOf(record, ['ownerId', 'OWNER_ID', 'dealId', 'DEAL_ID', 'entityId', 'ENTITY_ID'], ''));
}

function historyStageId(record) {
  return String(valueOf(record, ['stageId', 'STAGE_ID', 'statusId', 'STATUS_ID'], ''));
}

function historyCreatedAt(record) {
  return valueOf(record, ['createdAt', 'createdTime', 'CREATED_AT', 'CREATED_TIME'], '');
}

function historyDate(record) {
  const date = new Date(historyCreatedAt(record));
  return Number.isNaN(date.getTime()) ? null : date;
}

function isWithinIsoRange(value, fromIso, toIso) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= new Date(fromIso).getTime() && time <= new Date(toIso).getTime();
}

function sourceName(status) {
  return valueOf(status, ['name', 'title', 'NAME', 'TITLE', 'statusName', 'STATUS_NAME'], '');
}

function sourceId(status) {
  return String(valueOf(status, ['statusId', 'STATUS_ID', 'id', 'ID'], ''));
}

function userName(user) {
  return valueOf(user, ['name', 'fullName', 'formattedName', 'NAME', 'FULL_NAME'], '')
    || [valueOf(user, ['lastName', 'LAST_NAME'], ''), valueOf(user, ['firstName', 'FIRST_NAME'], '')].filter(Boolean).join(' ')
    || valueOf(user, ['email', 'EMAIL'], '')
    || `ID ${userId(user)}`;
}

function userId(user) {
  return String(valueOf(user, ['id', 'ID', 'bitrixUserId'], ''));
}

async function getReference() {
  if (cachedReference && Date.now() - cachedReferenceAt < REFERENCE_TTL_MS) return cachedReference;

  const [categoriesResult, statusesResult, usersResult] = await Promise.all([
    safeCall('deal-categories', () => listEntity('deal-categories', { limit: 5000 })),
    safeCall('statuses', () => listEntity('statuses', { limit: 5000 })),
    safeCall('users', () => listEntity('users', { limit: 5000 }))
  ]);

  const categories = categoriesResult.data || [];
  const statuses = statusesResult.data || [];
  const users = usersResult.data || [];
  const category = categories.find((item) => normalizeText(categoryName(item)).includes('2d bim'))
    || categories.find((item) => normalizeText(categoryName(item)).includes('2д bim'))
    || categories.find((item) => normalizeText(categoryName(item)).includes('bim'))
    || null;
  const stages = buildStageMap(statuses, category);
  const sources = statuses
    .filter((item) => statusEntityId(item).toUpperCase() === 'SOURCE')
    .map((item) => ({ id: sourceId(item), name: sourceName(item) }))
    .filter((item) => item.id && item.name);
  const managers = users
    .map((item) => ({ id: userId(item), name: userName(item) }))
    .filter((item) => item.id && item.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  cachedReference = {
    category: category ? { id: categoryId(category), name: categoryName(category) } : null,
    stages,
    sources,
    managers,
    warnings: [categoriesResult, statusesResult, usersResult]
      .filter((item) => !item.ok)
      .map((item) => ({ area: item.label, ...item.error }))
  };
  cachedReferenceAt = Date.now();
  return cachedReference;
}

function commonDealFilter(reference, managerId, sourceIdValue) {
  const filter = {
  };
  if (reference.category?.id) filter.categoryId = Number(reference.category.id);
  if (managerId) filter.assignedById = Number(managerId);
  if (sourceIdValue) filter.sourceId = sourceIdValue;
  return filter;
}

async function fetchDeals(reference, fromIso, toIso, managerId, sourceIdValue) {
  const common = commonDealFilter(reference, managerId, sourceIdValue);
  const windows = splitIsoWindows(fromIso, toIso);
  const byId = new Map();
  const errors = [];

  const filters = windows.flatMap((window) => [
      {
        ...common,
        createdAt: { $lte: toIso },
        updatedAt: { $gte: window.from, $lte: window.to }
      },
      {
        ...common,
        createdAt: { $gte: window.from, $lte: window.to }
      }
    ]);

  const results = await mapLimit(filters, 4, (filter) => safeCall('deals', () => searchEntity('deals', {
      filter,
      sort: { updatedAt: 'desc' },
      limit: 5000
    }, { timeoutMs: 35000 })));

  for (const result of results) {
    if (result.ok) {
      for (const deal of result.data) byId.set(dealId(deal), deal);
    } else {
      errors.push(result.error);
    }
  }
  if (!byId.size && errors.length) throw Object.assign(new Error(errors[0].message), errors[0]);
  return [...byId.values()];
}

async function fetchStageHistory(reference, fromIso, toIso, dealIds) {
  const allowed = new Set(dealIds);
  const listResult = await safeCall('stage-history', () => listEntity('stage-history', {
    limit: 5000,
    sort: '-createdAt'
  }, { timeoutMs: 15000 }));
  if (!listResult.ok) return { available: false, records: [], error: listResult.error };
  const category = reference.category?.id ? String(reference.category.id) : null;
  return {
    available: true,
    partial: true,
    records: listResult.data.filter((record) => {
      const recordCategory = String(valueOf(record, ['categoryId', 'CATEGORY_ID'], ''));
      return (!category || recordCategory === category)
        && isWithinIsoRange(historyCreatedAt(record), fromIso, toIso)
        && (!allowed.size || allowed.has(historyDealId(record)));
    }),
    error: null
  };
}

function calculateFunnel(reference, deals, historyResult) {
  const counts = Array(reference.stages.length).fill(0);
  const reachedLastDeals = [];
  const historyByDeal = new Map();
  const stageIndexById = new Map(reference.stages.filter((stage) => stage.id).map((stage) => [stage.id, stage.index]));

  if (historyResult.available) {
    for (const record of historyResult.records) {
      const id = historyDealId(record);
      const index = stageIndexById.get(historyStageId(record));
      if (!id || index === undefined) continue;
      const prev = historyByDeal.get(id) ?? -1;
      historyByDeal.set(id, Math.max(prev, index));
    }
  }

  for (const deal of deals) {
    const id = dealId(deal);
    let reachedIndex = historyByDeal.get(id);
    if (reachedIndex === undefined) reachedIndex = dealCurrentStageIndex(deal, reference.stages);
    if (reachedIndex < 0 || reachedIndex === undefined) continue;
    for (let index = 0; index <= reachedIndex && index < counts.length; index += 1) counts[index] += 1;
    if (reachedIndex >= reference.stages.length - 1) reachedLastDeals.push(deal);
  }

  return reference.stages.map((stage, index) => {
    const previous = index === 0 ? counts[0] : counts[index - 1];
    const conversion = index === 0 ? 100 : previous ? Math.round((counts[index] / previous) * 1000) / 10 : 0;
    return { ...stage, count: counts[index], conversion };
  }).map((stage, index) => ({
    ...stage,
    previousCount: index === 0 ? null : counts[index - 1]
  })).concat([]);
}

function buildFunnelAnalytics(reference, deals, historyResult, mode) {
  const firstIndex = 0;
  const workIndex = 6;
  const finalIndex = reference.stages.length - 1;
  const stageIndexById = new Map(reference.stages.filter((stage) => stage.id).map((stage) => [stage.id, stage.index]));
  const historiesByDeal = new Map();

  if (historyResult.available) {
    for (const record of historyResult.records) {
      const id = historyDealId(record);
      const index = stageIndexById.get(historyStageId(record));
      if (!id || index === undefined) continue;
      if (!historiesByDeal.has(id)) historiesByDeal.set(id, []);
      historiesByDeal.get(id).push({ ...record, index, date: historyDate(record) });
    }
  }

  for (const rows of historiesByDeal.values()) {
    rows.sort((a, b) => (a.date?.getTime() || 0) - (b.date?.getTime() || 0));
  }

  const dealById = new Map(deals.map((deal) => [dealId(deal), deal]));
  const included = new Set();
  const reachedByDeal = new Map();
  const firstDates = new Map();
  const finalDates = new Map();
  const finalDealIds = new Set();
  const workDealIds = new Set();

  for (const deal of deals) {
    const id = dealId(deal);
    const rows = historiesByDeal.get(id) || [];
    const hasFirstInPeriod = rows.some((row) => row.index === firstIndex);
    const hasAnyStageInPeriod = rows.length > 0;
    const include = mode === 'dynamic' ? hasFirstInPeriod : hasAnyStageInPeriod;
    if (!include) continue;

    included.add(id);
    let reached = Math.max(...rows.map((row) => row.index), -1);
    const current = dealCurrentStageIndex(deal, reference.stages);
    if (mode === 'dynamic' && current > reached) reached = current;
    if (reached < 0) continue;
    reachedByDeal.set(id, reached);

    const firstRow = rows.find((row) => row.index === firstIndex && row.date);
    const finalRow = rows.find((row) => row.index === finalIndex && row.date);
    if (firstRow) firstDates.set(id, firstRow.date);
    if (finalRow) finalDates.set(id, finalRow.date);
    if (rows.some((row) => row.index === finalIndex)) finalDealIds.add(id);
    if (mode === 'dynamic' ? reached >= workIndex : rows.some((row) => row.index === workIndex)) workDealIds.add(id);
  }

  if (!historyResult.available || !included.size) {
    for (const deal of deals) {
      const id = dealId(deal);
      const current = dealCurrentStageIndex(deal, reference.stages);
      if (current < 0) continue;
      included.add(id);
      reachedByDeal.set(id, current);
      if (current >= finalIndex) finalDealIds.add(id);
      if (current >= workIndex) workDealIds.add(id);
    }
  }

  const counts = Array(reference.stages.length).fill(0);
  for (const reached of reachedByDeal.values()) {
    for (let index = 0; index <= reached && index < counts.length; index += 1) counts[index] += 1;
  }

  const funnel = reference.stages.map((stage, index) => {
    const previous = index === 0 ? counts[0] : counts[index - 1];
    return {
      ...stage,
      count: counts[index],
      conversion: index === 0 ? 100 : previous ? Math.round((counts[index] / previous) * 1000) / 10 : 0,
      previousCount: index === 0 ? null : counts[index - 1]
    };
  });

  const finalDeals = [...finalDealIds].map((id) => dealById.get(id)).filter(Boolean);
  const paidAmounts = finalDeals.map(dealAmount).filter((amount) => amount > 0);
  const revenue = paidAmounts.reduce((sum, amount) => sum + amount, 0);
  const averageCheck = paidAmounts.length ? Math.round(revenue / paidAmounts.length) : 0;
  const workRevenue = [...workDealIds]
    .map((id) => dealById.get(id))
    .filter(Boolean)
    .reduce((sum, deal) => sum + dealAmount(deal), 0);

  const sourceMap = new Map(reference.sources.map((item) => [item.id, item.name]));
  const revenueBySource = new Map();
  for (const deal of finalDeals) {
    const amount = dealAmount(deal);
    if (!amount) continue;
    const source = dealSourceId(deal) || 'unknown';
    const row = revenueBySource.get(source) || {
      id: source,
      name: sourceMap.get(source) || (source === 'unknown' ? 'Без источника' : source),
      revenue: 0,
      count: 0
    };
    row.revenue += amount;
    row.count += 1;
    revenueBySource.set(source, row);
  }

  const cycles = [];
  for (const id of finalDealIds) {
    const start = firstDates.get(id);
    const finish = finalDates.get(id);
    if (!start || !finish) continue;
    const days = Math.max(0, (finish.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
    cycles.push(days);
  }

  return {
    funnel,
    totals: {
      dealsConsidered: included.size,
      firstStage: counts[0] || 0,
      lastStage: counts[finalIndex] || 0
    },
    kpis: {
      revenue: { value: Math.round(revenue), count: paidAmounts.length, available: paidAmounts.length > 0 },
      averageCheck: { value: averageCheck, count: paidAmounts.length, available: paidAmounts.length > 0 },
      overallConversion: {
        value: counts[0] ? Math.round((counts[finalIndex] / counts[0]) * 1000) / 10 : 0,
        available: counts[0] > 0
      },
      averageCycleDays: {
        value: cycles.length ? Math.round((cycles.reduce((sum, item) => sum + item, 0) / cycles.length) * 10) / 10 : 0,
        count: cycles.length,
        available: cycles.length > 0
      },
      workRevenue: { value: Math.round(workRevenue), count: workDealIds.size, available: workDealIds.size > 0 }
    },
    averageCheck: { value: averageCheck, count: paidAmounts.length, available: paidAmounts.length > 0 },
    revenueBySources: [...revenueBySource.values()]
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
  };
}

async function fetchActivity(reference, fromIso, toIso, managerId) {
  const managerFilter = managerId ? { responsibleId: Number(managerId) } : {};
  const activitiesResult = await safeCall('activities', () => searchEntity('activities', {
    filter: {
      ...managerFilter,
      createdAt: { $gte: fromIso, $lte: toIso }
    },
    limit: 5000
  }, { timeoutMs: 10000 }));

  const callsResult = await safeCall('calls/statistics', () => vibe(
    `/calls/statistics?filter[>CALL_START_DATE]=${encodeURIComponent(fromIso)}&filter[<CALL_START_DATE]=${encodeURIComponent(toIso)}`,
    { timeoutMs: 10000 }
  ));

  const managers = new Map(reference.managers.map((item) => [item.id, { ...item, calls: 0, activities: 0 }]));
  const ensureManager = (id) => {
    const key = String(id || 'unknown');
    if (!managers.has(key)) managers.set(key, { id: key, name: key === 'unknown' ? 'Не назначен' : `ID ${key}`, calls: 0, activities: 0 });
    return managers.get(key);
  };

  if (activitiesResult.ok) {
    for (const item of activitiesResult.data) {
      const id = valueOf(item, ['responsibleId', 'RESPONSIBLE_ID', 'authorId', 'AUTHOR_ID'], 'unknown');
      ensureManager(id).activities += 1;
    }
  }

  if (callsResult.ok) {
    const calls = Array.isArray(callsResult.data?.data) ? callsResult.data.data : Array.isArray(callsResult.data) ? callsResult.data : [];
    for (const call of calls) {
      const id = valueOf(call, ['PORTAL_USER_ID', 'portalUserId', 'USER_ID', 'userId'], 'unknown');
      ensureManager(id).calls += 1;
    }
  }

  const rows = [...managers.values()]
    .filter((item) => item.calls || item.activities || (!managerId && reference.managers.length <= 12))
    .sort((a, b) => (b.calls + b.activities) - (a.calls + a.activities))
    .slice(0, 12);

  return {
    available: activitiesResult.ok || callsResult.ok,
    callsAvailable: callsResult.ok,
    activitiesAvailable: activitiesResult.ok,
    rows,
    messages: [
      !callsResult.ok ? 'Данные по звонкам недоступны в текущем API' : null,
      !activitiesResult.ok ? 'Данные по активностям недоступны в текущем API' : null
    ].filter(Boolean)
  };
}

async function dashboard(params) {
  const startedAt = Date.now();
  if (DASHBOARD_SNAPSHOT_FILE) {
    const snapshotPath = join(__dirname, DASHBOARD_SNAPSHOT_FILE);
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    return {
      ...snapshot.data,
      dataQuality: {
        ...(snapshot.data?.dataQuality || {}),
        warnings: [
          ...(snapshot.data?.dataQuality?.warnings || []),
          {
            area: 'local-snapshot',
            code: 'LOCAL_SNAPSHOT',
            message: `Локальная версия показывает снимок реальных данных от ${snapshot.generatedAt || 'неизвестной даты'}`
          }
        ]
      }
    };
  }

  const fromIso = toIsoBoundary(params.get('from'), false);
  const toIso = toIsoBoundary(params.get('to'), true);
  const managerId = params.get('managerId') || '';
  const sourceIdValue = params.get('sourceId') || '';
  const mode = params.get('mode') === 'dynamic' ? 'dynamic' : 'funnel';
  const includeActivity = false;
  const reference = await getReference();
  const activityPromise = includeActivity
    ? fetchActivity(reference, fromIso, toIso, managerId)
    : Promise.resolve({
      available: false,
      callsAvailable: false,
      activitiesAvailable: false,
      rows: [],
      messages: ['Данные по звонкам и активностям отключены для быстрого локального снимка']
    });
  const deals = await fetchDeals(reference, fromIso, toIso, managerId, sourceIdValue);
  const [historyResult, activity] = await Promise.all([
    fetchStageHistory(reference, fromIso, toIso, deals.map(dealId)),
    activityPromise
  ]);
  const analytics = buildFunnelAnalytics(reference, deals, historyResult, mode);

  const seenManagers = new Set(reference.managers.map((item) => item.id));
  const seenSources = new Set(reference.sources.map((item) => item.id));
  for (const deal of deals) {
    const assigned = dealAssignedById(deal);
    if (assigned && !seenManagers.has(assigned)) {
      reference.managers.push({ id: assigned, name: `ID ${assigned}` });
      seenManagers.add(assigned);
    }
    const source = dealSourceId(deal);
    if (source && !seenSources.has(source)) {
      reference.sources.push({ id: source, name: source });
      seenSources.add(source);
    }
  }

  return {
    filters: {
      from: fromIso.slice(0, 10),
      to: toIso.slice(0, 10),
      managerId,
      sourceId: sourceIdValue,
      mode
    },
    reference,
    funnel: analytics.funnel,
    kpis: analytics.kpis,
    averageCheck: analytics.averageCheck,
    revenueBySources: analytics.revenueBySources,
    activity,
    totals: analytics.totals,
    dataQuality: {
      stageHistoryAvailable: historyResult.available,
      stageHistoryPartial: Boolean(historyResult.partial),
      calculationMs: Date.now() - startedAt,
      warnings: [
        ...reference.warnings,
        !historyResult.available ? { area: 'stage-history', ...historyResult.error } : null,
        historyResult.partial ? { area: 'stage-history', code: 'PARTIAL_HISTORY', message: 'История стадий получена через ограниченный список записей' } : null,
        { area: 'paid-invoices', code: 'INVOICES_UNAVAILABLE', message: 'Оплаченные счета недоступны в текущем API, средний чек рассчитан по суммам сделок на финальном этапе' }
      ].filter(Boolean)
    }
  };
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(__dirname, 'public', safePath);
  if (!filePath.startsWith(join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=60'
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// Живучесть: единичный отвязанный rejected-промис или исключение вне цепочки хендлера
// не должны ронять процесс для всех пользователей за прокси-туннелем. Логируем, НЕ выходим.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
});
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error?.stack || error?.message || error);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/health') {
      // Liveness: процесс жив. ВСЕГДА 200 — платформенный healthcheck не должен рестартить
      // контейнер из-за пустого кэша/сломанного синка (готовность вынесена на /ready).
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/ready') {
      // Readiness: приложение реально работоспособно (есть данные, синк не в ошибке, ключ задан).
      const snapshot = await store.getSnapshot();
      const dealsCount = snapshot.deals.length;
      const syncStatus = snapshot.sync?.status || 'unknown';
      const ready = !configDegraded && dealsCount > 0 && syncStatus !== 'error';
      json(res, ready ? 200 : 503, {
        ready,
        dealsCount,
        syncStatus,
        configDegraded,
        cacheUpdatedAt: snapshot.updatedAt || null
      });
      return;
    }
    if (url.pathname === '/api/dashboard') {
      if (config.demoMode) {
        json(res, 404, { success: false, error: { code: 'DEMO_UNAVAILABLE', message: 'В демо-режиме используется dashboard-v2' } });
        return;
      }
      json(res, 200, { success: true, data: await dashboard(url.searchParams) });
      return;
    }
    if (url.pathname === '/api/dashboard-v2') {
      const snapshot = await getPublicSnapshot();
      const periodType = url.searchParams.get('periodType') || 'quarter';
      const periodValue = url.searchParams.get('periodValue') || url.searchParams.get('quarter') || '';
      const plans = publicPlans(await salesPlanStore.getPlansForMonths(monthKeysForPeriod(periodType, periodValue)));
      const settings = await dashboardSettingsStore.load();
      json(res, 200, {
        success: true,
        data: buildDashboardFromCache(snapshot, {
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to'),
          periodType,
          periodValue: periodValue || undefined,
          granularity: url.searchParams.get('granularity') || 'week',
          managerId: url.searchParams.get('managerId') || '',
          sourceId: url.searchParams.get('sourceId') || '',
          ...extraFiltersFromQuery(url.searchParams),
          mode: url.searchParams.get('mode') || 'dynamic'
        }, { plans, settings })
      });
      return;
    }
    if (url.pathname === '/api/period-contracts') {
      const snapshot = await getPublicSnapshot();
      const rows = periodContractDeals(snapshot, {
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        periodType: url.searchParams.get('periodType') || 'quarter',
        periodValue: url.searchParams.get('periodValue') || undefined,
        managerId: url.searchParams.get('managerId') || '',
        sourceId: url.searchParams.get('sourceId') || '',
        ...extraFiltersFromQuery(url.searchParams),
        mode: url.searchParams.get('mode') || 'dynamic'
      }).map((row) => ({
        ...row,
        url: config.demoMode ? null : `${config.bitrixPortalUrl}/crm/deal/details/${encodeURIComponent(row.id)}/`
      }));
      json(res, 200, {
        success: true,
        data: { rows, total: rows.reduce((sum, row) => sum + row.amount, 0), count: rows.length }
      });
      return;
    }
    if (url.pathname === '/api/slice-deals') {
      const snapshot = await getPublicSnapshot();
      const result = sliceDeals(snapshot, {
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        periodType: url.searchParams.get('periodType') || 'quarter',
        periodValue: url.searchParams.get('periodValue') || undefined,
        managerId: url.searchParams.get('managerId') || '',
        sourceId: url.searchParams.get('sourceId') || '',
        ...extraFiltersFromQuery(url.searchParams),
        mode: url.searchParams.get('mode') || 'dynamic'
      }, {
        slice: url.searchParams.get('slice') || '',
        sliceValue: url.searchParams.get('sliceValue') || ''
      });
      if (!result) {
        json(res, 400, { success: false, error: { code: 'BAD_SLICE', message: 'Неизвестный срез или значение среза' } });
        return;
      }
      result.rows = result.rows.map((row) => ({
        ...row,
        url: config.demoMode ? null : `${config.bitrixPortalUrl}/crm/deal/details/${encodeURIComponent(row.id)}/`
      }));
      json(res, 200, { success: true, data: result });
      return;
    }
    if (url.pathname === '/api/ai-insights' && req.method === 'POST') {
      if (!config.aiEnabled || !config.vibeApiKey) {
        json(res, 503, { success: false, error: { code: 'AI_DISABLED', message: 'ИИ-аналитик недоступен: не задан VIBE_API_KEY' } });
        return;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Ожидается JSON-объект' } });
        return;
      }
      const snapshot = await getPublicSnapshot();
      const periodType = body.periodType || 'quarter';
      const periodValue = body.periodValue || body.quarter || '';
      const plans = publicPlans(await salesPlanStore.getPlansForMonths(monthKeysForPeriod(periodType, periodValue)));
      // Инсайты считает Opus (~30–90с) — синхронный ответ не укладывается в таймаут прокси-туннеля
      // и возвращал клиенту HTML 504 → «Unexpected token '<'». Поэтому: готово быстро — 200,
      // иначе 202 pending + фон, фронт опрашивает тем же запросом (buildSalesInsights дедупит
      // по кэшу in-flight promise — второго платного вызова не будет).
      const insightsPromise = buildSalesInsights(snapshot, {
        from: body.from || null,
        to: body.to || null,
        periodType,
        periodValue: periodValue || undefined,
        granularity: body.granularity || 'week',
        managerId: body.managerId || '',
        sourceId: body.sourceId || '',
        ...extraFiltersFromBody(body),
        mode: body.mode || 'dynamic'
      }, { plans });
      insightsPromise.catch(() => {}); // фон не должен ронять процесс unhandled rejection
      let insightsTimer;
      const raced = await Promise.race([
        insightsPromise.then((data) => ({ ready: true, data }), (error) => ({ ready: true, error })),
        new Promise((resolve) => { insightsTimer = setTimeout(() => resolve({ ready: false }), 2000); })
      ]);
      clearTimeout(insightsTimer);
      if (!raced.ready) {
        json(res, 202, { success: true, data: { status: 'pending' } });
        return;
      }
      if (raced.error) {
        logProblem({ category: 'ai', code: raced.error.code || 'AI_ERROR', message: raced.error.message });
        json(res, raced.error.status || 502, { success: false, error: { code: raced.error.code || 'AI_ERROR', message: raced.error.message } });
        return;
      }
      json(res, 200, { success: true, data: raced.data });
      return;
    }
    if (url.pathname === '/api/ai-chat' && req.method === 'POST') {
      if (!config.aiEnabled || !config.vibeApiKey) {
        json(res, 503, { success: false, error: { code: 'AI_DISABLED', message: 'ИИ-аналитик недоступен: не задан VIBE_API_KEY' } });
        return;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
        json(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Ожидается JSON-объект с массивом messages' } });
        return;
      }
      const last = body.messages[body.messages.length - 1];
      if (!last || last.role !== 'user' || typeof last.content !== 'string' || !last.content.trim()) {
        json(res, 400, { success: false, error: { code: 'NO_QUESTION', message: 'Нет вопроса пользователя' } });
        return;
      }
      const snapshot = await getPublicSnapshot();
      const periodType = body.periodType || 'quarter';
      const periodValue = body.periodValue || body.quarter || '';
      const plans = publicPlans(await salesPlanStore.getPlansForMonths(monthKeysForPeriod(periodType, periodValue)));
      const filters = {
        from: body.from || null,
        to: body.to || null,
        periodType,
        periodValue: periodValue || undefined,
        granularity: body.granularity || 'week',
        managerId: body.managerId || '',
        sourceId: body.sourceId || '',
        ...extraFiltersFromBody(body),
        mode: body.mode || 'dynamic'
      };
      // Чат может уйти в долгий разбор сделки (Opus + Битрикс) — не укладываемся в таймаут туннеля:
      // быстро готово — 200, иначе 202 pending + фон, фронт опрашивает тем же запросом (дедуп по ключу).
      const chatPromise = getChatAnswer({ snapshot, filters, plans, messages: body.messages });
      chatPromise.catch(() => {});
      let chatTimer;
      const raced = await Promise.race([
        chatPromise.then((data) => ({ ready: true, data }), (error) => ({ ready: true, error })),
        new Promise((resolve) => { chatTimer = setTimeout(() => resolve({ ready: false }), 2000); })
      ]);
      clearTimeout(chatTimer);
      if (!raced.ready) {
        json(res, 202, { success: true, data: { status: 'pending' } });
        return;
      }
      if (raced.error) {
        logProblem({ category: 'ai', code: raced.error.code || 'AI_ERROR', message: raced.error.message });
        json(res, raced.error.status || 502, { success: false, error: { code: raced.error.code || 'AI_ERROR', message: raced.error.message } });
        return;
      }
      json(res, 200, { success: true, data: raced.data });
      return;
    }
    if (url.pathname === '/api/ai-reports/generate' && req.method === 'POST') {
      if (!config.aiEnabled || !config.vibeApiKey) {
        json(res, 503, { success: false, error: { code: 'AI_DISABLED', message: 'ИИ-аналитик недоступен: не задан VIBE_API_KEY' } });
        return;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        json(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Ожидается JSON-объект' } });
        return;
      }
      const periodType = ['month', 'quarter'].includes(body.periodType) ? body.periodType : 'quarter';
      const periodValueRaw = body.periodValue || body.quarter || '';
      const periodValuePattern = { month: /^\d{4}-\d{2}$/, quarter: /^\d{4}-Q[1-4]$/ }[periodType];
      if (periodValueRaw && !periodValuePattern.test(String(periodValueRaw))) {
        json(res, 400, { success: false, error: { code: 'BAD_PERIOD_VALUE', message: `Неверный формат periodValue для ${periodType}` } });
        return;
      }
      const snapshot = await getPublicSnapshot();
      const plans = publicPlans(await salesPlanStore.getPlansForMonths(monthKeysForPeriod(periodType, periodValueRaw)));
      // Долгий синхронный ответ (Opus через polza ~30–90с) не укладывается в таймаут прокси-туннеля
      // и возвращает клиенту HTML 504 → «Unexpected token '<'». Поэтому: готово быстро — отдаём 200,
      // иначе считаем в фоне и отдаём 202 pending; фронт опрашивает тем же запросом (buildSalesReport
      // дедупит одинаковую генерацию по кэшу — второго платного вызова не будет).
      const reportPromise = buildSalesReport(snapshot, {
        periodType,
        periodValue: periodValueRaw || undefined,
        managerId: body.managerId || '',
        sourceId: body.sourceId || '',
        ...extraFiltersFromBody(body),
        mode: body.mode || 'dynamic'
      }, { plans });
      reportPromise.catch(() => {}); // фон не должен ронять процесс unhandled rejection
      let reportTimer;
      const raced = await Promise.race([
        reportPromise.then((data) => ({ ready: true, data }), (error) => ({ ready: true, error })),
        new Promise((resolve) => { reportTimer = setTimeout(() => resolve({ ready: false }), 2000); })
      ]);
      clearTimeout(reportTimer);
      if (!raced.ready) {
        json(res, 202, { success: true, data: { status: 'pending', periodType, periodValue: periodValueRaw || null } });
        return;
      }
      if (raced.error) throw raced.error;
      json(res, 200, { success: true, data: raced.data });
      return;
    }
    if (url.pathname === '/api/ai-reports' && req.method === 'GET') {
      if (config.demoMode) {
        json(res, 200, { success: true, data: [] });
        return;
      }
      const periodType = url.searchParams.get('periodType') || '';
      const limit = Number(url.searchParams.get('limit') || 20);
      const data = await aiReportStore.list(periodType || undefined, Number.isFinite(limit) ? limit : 20);
      json(res, 200, { success: true, data });
      return;
    }
    if (url.pathname.startsWith('/api/ai-reports/') && req.method === 'GET') {
      if (config.demoMode) {
        json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'В демо-режиме сохранённые отчёты скрыты' } });
        return;
      }
      const parts = url.pathname.split('/').filter(Boolean); // ['api','ai-reports',<type>,<key>]
      const periodType = decodeURIComponent(parts[2] || '');
      const periodKey = decodeURIComponent(parts[3] || '');
      if (!['month', 'quarter', 'week'].includes(periodType) || !periodKey) {
        json(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: 'Ожидается /api/ai-reports/<periodType>/<periodKey>' } });
        return;
      }
      const data = await aiReportStore.get(periodType, periodKey);
      if (!data) {
        json(res, 404, { success: false, error: { code: 'NOT_FOUND', message: 'Отчёт не найден' } });
        return;
      }
      json(res, 200, { success: true, data });
      return;
    }
    if (url.pathname === '/api/dashboard-settings') {
      if (req.method === 'GET') {
        json(res, 200, { success: true, data: await dashboardSettingsStore.load() });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJsonBody(req);
        json(res, 200, { success: true, data: await dashboardSettingsStore.update(body) });
        return;
      }
    }
    if (url.pathname === '/api/sales-plans') {
      const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '')
        ? url.searchParams.get('month')
        : currentMonthKey();
      if (req.method === 'GET') {
        json(res, 200, { success: true, data: publicPlans(await salesPlanStore.getMonth(month)) });
        return;
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJsonBody(req);
        const data = await salesPlanStore.setMonth(month, body.managerPlans || {});
        json(res, 200, { success: true, data });
        return;
      }
    }
    if (url.pathname === '/api/reference') {
      if (config.demoMode) {
        json(res, 404, { success: false, error: { code: 'DEMO_UNAVAILABLE', message: 'Служебный справочник скрыт в демо-режиме' } });
        return;
      }
      json(res, 200, { success: true, data: await getReference() });
      return;
    }
    if (url.pathname === '/api/sync-status') {
      json(res, 200, { success: true, data: await getSyncStatus() });
      return;
    }
    if (url.pathname === '/api/diagnostics') {
      const [snapshot, cache] = await Promise.all([getPublicSnapshot(), store.cacheInfo()]);
      json(res, 200, { success: true, data: getDiagnostics({ snapshot, config, cache }) });
      return;
    }
    if (url.pathname === '/api/polza-balance' && req.method === 'GET') {
      if (config.demoMode) {
        json(res, 503, { success: false, error: { code: 'DEMO_UNAVAILABLE', message: 'Баланс провайдера скрыт в демо-режиме' } });
        return;
      }
      // Баланс шлюза polza — только для провайдера 'openai' (polza). Ключ/база из .env, клиенту НЕ отдаём.
      if (config.aiChatProvider !== 'openai' || !config.aiChatBaseUrl || !config.aiChatApiKey) {
        json(res, 503, { success: false, error: { code: 'AI_NO_KEY', message: 'Баланс доступен только при провайдере polza (AI_CHAT_PROVIDER=openai с ключом)' } });
        return;
      }
      try {
        const data = await gatewayBalance({ apiKey: config.aiChatApiKey, baseUrl: config.aiChatBaseUrl, balancePath: config.polzaBalancePath });
        json(res, 200, { success: true, data });
      } catch (error) {
        // Баланс — вспомогательная фича; её сбой НЕ пишем в журнал проблем (не системная ошибка ИИ).
        json(res, error.status || 502, { success: false, error: { code: error.code || 'POLZA_BALANCE', message: error.message } });
      }
      return;
    }
    if (url.pathname === '/api/sync' && req.method === 'POST') {
      const result = await runExclusiveSync(() => fullSync());
      json(res, 200, { success: true, data: { ...(await getSyncStatus()), result } });
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    logProblem({ category: 'api', code: error.code || 'APP_ERROR', message: error.message });
    json(res, error.status || 500, {
      success: false,
      error: {
        code: error.code || 'APP_ERROR',
        message: error.code === 'NO_API_KEY' ? 'Ключ API не настроен на сервере' : error.message || 'Ошибка приложения'
      }
    });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] порт ${PORT} уже занят — завершаюсь`);
    process.exit(1);
  }
  console.error('[server] ошибка сервера:', error?.stack || error?.message || error);
});

server.listen(PORT, () => {
  console.log(`Project sales demo dashboard listening on ${PORT}`);
  if (configDegraded) {
    console.warn('[config] VIBE_API_KEY не задан — синк отключён, /ready вернёт 503 до наполнения кэша');
  }
  if (!config.demoMode) {
    startSyncScheduler();
    startReportScheduler();
  }
});
