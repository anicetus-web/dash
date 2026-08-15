import { sparkYTicks } from './sparkAxis.js';

const state = {
  data: null,
  loading: false,
  reloadQueued: false,
  aiLoading: false,
  employeeCardIds: [],
  employeeCardsBusy: false,
  mode: 'dynamic',
  shareMode: 'count',  // В11: режим долей источников оплат («count» | «revenue»), из localStorage при инициализации
  avgMode: 'median',   // тумблер среднего чека («median» | «mean»), из localStorage при инициализации
  periodType: 'quarter',
  periodValue: currentQuarterKey(),
  granularity: '',
  dashSeq: 0,        // H-8/M-1: монотонный № запроса дашборда
  contractsSeq: 0    // M-1: монотонный № запроса договоров
};

const coolPalette = ['#4f6bc4', '#6f86c0', '#7f9fe8', '#9fc0ff', '#b3a8e8', '#5aa9e6', '#86b8d0'];

const els = {
  shell: document.querySelector('#dashboardShell'),
  sidebarToggle: document.querySelector('#sidebarToggle'),
  periodTabs: [...document.querySelectorAll('[data-period-type]')],
  quarterSelect: document.querySelector('#quarterSelect'),
  planMonthSelect: document.querySelector('#planMonthSelect'),
  dayInput: document.querySelector('#dayInput'),
  weekInput: document.querySelector('#weekInput'),
  monthInput: document.querySelector('#monthInput'),
  yearSelect: document.querySelector('#yearSelect'),
  granularitySelect: document.querySelector('#granularitySelect'),
  managerSelect: document.querySelector('#managerSelect'),
  sourceSelect: document.querySelector('#sourceSelect'),
  objectTypeSelect: document.querySelector('#objectTypeSelect'),
  clientTypeSelect: document.querySelector('#clientTypeSelect'),
  needSelect: document.querySelector('#needSelect'),
  projectRoleSelect: document.querySelector('#projectRoleSelect'),
  citySelect: document.querySelector('#citySelect'),
  turnoverSelect: document.querySelector('#turnoverSelect'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  refreshButton: document.querySelector('#refreshButton'),
  openPlansButton: document.querySelector('#openPlansButton'),
  closePlansButton: document.querySelector('#closePlansButton'),
  savePlansButton: document.querySelector('#savePlansButton'),
  plansModal: document.querySelector('#plansModal'),
  plansModalTitle: document.querySelector('#plansModalTitle'),
  apiStatus: document.querySelector('#apiStatus'),
  periodLabel: document.querySelector('#periodLabel'),
  freshnessLabel: document.querySelector('#freshnessLabel'),
  planProgressMetric: document.querySelector('#planProgressMetric'),
  planRadial: document.querySelector('#planRadial'),
  planDialSvg: document.querySelector('#planDialSvg'),
  planMetric: document.querySelector('#planMetric'),
  contractMetric: document.querySelector('#contractMetric'),
  contractFactValue: document.querySelector('#contractFactValue'),
  contractDelta: document.querySelector('#contractDelta'),
  workRevenueMetric: document.querySelector('#workRevenueMetric'),
  averageCheckMetric: document.querySelector('#averageCheckMetric'),
  averageCheckDelta: document.querySelector('#averageCheckDelta'),
  averageCheckHint: document.querySelector('#averageCheckHint'),
  averageCheckTrend: document.querySelector('#averageCheckTrend'),
  contractConversionMetric: document.querySelector('#contractConversionMetric'),
  contractConversionDelta: document.querySelector('#contractConversionDelta'),
  dealCycleDelta: document.querySelector('#dealCycleDelta'),
  contractConversionHint: document.querySelector('#contractConversionHint'),
  contractConversionTrend: document.querySelector('#contractConversionTrend'),
  conversionFromSelect: document.querySelector('#conversionFromSelect'),
  conversionToSelect: document.querySelector('#conversionToSelect'),
  dealCycleMetric: document.querySelector('#dealCycleMetric'),
  dealCycleHint: document.querySelector('#dealCycleHint'),
  dealCycleTrend: document.querySelector('#dealCycleTrend'),
  cycleStartSelect: document.querySelector('#cycleStartSelect'),
  revenueTitle: document.querySelector('#revenueTitle'),
  revenueTrend: document.querySelector('#revenueTrend'),
  funnelChart: document.querySelector('#funnelChart'),
  funnelTotalMetric: document.querySelector('#funnelTotalMetric'),
  funnelConversionMetric: document.querySelector('#funnelConversionMetric'),
  stageChartSelects: [document.querySelector('#stageChartSelect0'), document.querySelector('#stageChartSelect1')],
  customChartTitles: [document.querySelector('#customChartTitle0'), document.querySelector('#customChartTitle1')],
  customTrends: [document.querySelector('#customTrend0'), document.querySelector('#customTrend1')],
  averageCheckCard: document.querySelector('#averageCheckCard'),
  avgModeButtons: [...document.querySelectorAll('[data-avg-mode]')],
  sourceRankChart: document.querySelector('#sourceRankChart'),
  sourceTrend: document.querySelector('#sourceTrend'),
  shareModeButtons: [...document.querySelectorAll('[data-share-mode]')],
  failureReasonChart: document.querySelector('#failureReasonChart'),
  failureReasonTrend: document.querySelector('#failureReasonTrend'),
  contractsModal: document.querySelector('#contractsModal'),
  contractsModalTitle: document.querySelector('#contractsModalTitle'),
  contractsModalEyebrow: document.querySelector('#contractsModalEyebrow'),
  closeContractsButton: document.querySelector('#closeContractsButton'),
  contractsList: document.querySelector('#contractsList'),
  employeeCardsGrid: document.querySelector('#employeeCardsGrid'),
  addEmployeeCardButton: document.querySelector('#addEmployeeCardButton'),
  employeePicker: document.querySelector('#employeePicker'),
  employeePickerSearch: document.querySelector('#employeePickerSearch'),
  employeePickerList: document.querySelector('#employeePickerList'),
  managerPlanList: document.querySelector('#managerPlanList'),
  messages: document.querySelector('#messages'),
  aiGenerateButton: document.querySelector('#aiGenerateButton'),
  aiMenu: document.querySelector('#aiMenu'),
  aiMenuItems: [...document.querySelectorAll('.ai-menu-item')],
  aiInsights: document.querySelector('#aiInsights'),
  aiMeta: document.querySelector('#aiMeta'),
  aiChatLog: document.querySelector('#aiChatLog'),
  aiChatForm: document.querySelector('#aiChatForm'),
  aiChatInput: document.querySelector('#aiChatInput'),
  aiChatSend: document.querySelector('#aiChatSend'),
  aiChatClear: document.querySelector('#aiChatClear'),
  aiChatNote: document.querySelector('#aiChatNote'),
  diagOpenButton: document.querySelector('#diagOpenButton'),
  diagCloseButton: document.querySelector('#diagCloseButton'),
  diagPanel: document.querySelector('#diagPanel'),
  diagHealth: document.querySelector('#diagHealth'),
  diagLog: document.querySelector('#diagLog'),
  diagCategoryFilter: document.querySelector('#diagCategoryFilter'),
  diagCopyButton: document.querySelector('#diagCopyButton'),
  polzaBalance: document.querySelector('#polzaBalance'),
  polzaBalanceRefresh: document.querySelector('#polzaBalanceRefresh')
};

function currentQuarterKey(date = new Date()) {
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `${date.getFullYear()}-Q${quarter}`;
}

function currentWeekKey(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function quarterLabel(key) {
  const [year, quarter] = String(key).split('-Q');
  return `${quarter} квартал ${year}`;
}

function periodTypeLabel(type) {
  return { day: 'день', week: 'неделя', month: 'месяц', quarter: 'квартал', year: 'год' }[type] || 'период';
}

function quarterOptions() {
  const now = new Date();
  const rows = [];
  for (let offset = -7; offset <= 2; offset += 1) {
    const date = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3 + offset * 3, 1);
    rows.push(currentQuarterKey(date));
  }
  return rows.reverse();
}

function yearOptions() {
  const year = new Date().getFullYear();
  return Array.from({ length: 6 }, (_, index) => String(year + 1 - index));
}

function monthKeyOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [year, month] = String(key).split('-').map(Number);
  const name = new Date(Date.UTC(year, (month || 1) - 1, 1)).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function monthOptions() {
  const now = new Date();
  const rows = [];
  for (let offset = 2; offset >= -11; offset -= 1) {
    rows.push(monthKeyOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1))));
  }
  return rows;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey() {
  return new Date().toISOString().slice(0, 7);
}

function setStatus(text, mode = '') {
  els.apiStatus.textContent = text;
  els.apiStatus.className = `status-pill ${mode}`.trim();
}

function formatDateTime(value) {
  if (!value) return 'синхронизация еще не выполнялась';
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function money(value) {
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0
  }).format(value || 0);
}

function compactMoney(value) {
  const number = Number(value || 0);
  const abs = Math.abs(number);
  if (abs >= 1000000) return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(number / 1000000)} млн ₽`;
  if (abs >= 1000) return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(number / 1000)} тыс ₽`;
  return money(number);
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value || 0);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortLabel(value, limit = 14) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// ── Диагностика: клиентский журнал + снимок здоровья ─────────────────────
const DIAG_MAX = 200;                 // автоочистка: держим последние N записей
const diag = { client: [], server: [], health: null, timer: null };

// Серверные проблемы приходят с короткими кодами категорий (api/ai/sync/deal/…);
// приводим к русским названиям — тем же, что в <option> фильтра #diagCategoryFilter.
const SERVER_CATEGORY_RU = {
  sync: 'Синхронизация', ai: 'ИИ-чат', report: 'Отчёт', deal: 'Разбор сделки',
  api: 'API', net: 'Сеть', network: 'Сеть', config: 'Конфигурация', app: 'API'
};

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
  if (n >= 1024) return `${Math.round(n / 1024)} КБ`;
  return `${n} Б`;
}

// Категории фронта совпадают с <option> в #diagCategoryFilter и словарём сервера.
function logClientProblem(category, code, message, detail) {
  diag.client.unshift({
    at: new Date().toISOString(),
    source: 'client',
    category: String(category || 'API'),
    code: String(code || ''),
    message: String(message || ''),
    detail: detail == null ? '' : String(detail)
  });
  if (diag.client.length > DIAG_MAX) diag.client.length = DIAG_MAX;
  // индикатор на шестерёнке — есть свежие проблемы
  if (els.diagOpenButton) els.diagOpenButton.classList.add('has-alert');
  if (els.diagPanel && !els.diagPanel.hidden) renderDiagLog();
}

// Извлечь человекочитаемое сообщение из пойманной ошибки fetch/JSON.
// Возвращает {category, code, message} по классу ошибки (см. словарь RELIABILITY_TZ).
function classifyClientError(error, fallbackCategory) {
  const raw = String(error?.message || error || '');
  if (/Failed to fetch|NetworkError|fetch failed/i.test(raw)) {
    return { category: 'Сеть', code: 'NETWORK',
      message: 'Нет связи с сервером. Проверьте интернет и обновите страницу.' };
  }
  if (/Unexpected token '<'|неожиданный ответ|неверном формате/i.test(raw)) {
    return { category: 'Сеть', code: 'TUNNEL_HTML',
      message: 'Сервер сейчас недоступен через туннель — ответ пришёл в неверном формате. Повторите позже.' };
  }
  // прочее — показываем как есть, но с категорией вызова
  return { category: fallbackCategory || 'API', code: '', message: raw || 'Неизвестная ошибка' };
}

function diagCategoryClass(category) {
  const map = {
    'Синхронизация': 'sync', 'ИИ-чат': 'ai', 'Отчёт': 'report',
    'Разбор сделки': 'deal', 'API': 'api', 'Сеть': 'net', 'Конфигурация': 'config'
  };
  return map[category] || 'api';
}

// Рендер снимка здоровья. Поля соответствуют контракту getDiagnostics() (Итерация 0):
// sync.{status,lastSuccessAt,lastError,warningsCount,dealsCount,historyComplete}, ai.{provider,model,*Set}, cache.{exists,sizeBytes,updatedAt}.
function renderDiagHealth() {
  const h = diag.health;
  if (!h) {
    els.diagHealth.innerHTML = '<div class="empty">Состояние недоступно — сервер не ответил на /api/diagnostics.</div>';
    return;
  }
  const s = h.sync || {};
  const ai = h.ai || {};
  const c = h.cache || {};
  const syncStatus = { idle: 'ок', ok: 'ок', running: 'идёт синхронизация', error: 'ошибка', degraded: 'деградация' }[s.status] || (s.status || '—');
  // formatDateTime(null) вернёт «синхронизация еще не выполнялась» (см. formatDateTime) — читаемо в контексте строки.
  const rows = [
    ['Синхронизация', `${escapeHtml(syncStatus)} · последнее успешное: ${escapeHtml(formatDateTime(s.lastSuccessAt))}`]
  ];
  if (s.lastError) rows.push(['Последняя ошибка синка', escapeHtml(String(s.lastError))]);
  rows.push(
    ['Сделок в кэше', `${formatNumber(s.dealsCount || 0)}`],
    ['Предупреждений последнего синка', `${formatNumber(s.warningsCount || 0)}`],
    ['История стадий', s.historyComplete ? 'дозагружена' : 'в процессе'],
    ['ИИ-провайдер', `${escapeHtml(ai.provider || '—')} · модель ${escapeHtml(ai.model || '—')}`],
    ['Ключ VibeCode задан', ai.vibeApiKeySet ? 'да' : 'нет'],
    ['Ключ ИИ-чата задан', ai.chatApiKeySet ? 'да' : 'нет'],
    ['Кэш', `${c.exists ? escapeHtml(formatBytes(c.sizeBytes)) : 'нет файла'} · обновлён ${escapeHtml(formatDateTime(c.updatedAt))}`]
  );
  els.diagHealth.innerHTML = rows.map(([k, v]) =>
    `<div class="diag-health-row"><span class="diag-k">${escapeHtml(k)}</span><span class="diag-v">${v}</span></div>`
  ).join('');
}

function renderDiagLog() {
  // мерж: клиентские + серверные, новые сверху, с фильтром по категории
  const all = [...diag.client, ...diag.server].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const filter = els.diagCategoryFilter.value;
  const rows = filter ? all.filter((r) => r.category === filter) : all;
  if (!rows.length) {
    els.diagLog.innerHTML = '<div class="empty">Проблем не зафиксировано.</div>';
    return;
  }
  els.diagLog.innerHTML = rows.slice(0, DIAG_MAX).map((r) => `
    <div class="diag-entry diag-entry--${diagCategoryClass(r.category)}">
      <div class="diag-entry-meta">
        <span class="diag-time">${escapeHtml(formatDateTime(r.at))}</span>
        <span class="diag-cat">${escapeHtml(r.category)}</span>
      </div>
      <div class="diag-entry-text">${escapeHtml(r.message)}</div>
      ${r.detail ? `<div class="diag-entry-detail">${escapeHtml(r.detail)}</div>` : ''}
    </div>`).join('');
}

// ── Сетевой помощник против «Unexpected token '<'» ───────────────────────────────────────
// Не-JSON приходит, когда прокси-туннель VibeCode рвёт долгий запрос и отдаёт HTML-страницу
// шлюза (504/502) или приложение спит. Голый res.json() на таком HTML бросает сырое
// «Unexpected token '<', "<!DOCTYPE"…». Эти помощники читают тело как текст и разбирают безопасно.
//
// Низкоуровневый: НЕ бросает на не-JSON — возвращает флаг isJson (для опроса, где не-JSON = «ещё готовится»).
async function fetchMaybeJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  let isJson = true;
  if (text) {
    try { body = JSON.parse(text); } catch { isJson = false; }
  }
  return { res, body, isJson, text };
}

// Строгий: на не-JSON бросает понятную русскую ошибку вместо «Unexpected token '<'».
// Возвращает { res, body }; вызывающий сам проверяет res.ok / body.success.
async function fetchJson(url, opts) {
  const { res, body, isJson } = await fetchMaybeJson(url, opts);
  if (!isJson) {
    throw new Error('Сервер вернул не-JSON (вероятно таймаут прокси или приложение спит) — повторите через минуту');
  }
  return { res, body };
}

async function refreshDiagnostics() {
  try {
    const { body } = await fetchJson('/api/diagnostics');
    const data = body?.data || body;         // терпим оба формата обёртки
    diag.health = data?.health || null;
    diag.server = Array.isArray(data?.problems)
      ? data.problems.map((p) => ({ ...p, source: 'server', category: SERVER_CATEGORY_RU[p.category] || p.category || 'API' }))
      : [];
  } catch (error) {
    // сам эндпоинт недоступен — не роняем панель, показываем что есть
    diag.health = null;
    logClientProblem('Сеть', 'NETWORK', 'Не удалось получить состояние системы (/api/diagnostics).');
  }
  renderDiagHealth();
  renderDiagLog();
}

// Баланс polza — серверный /api/polza-balance (ключ на клиент не уходит). Запрашиваем только при
// открытии панели и по кнопке (не на 30-сек поллинге), чтобы не частить внешними вызовами шлюза.
async function refreshPolzaBalance() {
  if (!els.polzaBalance) return;
  els.polzaBalance.textContent = '…';
  try {
    const { res, body } = await fetchJson('/api/polza-balance');
    if (res.status === 503) {                 // провайдер не polza / ключ не задан — не «проблема», просто нет данных
      els.polzaBalance.textContent = 'не настроено';
      return;
    }
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось получить баланс');
    const b = body.data?.balance;
    els.polzaBalance.textContent = typeof b === 'number' ? `${formatNumber(b, 2)} ₽` : 'ответ получен, число не распознано';
  } catch (error) {
    // Баланс необязателен — НЕ засоряем журнал проблем; показываем «—» и текст ошибки в подсказке.
    els.polzaBalance.textContent = '—';
    els.polzaBalance.title = error.message || 'Не удалось получить баланс';
  }
}

function openDiag() {
  els.diagPanel.hidden = false;
  els.diagOpenButton?.classList.remove('has-alert');
  refreshDiagnostics();
  refreshPolzaBalance();
  clearInterval(diag.timer);
  diag.timer = setInterval(refreshDiagnostics, 30000);  // обновление раз в 30с, пока открыто
}

function closeDiag() {
  els.diagPanel.hidden = true;
  clearInterval(diag.timer);
  diag.timer = null;
}

function copyDiagLog() {
  const all = [...diag.client, ...diag.server].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const text = all.map((r) =>
    `[${formatDateTime(r.at)}] · ${r.category} · ${r.message}${r.detail ? ` — ${r.detail}` : ''}`
  ).join('\n') || 'Журнал пуст';
  navigator.clipboard?.writeText(text).then(
    () => { els.diagCopyButton.textContent = 'Скопировано'; setTimeout(() => { els.diagCopyButton.textContent = 'Скопировать журнал'; }, 1500); },
    () => { els.diagCopyButton.textContent = 'Не удалось'; setTimeout(() => { els.diagCopyButton.textContent = 'Скопировать журнал'; }, 1500); }
  );
}

function setupPeriodControls() {
  const quarters = quarterOptions();
  els.quarterSelect.innerHTML = quarters.map((key) => `<option value="${key}">${quarterLabel(key)}</option>`).join('');
  els.planMonthSelect.innerHTML = monthOptions().map((key) => `<option value="${key}">${monthLabel(key)}</option>`).join('');
  els.yearSelect.innerHTML = yearOptions().map((year) => `<option value="${year}">${year}</option>`).join('');
  els.quarterSelect.value = state.periodValue;
  els.planMonthSelect.value = monthKey();
  els.dayInput.value = todayKey();
  els.weekInput.value = currentWeekKey();
  els.monthInput.value = monthKey();
  els.yearSelect.value = String(new Date().getFullYear());
  // Детализация: выставляем дефолт под текущий тип периода, иначе первый loadDashboard прочитает
  // из #granularitySelect DOM-дефолт «Дни» (первый <option>) и квартал/месяц покажутся в днях.
  state.granularity = granularityForPeriodType(state.periodType);
  els.granularitySelect.value = state.granularity;
  updatePeriodVisibility();
}

function updatePeriodVisibility() {
  const controls = {
    day: els.dayInput,
    week: els.weekInput,
    month: els.monthInput,
    quarter: els.quarterSelect,
    year: els.yearSelect
  };
  for (const [type, control] of Object.entries(controls)) {
    control.hidden = type !== state.periodType;
  }
  for (const tab of els.periodTabs) {
    tab.classList.toggle('active', tab.dataset.periodType === state.periodType);
  }
}

function activePeriodValue() {
  if (state.periodType === 'day') return els.dayInput.value || todayKey();
  if (state.periodType === 'week') return els.weekInput.value || currentWeekKey();
  if (state.periodType === 'month') return els.monthInput.value || monthKey();
  if (state.periodType === 'year') return els.yearSelect.value || String(new Date().getFullYear());
  return els.quarterSelect.value || currentQuarterKey();
}

function optionList(select, placeholder, rows) {
  const selected = select.value;
  select.innerHTML = `<option value="">${placeholder}</option>`;
  for (const row of rows || []) {
    const option = document.createElement('option');
    option.value = row.id;
    option.textContent = row.name;
    select.append(option);
  }
  select.value = [...select.options].some((item) => item.value === selected) ? selected : '';
}

// Итерация 2: значения шести доп-фильтров одним объектом — для всех запросов среза.
function extraFilterValues() {
  return {
    objectType: els.objectTypeSelect.value,
    clientType: els.clientTypeSelect.value,
    need: els.needSelect.value,
    projectRole: els.projectRoleSelect.value,
    city: els.citySelect.value,
    turnover: els.turnoverSelect.value
  };
}

function setMode(mode) {
  state.mode = mode === 'static' ? 'static' : 'dynamic';
  for (const button of els.modeButtons) {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderDial(el, pct) {
  if (!el) return;
  const size = 210;
  const N = 60;
  const gap = 60; // градусы пустой дуги снизу
  const span = 360 - gap;
  const start = 90 + gap / 2;
  const cx = size / 2;
  const cy = size / 2;
  const rOut = size / 2 - 6;
  const rIn = rOut - 24;
  const filled = Math.max(0, Math.min(N, Math.round((pct / 100) * N)));
  // Цвета подобраны под светлую тему: заполнено — синий → стале-синий, пусто — тёмный тинт.
  const onA = [127, 159, 232];
  const onB = [79, 107, 196];
  const off = 'rgba(19,26,43,0.12)';
  const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));
  let lines = '';
  for (let i = 0; i < N; i += 1) {
    const ang = (start + (i / (N - 1)) * span) * Math.PI / 180;
    const on = i < filled;
    const t = filled > 1 ? i / (filled - 1) : 0;
    const [r, g, b] = on ? mix(onA, onB, t) : [0, 0, 0];
    const x1 = cx + Math.cos(ang) * rIn;
    const y1 = cy + Math.sin(ang) * rIn;
    const x2 = cx + Math.cos(ang) * rOut;
    const y2 = cy + Math.sin(ang) * rOut;
    const stroke = on ? `rgb(${r},${g},${b})` : off;
    const glow = on ? ' style="filter:drop-shadow(0 0 2.5px rgba(127,159,232,0.85))"' : '';
    lines += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="3.4" stroke-linecap="round"${glow}></line>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Выполнение плана ${formatNumber(pct, 0)}%">${lines}</svg>`;
}

function renderKpis(data) {
  const plan = data.salesPlan || {};
  const kpis = data.kpis || {};
  const progress = plan.plan ? plan.progress : 0;
  els.planProgressMetric.textContent = formatNumber(progress, 0);
  renderDial(els.planDialSvg, Math.min(100, progress));
  els.planMetric.textContent = compactMoney(plan.plan);
  els.planMetric.title = money(plan.plan);
  // Значение «Факт» — во внутренний span (в dd#contractMetric лежит ещё бейдж дельты, textContent затёр бы его).
  els.contractFactValue.textContent = compactMoney(plan.fact || kpis.contractSigned?.value || 0);
  els.contractMetric.title = money(plan.fact || kpis.contractSigned?.value || 0);
  els.workRevenueMetric.textContent = compactMoney(kpis.workRevenue?.value || kpis.potential?.value || 0);
  els.workRevenueMetric.title = money(kpis.workRevenue?.value || kpis.potential?.value || 0);
  // В13 + тумблер медиана/среднее: крупная цифра, подпись, дельта и тренд — по выбранному режиму.
  renderAverageCheck(kpis.averageCheck);
  els.contractConversionMetric.textContent = `${formatNumber(kpis.contractConversion?.value || 0, 1)}%`;
  els.contractConversionHint.textContent = `${formatNumber(kpis.contractConversion?.count || 0)} из ${formatNumber(kpis.contractConversion?.base || 0)}`;
  els.dealCycleMetric.textContent = kpis.dealCycle?.available ? `${formatNumber(kpis.dealCycle.value, 1)} дн.` : '0 дн.';
  els.dealCycleHint.textContent = kpis.dealCycle?.count ? `${formatNumber(kpis.dealCycle.count)} договоров` : 'нет договоров';
  // В9: дельты к предыдущему периоду. Для цикла сделки рост = плохо (invert).
  renderDeltaBadge(els.contractDelta, kpis.contractSigned?.delta);
  renderDeltaBadge(els.contractConversionDelta, kpis.contractConversion?.delta);
  renderDeltaBadge(els.dealCycleDelta, kpis.dealCycle?.delta, { invert: true });
  renderTrendChart(els.contractConversionTrend, kpis.contractConversion?.trend || [], { percent: true, title: 'Конверсия' });
  renderTrendChart(els.dealCycleTrend, kpis.dealCycle?.trend || [], { digits: 1, unit: 'д', title: 'Цикл сделки' });
}

function yTicks(max, moneyMode) {
  return [0, 0.25, 0.5, 0.75, 1].map((part) => ({
    value: max * part,
    label: moneyMode ? compactMoney(max * part).replace(' ₽', '') : formatNumber(max * part, 0)
  }));
}

function renderLineChart(el, rows, options = {}) {
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">Нет данных за период</div>';
    return;
  }
  const width = 720;
  const height = options.compact ? 215 : 255;
  const pad = { top: 26, right: 18, bottom: 34, left: 52 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...rows.flatMap((row) => [row.current, row.previous]));
  const denom = Math.max(1, rows.length - 1);
  const px = (index) => pad.left + (plotW / denom) * index;
  const py = (value) => pad.top + plotH - ((value || 0) / max) * plotH;
  const curPts = rows.map((row, index) => ({ x: px(index), y: py(row.current) }));
  const prevPts = rows.map((row, index) => ({ x: px(index), y: py(row.previous) }));
  const toLine = (pts) => pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const currentLine = toLine(curPts);
  const previousLine = toLine(prevPts);
  const area = `${pad.left},${pad.top + plotH} ${currentLine} ${pad.left + plotW},${pad.top + plotH}`;
  const labelEvery = rows.length > 14 ? Math.ceil(rows.length / 7) : 1;
  const xLabels = rows.map((row, index) => {
    if (index % labelEvery !== 0 && index !== rows.length - 1) return '';
    return `<text x="${px(index)}" y="${height - 12}" text-anchor="middle" class="axis-label">${escapeHtml(row.label)}</text>`;
  }).join('');
  const tickLines = yTicks(max, options.money).map((tick) => {
    const y = py(tick.value);
    return `
      <line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="grid-line"></line>
      <text x="${pad.left - 10}" y="${y + 4}" text-anchor="end" class="axis-label">${escapeHtml(tick.label)}</text>
    `;
  }).join('');
  // подписи значений только на «пиках» текущей серии — иначе график зашумлён
  const isPeak = (index) => {
    const value = rows[index].current || 0;
    const prev = rows[index - 1]?.current || 0;
    const next = rows[index + 1]?.current || 0;
    return value > max * 0.06 && (index === 0 || value >= prev) && (index === rows.length - 1 || value >= next);
  };
  const valueLabels = curPts.map((p, index) => {
    if (!isPeak(index)) return '';
    const value = rows[index].current || 0;
    const label = options.money ? compactMoney(value).replace(' ₽', '') : formatNumber(value, 0);
    return `<text x="${p.x}" y="${p.y - 11}" text-anchor="middle" class="value-label">${escapeHtml(label)}</text>`;
  }).join('');
  const currentDots = curPts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3.2" class="line-dot current"></circle>`).join('');
  const previousDots = prevPts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.6" class="line-dot previous"></circle>`).join('');
  const gradId = `area-${options.id || 'chart'}`;

  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title || 'График')}">
      <defs>
        <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" style="stop-color:var(--accent-ink);stop-opacity:0.20"></stop>
          <stop offset="100%" style="stop-color:var(--accent-ink);stop-opacity:0"></stop>
        </linearGradient>
      </defs>
      ${tickLines}
      <polygon points="${area}" fill="url(#${gradId})"></polygon>
      <polyline points="${previousLine}" class="line previous-line"></polyline>
      <polyline points="${currentLine}" class="line current-line"></polyline>
      ${previousDots}
      ${currentDots}
      ${valueLabels}
      ${xLabels}
    </svg>
    <div class="chart-legend">
      <span><i class="legend-current"></i>Текущий период</span>
      <span><i class="legend-previous"></i>Предыдущий период</span>
    </div>
  `;
  const fmt = (value) => (options.money ? compactMoney(value) : formatNumber(value, 0));
  attachLineTooltip(el, { rows, width, height, pad, plotW, plotH, max, fmt });
}

// Hover-тултип для линейных графиков: значение ближайшей точки для текущей и пунктирной (прошлой) линий.
function attachLineTooltip(el, config) {
  const { rows, width, height, pad, plotW, plotH, max, fmt } = config;
  const svg = el.querySelector('svg');
  if (!svg || !rows.length) return;
  const denom = Math.max(1, rows.length - 1);
  const py = (value) => pad.top + plotH - ((value || 0) / max) * plotH;
  el.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'chart-overlay';
  overlay.innerHTML = `
    <div class="chart-cursor"></div>
    <div class="chart-focus current"></div>
    <div class="chart-focus previous"></div>
    <div class="chart-tip">
      <div class="chart-tip__label"></div>
      <div class="chart-tip__row"><i></i><span>Текущий период</span><b class="chart-tip__val v-cur"></b></div>
      <div class="chart-tip__row"><i class="prev"></i><span>Прошлый период</span><b class="chart-tip__val v-prev"></b></div>
    </div>`;
  el.appendChild(overlay);
  const cursor = overlay.querySelector('.chart-cursor');
  const focusCur = overlay.querySelector('.chart-focus.current');
  const focusPrev = overlay.querySelector('.chart-focus.previous');
  const tip = overlay.querySelector('.chart-tip');
  const labelEl = tip.querySelector('.chart-tip__label');
  const vCur = tip.querySelector('.v-cur');
  const vPrev = tip.querySelector('.v-prev');
  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const elRect = el.getBoundingClientRect();
    const sx = rect.width / width;
    const sy = rect.height / height;
    const vbX = (event.clientX - rect.left) / sx;
    let idx = Math.round((vbX - pad.left) / (plotW / denom));
    idx = Math.max(0, Math.min(rows.length - 1, idx));
    const row = rows[idx];
    const offX = rect.left - elRect.left;
    const offY = rect.top - elRect.top;
    const xPx = offX + (pad.left + (plotW / denom) * idx) * sx;
    cursor.style.left = `${xPx}px`;
    cursor.style.top = `${offY + pad.top * sy}px`;
    cursor.style.height = `${plotH * sy}px`;
    focusCur.style.left = `${xPx}px`;
    focusCur.style.top = `${offY + py(row.current) * sy}px`;
    focusPrev.style.left = `${xPx}px`;
    focusPrev.style.top = `${offY + py(row.previous) * sy}px`;
    labelEl.textContent = row.label || '';
    vCur.textContent = fmt(row.current || 0);
    vPrev.textContent = fmt(row.previous || 0);
    const flip = xPx > elRect.width - 130;
    tip.style.left = `${xPx + (flip ? -12 : 12)}px`;
    tip.style.top = `${offY + pad.top * sy}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : 'none';
  };
  svg.addEventListener('mouseenter', () => { overlay.style.opacity = '1'; });
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => { overlay.style.opacity = '0'; });
}

// В1: упрощённый hover-тултип спарклайна — одна серия: курсор, точка-фокус, плашка «период: значение».
// Перерисовка безопасна: el.innerHTML в renderTrendChart сносит старый overlay со svg (накопления слушателей нет).
function attachSparkTooltip(el, config) {
  const { points, width, height, pad, plotW, plotH, px, py, fmt } = config;
  const svg = el.querySelector('svg');
  if (!svg || !points.length) return;
  const denom = Math.max(1, points.length - 1);
  el.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'chart-overlay';
  overlay.innerHTML = `
    <div class="chart-cursor"></div>
    <div class="chart-focus current"></div>
    <div class="chart-tip">
      <div class="chart-tip__label"></div>
      <b class="chart-tip__val"></b>
    </div>`;
  el.appendChild(overlay);
  const cursor = overlay.querySelector('.chart-cursor');
  const focus = overlay.querySelector('.chart-focus');
  const tip = overlay.querySelector('.chart-tip');
  const labelEl = tip.querySelector('.chart-tip__label');
  const valEl = tip.querySelector('.chart-tip__val');
  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const elRect = el.getBoundingClientRect();
    const sx = rect.width / width;
    const sy = rect.height / height;
    const vbX = (event.clientX - rect.left) / sx;
    let idx = Math.round((vbX - pad.left) / (plotW / denom));
    idx = Math.max(0, Math.min(points.length - 1, idx));
    const point = points[idx];
    const offX = rect.left - elRect.left;
    const offY = rect.top - elRect.top;
    const xPx = offX + px(idx) * sx;
    cursor.style.left = `${xPx}px`;
    cursor.style.top = `${offY + pad.top * sy}px`;
    cursor.style.height = `${plotH * sy}px`;
    focus.style.left = `${xPx}px`;
    focus.style.top = `${offY + py(point.value || 0) * sy}px`;
    labelEl.textContent = point.label || '';
    valEl.textContent = fmt(point.value || 0);
    const flip = xPx > elRect.width - 90; // спарклайн узкий — порог меньше, чем у больших графиков
    tip.style.left = `${xPx + (flip ? -10 : 10)}px`;
    tip.style.top = `${offY + pad.top * sy}px`;
    tip.style.transform = flip ? 'translateX(-100%)' : 'none';
  };
  svg.addEventListener('mouseenter', () => { overlay.style.opacity = '1'; });
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseleave', () => { overlay.style.opacity = '0'; });
}

function renderRankChart(el, rows, options = {}) {
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">Нет данных за период</div>';
    return;
  }
  const width = 720;
  const height = 250;
  const pad = { top: 28, right: 24, bottom: 54, left: 28 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const valueKey = options.valueKey || 'revenue';
  const max = Math.max(1, ...rows.map((row) => row[valueKey] || 0));
  const denom = Math.max(1, rows.length - 1);
  const points = rows.map((row, index) => {
    const x = pad.left + (plotW / denom) * index;
    const y = pad.top + plotH - ((row[valueKey] || 0) / max) * plotH;
    return { x, y };
  });
  const line = points.map((p) => `${p.x},${p.y}`).join(' ');
  const area = `${pad.left},${pad.top + plotH} ${line} ${pad.left + plotW},${pad.top + plotH}`;
  const labels = rows.map((row, index) => {
    const p = points[index];
    const value = row[valueKey] || 0;
    const valueLabel = options.money ? compactMoney(value).replace(' ₽', '') : formatNumber(value, 0);
    return `
      <circle cx="${p.x}" cy="${p.y}" r="7" class="line-dot current"></circle>
      <text x="${p.x}" y="${p.y - 14}" text-anchor="middle" class="value-label">${escapeHtml(valueLabel)}</text>
      <text x="${p.x}" y="${height - 21}" text-anchor="middle" class="axis-label rank-label">
        <title>${escapeHtml(row.name)}</title>${escapeHtml(shortLabel(row.name))}
      </text>
    `;
  }).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title || 'Рейтинг')}">
      <polygon points="${area}" fill="rgba(45, 212, 191, 0.18)"></polygon>
      <polyline points="${line}" fill="none" class="line current-line"></polyline>
      ${labels}
    </svg>
  `;
}

// Сквозной контроллер подсветки: связывает несколько представлений одного среза по ключу.
// keyOf(row) -> ключ сопоставления; представления регистрируются через register({ setHi }).
function createHighlight(keyOf = (r) => r.id ?? r.name) {
  const subs = [];
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  return {
    keyOf,
    norm,
    register(view) { subs.push(view); },
    emit(key) {
      const k = key == null ? null : norm(key);
      for (const view of subs) view.setHi(k);
    }
  };
}

// В11: панель «Источники оплат» — донат + тренд перерисовываются ВМЕСТЕ, чтобы кросс-подсветка жила
// на свежем контроллере (createHighlight не умеет unregister). Переключение тумблера — из state.data, без запроса.
function drawSourcesPanel(data) {
  const byRevenue = state.shareMode === 'revenue';
  const rows = data.sourcePaymentShare || [];
  const totalRevenue = rows.reduce((sum, row) => sum + (row.revenue || 0), 0);
  const sourceHi = createHighlight((r) => r.id);
  renderSourceDonut(els.sourceRankChart, rows, {
    centerLabel: byRevenue ? 'выручка' : 'договоров',
    centerValue: byRevenue ? compactMoney(totalRevenue) : undefined,
    percentKey: byRevenue ? 'percentByRevenue' : 'percentByCount',
    keyOf: (r) => r.id,
    highlight: sourceHi
  });
  renderMultiTrendChart(els.sourceTrend, data.sourcesTrend, { title: 'Источники оплат', highlight: sourceHi });
}

function renderSourceDonut(el, rows, options = {}) {
  const centerLabel = options.centerLabel || 'договоров';
  const percentKey = options.percentKey || 'percent'; // В11: 'percentByRevenue' | 'percentByCount' | 'percent'
  if (!rows?.length) {
    el.innerHTML = '<div class="empty">Нет данных за период</div>';
    return;
  }
  const size = 196;
  const thickness = 26;
  const R = (size - thickness) / 2;
  const C = 2 * Math.PI * R;
  const cx = size / 2;
  const cy = size / 2;
  const totalN = rows.reduce((sum, row) => sum + (row.count || 0), 0);
  const centerValue = options.centerValue != null ? options.centerValue : formatNumber(totalN);
  let acc = 0;
  const segs = rows.map((row, index) => {
    const pct = row[percentKey] ?? row.percent ?? 0;
    const len = (pct / 100) * C;
    const off = (acc / 100) * C;
    acc += pct;
    return { row, index, len, off, color: coolPalette[index % coolPalette.length] };
  });
  const circles = segs.map((g) => `<circle data-i="${g.index}" cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${g.color}" stroke-width="${thickness}" stroke-dasharray="${g.len.toFixed(2)} ${(C - g.len).toFixed(2)}" stroke-dashoffset="${(-g.off).toFixed(2)}"></circle>`).join('');
  const legend = segs.map((g) => `
    <div class="glass-donut__leg glass-donut__leg--clickable" data-i="${g.index}" data-slice-id="${escapeHtml(String(g.row.id ?? g.row.name))}" data-slice-name="${escapeHtml(g.row.name)}" role="button" tabindex="0" title="Показать сделки: ${escapeHtml(g.row.name)}">
      <i style="background:${g.color}"></i>
      <span class="leg-name" title="${escapeHtml(g.row.name)}">${escapeHtml(g.row.name)}</span>
      <span class="leg-val">${formatNumber(g.row.count || 0)}${g.row.revenue ? ` · ${escapeHtml(compactMoney(g.row.revenue))}` : ''}</span>
      <span class="leg-pct">${formatNumber(g.row[percentKey] ?? g.row.percent ?? 0, 1)}%</span>
    </div>`).join('');
  el.innerHTML = `
    <div class="glass-donut">
      <div class="glass-donut__chart" style="width:${size}px;height:${size}px">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
          <circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="var(--seg-bg)" stroke-width="${thickness}"></circle>
          ${circles}
        </svg>
        <div class="glass-donut__center"><b>${escapeHtml(String(centerValue))}</b><span>${escapeHtml(centerLabel)}</span></div>
      </div>
      <div class="glass-donut__legend">${legend}</div>
    </div>
  `;
  const keyOf = options.keyOf || ((r) => r.id ?? r.name);
  const highlight = options.highlight || null;
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const center = el.querySelector('.glass-donut__center');
  const segCircles = [...el.querySelectorAll('.glass-donut__chart circle[data-i]')];
  const legs = [...el.querySelectorAll('.glass-donut__leg')];
  const applyActive = (active) => {
    for (const circle of segCircles) {
      const i = Number(circle.dataset.i);
      circle.setAttribute('stroke-width', String(i === active ? thickness + 7 : thickness));
      circle.style.opacity = active == null || i === active ? '1' : '0.32';
    }
    for (const leg of legs) leg.classList.toggle('on', Number(leg.dataset.i) === active);
    if (active == null) {
      center.innerHTML = `<b>${escapeHtml(String(centerValue))}</b><span>${escapeHtml(centerLabel)}</span>`;
    } else {
      const row = rows[active];
      center.innerHTML = `<b>${formatNumber(row[percentKey] ?? row.percent ?? 0, 1)}%</b><span>${escapeHtml(row.name)}</span>`;
    }
  };
  // Подсветка по ключу: если ключа нет среди строк — нейтральный сброс (донат автономно остаётся как есть).
  const setActiveByKey = (key) => {
    if (key == null) { applyActive(null); return; }
    const idx = rows.findIndex((r) => norm(keyOf(r)) === key);
    applyActive(idx >= 0 ? idx : null);
  };
  if (highlight) highlight.register({ setHi: setActiveByKey });
  for (const node of [...segCircles, ...legs]) {
    const idx = Number(node.dataset.i);
    node.addEventListener('mouseenter', () => {
      if (highlight) highlight.emit(keyOf(rows[idx]));
      else applyActive(idx);
    });
    node.addEventListener('mouseleave', () => {
      if (highlight) highlight.emit(null);
      else applyActive(null);
    });
  }
}

// В9: бейдж дельты к предыдущему периоду: «↑ +12%» / «↓ −8%»; invert — рост это плохо (цикл сделки).
function renderDeltaBadge(el, delta, options = {}) {
  if (!el) return;
  if (delta == null || !Number.isFinite(delta)) { el.hidden = true; return; }
  el.hidden = false;
  el.title = 'к предыдущему периоду';
  if (delta === 0) {
    el.className = 'kpi-delta delta-zero';
    el.textContent = '0%';
    return;
  }
  const up = delta > 0;
  const good = options.invert ? !up : up;
  el.className = `kpi-delta ${good ? 'delta-good' : 'delta-bad'}`;
  el.textContent = `${up ? '↑' : '↓'} ${up ? '+' : '−'}${formatNumber(Math.abs(delta), 1)}%`;
}

function renderTrendChart(el, points, options = {}) {
  if (!el) return;
  if (!points?.length) {
    el.innerHTML = '<div class="spark-empty">нет данных</div>';
    return;
  }
  // В1: значение в тултипе (по ховеру). Для чисел — с единицей измерения (unit), напр. «32,5 д».
  const fmt = options.money
    ? (value) => compactMoney(value).replace(' ₽', '')
    : options.percent
      ? (value) => `${formatNumber(value, 1)}%`
      : (value) => `${formatNumber(value, options.digits || 0)}${options.unit ? ` ${options.unit}` : ''}`;
  // Подписи делений оси: круглые значения; ноль — просто «0» (money(0) дал бы «0 ₽» с неразрывным пробелом).
  const fmtTick = (value) => {
    if (!value) return '0';
    if (options.money && value < 1000) return formatNumber(value, 0);
    if (options.percent) return `${formatNumber(value, 1)}%`;
    return options.money ? compactMoney(value).replace(' ₽', '') : `${formatNumber(value, 1)}${options.unit ? ` ${options.unit}` : ''}`;
  };
  const width = 346; // было 320: +26 слева под подписи оси Y
  const height = 92;
  const pad = { top: 16, right: 14, bottom: 18, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const values = points.map((p) => p.value || 0);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const denom = Math.max(1, points.length - 1);
  const px = (index) => pad.left + (plotW / denom) * index;
  const py = (value) => pad.top + plotH - ((value - min) / Math.max(1, max - min)) * plotH;
  const pts = points.map((p, index) => ({ x: px(index), y: py(p.value || 0) }));
  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `${pad.left},${pad.top + plotH} ${line} ${pad.left + plotW},${pad.top + plotH}`;
  const dots = pts.map((p, index) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${index === pts.length - 1 ? 3.2 : 2.2}" class="line-dot current"></circle>`).join('');
  // Ось Y: 2–3 круглых деления по диапазону данных (В1).
  const axis = sparkYTicks(min, max).map((tick) => {
    const y = py(tick);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" class="grid-line"></line>`
      + `<text x="${(pad.left - 5).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis-label spark-y">${escapeHtml(fmtTick(tick))}</text>`;
  }).join('');
  const xLabels = points.map((p, index) => `<text x="${px(index).toFixed(1)}" y="${height - 5}" text-anchor="middle" class="axis-label spark-x">${escapeHtml(p.label)}</text>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title || 'Динамика')}">
      ${axis}
      <polygon points="${area}" fill="rgba(127,159,232,0.14)"></polygon>
      <polyline points="${line}" class="line current-line"></polyline>
      ${dots}${xLabels}
    </svg>`;
  attachSparkTooltip(el, { points, width, height, pad, plotW, plotH, px, py, fmt });
}

function renderMultiTrendChart(el, data, options = {}) {
  if (!el) return;
  const labels = data?.labels || [];
  const series = (data?.series || []).filter((item) => (item.values || []).some((value) => value > 0));
  if (!labels.length || !series.length) {
    el.innerHTML = '<div class="empty">Нет данных за период</div>';
    return;
  }
  const width = 720;
  const height = 215;
  const pad = { top: 20, right: 16, bottom: 30, left: 38 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((item) => item.values));
  const denom = Math.max(1, labels.length - 1);
  const px = (index) => pad.left + (plotW / denom) * index;
  const py = (value) => pad.top + plotH - ((value || 0) / max) * plotH;
  const lines = series.map((item, si) => {
    const color = coolPalette[si % coolPalette.length];
    const key = String(item.id ?? item.name);
    const point = item.values.map((value, index) => `${px(index).toFixed(1)},${py(value).toFixed(1)}`).join(' ');
    const dots = item.values.map((value, index) => `<circle data-key="${escapeHtml(key)}" cx="${px(index).toFixed(1)}" cy="${py(value).toFixed(1)}" r="2.6" fill="${color}"></circle>`).join('');
    // прозрачная hit-зона поверх линии — по тонкой линии (2.2) трудно попасть курсором
    const hit = `<polyline data-key="${escapeHtml(key)}" points="${point}" fill="none" stroke="transparent" stroke-width="12" style="pointer-events:stroke"></polyline>`;
    return `<polyline data-key="${escapeHtml(key)}" points="${point}" fill="none" stroke="${color}" stroke-width="2.2"></polyline>${dots}${hit}`;
  }).join('');
  const grid = [0, 0.5, 1].map((part) => {
    const y = py(max * part);
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="grid-line"></line><text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" class="axis-label">${formatNumber(max * part, 0)}</text>`;
  }).join('');
  const xLabels = labels.map((label, index) => `<text x="${px(index).toFixed(1)}" y="${height - 12}" text-anchor="middle" class="axis-label">${escapeHtml(label)}</text>`).join('');
  const legend = series.map((item, si) => `<span data-key="${escapeHtml(String(item.id ?? item.name))}"><i style="background:${coolPalette[si % coolPalette.length]}"></i>${escapeHtml(shortLabel(item.name, 22))}</span>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(options.title || 'Динамика')}">
      ${grid}${lines}${xLabels}
    </svg>
    <div class="chart-legend">${legend}</div>`;

  const highlight = options.highlight || null;
  if (!highlight) return;
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const keys = new Set(series.map((item) => norm(item.id ?? item.name)));
  const keyed = [...el.querySelectorAll('[data-key]')];
  const setHi = (key) => {
    // ключа нет среди линий (донат шире графика) — график нейтрален, ничего не приглушаем
    if (key != null && !keys.has(key)) {
      for (const node of keyed) node.classList.remove('is-dim', 'is-active');
      return;
    }
    for (const node of keyed) {
      node.classList.remove('is-dim', 'is-active');
      if (key == null) continue;
      node.classList.add(norm(node.dataset.key) === key ? 'is-active' : 'is-dim');
    }
  };
  highlight.register({ setHi });
  for (const node of keyed) {
    node.addEventListener('mouseenter', () => highlight.emit(node.dataset.key));
    node.addEventListener('mouseleave', () => highlight.emit(null));
  }
}

function renderFunnel(funnel) {
  const rows = funnel || [];
  if (!rows.length) {
    els.funnelChart.innerHTML = '<div class="empty">Воронка пока не рассчитана</div>';
    els.funnelTotalMetric.textContent = '0';
    els.funnelConversionMetric.innerHTML =
      '<span class="conv-label">Конверсия</span><span class="conv-value">0%</span>';
    return;
  }
  els.funnelTotalMetric.textContent = formatNumber(rows[0]?.count || 0);
  const last = rows[rows.length - 1];
  const first = rows[0]?.count || 0;
  const totalConversion = first ? Math.round((last.count / first) * 1000) / 10 : 0;
  // П9: подпись «из „<первый этап>“ до „<последний этап>“» — имена берём из фактических этапов воронки.
  els.funnelConversionMetric.innerHTML =
    `<span class="conv-label">Конверсия</span><span class="conv-value">${formatNumber(totalConversion, 1)}%</span>`
    + `<span class="conv-note">из «${escapeHtml(rows[0]?.name || '')}» до «${escapeHtml(last?.name || '')}»</span>`;
  const max = Math.max(1, ...rows.map((stage) => stage.count));
  els.funnelChart.innerHTML = `
    <div class="glass-funnel">
      ${rows.map((stage) => {
        const width = Math.max(2, Math.round((stage.count / max) * 100));
        const pct = stage.index === 0 ? '100' : formatNumber(stage.conversion, 1);
        return `
          <div class="glass-funnel__row glass-funnel__row--clickable" role="button" tabindex="0" data-stage-id="${escapeHtml(stage.id)}" data-stage-name="${escapeHtml(stage.name)}" title="Показать сделки ступени «${escapeHtml(stage.name)}»">
            <div class="glass-funnel__name">${stage.index + 1}. ${escapeHtml(stage.name)}</div>
            <div class="glass-funnel__track"><div class="glass-funnel__fill" style="width:${width}%"></div></div>
            <div class="glass-funnel__count">${formatNumber(stage.count)}</div>
            <div class="glass-funnel__conv">${pct}%</div>
          </div>`;
      }).join('')}
    </div>
  `;
}

function stageOptions(stages) {
  return (stages || []).map((stage) => `<option value="${stage.id}">${escapeHtml(stage.name)}</option>`).join('');
}

function renderStageSelectors(data) {
  const options = stageOptions(data.reference?.stages || []);
  for (let index = 0; index < els.stageChartSelects.length; index += 1) {
    const select = els.stageChartSelects[index];
    const selected = data.settings?.stageCharts?.[index] || data.trends?.custom?.[index]?.stageId || '';
    select.innerHTML = options;
    select.value = [...select.options].some((option) => option.value === selected) ? selected : select.options[0]?.value || '';
  }
}

function renderMetricStageSelectors(data) {
  const stages = data.reference?.stages || [];
  // «От» — с достадийными этапами («Заявки маркетинг», В7), «до» — только этапы воронки.
  // Фолбэк по ЗНАЧЕНИЮ (не индексу): NEW первым в списке не должен становиться дефолтом.
  const startOptions = stageOptions([...(data.reference?.preFunnelStages || []), ...stages]);
  const options = stageOptions(stages);
  const conv = data.settings?.conversionStages || [];
  const setSel = (select, value, fallbackValue, html) => {
    if (!select) return;
    select.innerHTML = html;
    const has = (v) => [...select.options].some((option) => option.value === v);
    select.value = has(value) ? value : (has(fallbackValue) ? fallbackValue : select.options[0]?.value || '');
  };
  setSel(els.conversionFromSelect, conv[0], 'C78:PREPARATION', startOptions);
  setSel(els.conversionToSelect, conv[1], 'C78:UC_50O081', options);
  setSel(els.cycleStartSelect, data.settings?.cycleStartStage, 'C78:PREPARATION', startOptions);
}

function renderCustomCharts(data) {
  const charts = data.trends?.custom || [];
  for (let index = 0; index < 2; index += 1) {
    const chart = charts[index];
    els.customChartTitles[index].textContent = chart?.name || 'Этап продаж';
    renderLineChart(els.customTrends[index], chart?.rows || [], {
      id: `custom-${index}`,
      title: chart?.name || 'Этап продаж',
      compact: true,
      money: chart?.metric === 'money'
    });
  }
}

function renderManagerPlans(rows, planRows = rows) {
  const visible = (planRows || []).filter((row) => row.inSalesDepartment || row.responsibleDeals || row.plan || row.fact);
  els.managerPlanList.innerHTML = visible.map((row) => `
    <article class="manager-plan-row">
      <div>
        <strong>${escapeHtml(row.name)}</strong>
        <small>${row.inSalesDepartment ? 'отдел продаж' : 'ответственный за продажи'}</small>
      </div>
      <label>
        <span>План</span>
        <input class="plan-input" data-manager-id="${escapeHtml(row.id)}" inputmode="numeric" value="${row.plan || ''}" placeholder="0">
      </label>
      <div class="manager-fact">
        <span>Факт периода</span>
        <strong>${compactMoney(row.fact)}</strong>
      </div>
      <div class="manager-progress">
        <span>${formatNumber(row.progress, 1)}%</span>
        <i style="--progress:${Math.min(100, row.progress || 0)}"></i>
      </div>
    </article>
  `).join('');
}

async function loadPlanRowsForModal() {
  const month = els.planMonthSelect.value || monthKey();
  els.plansModalTitle.textContent = `Планы менеджеров · ${monthLabel(month)}`;
  try {
    const params = new URLSearchParams({
      periodType: 'month',
      periodValue: month,
      granularity: '',
      managerId: els.managerSelect.value,
      sourceId: els.sourceSelect.value,
      ...extraFilterValues(),
      mode: state.mode
    });
    const { res, body } = await fetchJson(`/api/dashboard-v2?${params}`);
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось загрузить планы');
    renderManagerPlans(body.data?.managerPlanRows || []);
  } catch (error) {
    els.messages.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка загрузки планов')}</div>`;
  }
}

function warningText(warning) {
  if (warning.code === 'SOURCE_OP_BIM_FIELD_PENDING') return 'Поле "Источник ОП БИМ" пока не найдено автоматически.';
  if (warning.code === 'FAILURE_REASON_FIELD_PENDING') return 'Поле причины отказа пока не найдено автоматически.';
  if (warning.code === 'HISTORY_BACKFILL_IN_PROGRESS') return 'История переходов еще догружается пачками.';
  if (warning.code === 'STAGE_HISTORY_BATCH_ERRORS') return 'Часть запросов истории стадий не прошла.';
  return warning.message || warning.code || 'Есть предупреждение по качеству данных';
}

function renderMessages(data) {
  const messages = [];
  if (!data.totals?.deals) messages.push({ type: 'warn', text: 'Локальный кеш пока пуст.' });
  if (!data.totals?.stageEvents) messages.push({ type: 'warn', text: 'Нет истории переходов по стадиям.' });
  for (const warning of data.warnings || []) messages.push({ type: 'warn', text: warningText(warning) });
  els.messages.innerHTML = messages.map((message) => `<div class="message ${message.type === 'error' ? 'error' : ''}">${escapeHtml(message.text)}</div>`).join('');
}

// ——— Карточки сотрудников ———
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const initials = parts.slice(1).map((word) => `${word[0].toUpperCase()}.`).join(' ');
  return `${parts[0]} ${initials}`;
}

function isSalesEmployee(row) {
  return Boolean(row && (row.inSalesDepartment || row.responsibleDeals));
}

function searchKey(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').trim();
}

// Общие defs (силуэт-clip + градиент) — один раз на грид, не по фигуре.
const EMP_FIGURE_DEFS = `
  <svg width="0" height="0" aria-hidden="true" style="position:absolute">
    <defs>
      <clipPath id="emp-silhouette-clip">
        <path d="M32 5 a11 11 0 1 1 -0.01 0 Z M14 84 C14 56 18 40 24 33 L40 33 C46 40 50 56 50 84 Z"></path>
      </clipPath>
      <linearGradient id="emp-fill-grad" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="var(--accent-fill)"></stop>
        <stop offset="100%" stop-color="var(--accent-ink)"></stop>
      </linearGradient>
    </defs>
  </svg>`;

// Состояние фигуры по реальному проценту: <25 дьявол, <90 нейтраль, >=90 успех.
function figureState(pctReal) {
  const p = Math.max(0, Number(pctReal) || 0);
  if (p < 25) return 'devil';
  if (p < 90) return 'mid';
  return 'ok';
}

// Фигура-индикатор: заливка снизу на min(100,pctReal)%, цвет/декор по состоянию, процент внутри.
function employeeFigureSvg(pctReal) {
  const real = Math.max(0, Number(pctReal) || 0);
  const state = figureState(real);
  const h = 84;
  const fillH = (Math.min(100, real) / 100) * h;
  const y = h - fillH;
  const silhouette = 'M32 5 a11 11 0 1 1 -0.01 0 Z M14 84 C14 56 18 40 24 33 L40 33 C46 40 50 56 50 84 Z';
  const reduce = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const spline = 'calcMode="spline" keyTimes="0;1" keySplines="0.25 0.1 0.25 1"';
  const rect = reduce
    ? `<rect x="0" y="${y.toFixed(1)}" width="64" height="${fillH.toFixed(1)}" fill="var(--fig-fill)" clip-path="url(#emp-silhouette-clip)"></rect>`
    : `<rect x="0" y="${h}" width="64" height="0" fill="var(--fig-fill)" clip-path="url(#emp-silhouette-clip)">`
      + `<animate attributeName="y" from="${h}" to="${y.toFixed(1)}" dur="0.9s" fill="freeze" ${spline}></animate>`
      + `<animate attributeName="height" from="0" to="${fillH.toFixed(1)}" dur="0.9s" fill="freeze" ${spline}></animate></rect>`;
  const horns = state === 'devil'
    ? '<path class="emp-fig__horn emp-fig__horn--l" d="M26 5 Q21 -3 19 -9 Q27 -5 30 4 Z"></path>'
      + '<path class="emp-fig__horn emp-fig__horn--r" d="M38 5 Q43 -3 45 -9 Q37 -5 34 4 Z"></path>'
    : '';
  const tail = state === 'devil'
    ? '<path class="emp-fig__tail" d="M49 74 C60 76 63 63 56 60 C61 65 54 68 49 66" fill="none"></path>'
      + '<path class="emp-fig__tail-tip" d="M56 57 l5 1 l-3 5 Z"></path>'
    : '';
  const crown = state === 'ok'
    ? '<path class="emp-fig__crown" d="M22 3 L22 -5 L27 0 L32 -8 L37 0 L42 -5 L42 3 Z"></path>'
    : '';
  return `
    <svg viewBox="0 -12 64 96" role="img" aria-label="Выполнение ${Math.round(real)}%">
      <path d="${silhouette}" fill="var(--seg-bg)" stroke="var(--glass-brd)" stroke-width="1.4"></path>
      ${rect}
      ${tail}${crown}${horns}
      <text class="emp-fig__pct" x="32" y="58" text-anchor="middle" dominant-baseline="central">${formatNumber(real, 0)}%</text>
    </svg>`;
}

// Рисует грид по списку id и данным (без реинициализации state). Возвращает «мёртвые» id (нет строки/не из отдела).
function drawEmployeeCards(ids, data) {
  if (!els.employeeCardsGrid) return [];
  const rowById = new Map((data?.managerPlanRows || []).map((row) => [String(row.id), row]));
  const liveIds = [];
  const deadIds = [];
  for (const id of ids) {
    const row = rowById.get(String(id));
    if (row && isSalesEmployee(row)) liveIds.push(String(id));
    else deadIds.push(String(id));
  }
  if (!liveIds.length) {
    els.employeeCardsGrid.innerHTML = '<div class="employee-cards-empty">Нажмите «+ Добавить», чтобы выбрать сотрудника</div>';
    return deadIds;
  }
  const cards = liveIds.map((id) => {
    const row = rowById.get(id);
    const progress = row.progress || 0;
    const state = figureState(progress);
    const conv = row.conversionBase ? `${formatNumber(row.conversion, 1)}%` : '—';
    const avg = row.avgContractCount ? compactMoney(row.avgCheck) : '—';
    return `
      <article class="emp-card emp-card--${state}" data-id="${escapeHtml(id)}">
        <button class="emp-card__remove" type="button" data-remove="${escapeHtml(id)}" aria-label="Убрать ${escapeHtml(row.name)} из карточек" title="Убрать">×</button>
        <div class="emp-card__name" title="${escapeHtml(row.name)}">${escapeHtml(shortName(row.name))}</div>
        <div class="emp-card__body">
          <dl class="emp-card__metrics emp-card__metrics--left">
            <div><dt>План</dt><dd title="${money(row.plan)}">${compactMoney(row.plan)}</dd></div>
            <div><dt>Факт</dt><dd class="m-fact clickable-fact" role="button" tabindex="0" data-fact-manager="${escapeHtml(id)}" data-manager-name="${escapeHtml(row.name)}" title="Показать договоры · ${money(row.fact)}">${compactMoney(row.fact)}</dd></div>
            <div><dt>Остаток</dt><dd title="${money(row.remaining)}">${compactMoney(row.remaining)}</dd></div>
          </dl>
          <div class="emp-card__figure">${employeeFigureSvg(progress)}</div>
        </div>
        <dl class="emp-card__metrics emp-card__metrics--bottom">
          <div><dt>Конверсия</dt><dd>${conv}</dd></div>
          <div><dt>Средний чек</dt><dd title="${money(row.avgCheck)}">${avg}</dd></div>
          <div><dt>В работе</dt><dd class="m-inwork clickable-fact" role="button" tabindex="0" data-inwork-manager="${escapeHtml(id)}" data-manager-name="${escapeHtml(row.name)}" title="Открытые сделки · ${money(row.inWorkAmount || 0)}">${formatNumber(row.inWorkCount || 0)} · ${compactMoney(row.inWorkAmount || 0)}</dd></div>
        </dl>
      </article>`;
  }).join('');
  els.employeeCardsGrid.innerHTML = EMP_FIGURE_DEFS + cards;
  return deadIds;
}

function renderEmployeeCards(data) {
  if (!els.employeeCardsGrid) return;
  // Источник истины — серверное эхо; локальная оптимистика живёт лишь до reload.
  state.employeeCardIds = (data.settings?.employeeCards || []).map(String);
  const deadIds = drawEmployeeCards(state.employeeCardIds, data);
  syncAddButton();
  if (els.employeePicker && !els.employeePicker.hidden) renderEmployeePickerList();
  // Самоочистка «призраков» (удалённый сотрудник / не из отдела) — один PUT за рендер, не во время записи.
  if (deadIds.length && !state.employeeCardsBusy) {
    state.employeeCardIds = state.employeeCardIds.filter((id) => !deadIds.includes(id));
    saveEmployeeCards();
  }
}

function renderEmployeePickerList() {
  if (!els.employeePickerList) return;
  const managers = (state.data?.reference?.managers || [])
    .filter((manager) => isSalesEmployee(manager) && !state.employeeCardIds.includes(String(manager.id)));
  const query = searchKey(els.employeePickerSearch?.value);
  const filtered = query ? managers.filter((manager) => searchKey(manager.name).includes(query)) : managers;
  if (!filtered.length) {
    const reason = state.employeeCardIds.length >= 12 ? 'Максимум 12 карточек' : 'Нет сотрудников';
    els.employeePickerList.innerHTML = `<div class="emp-picker__empty">${reason}</div>`;
    return;
  }
  els.employeePickerList.innerHTML = filtered
    .map((manager) => `<button type="button" class="emp-picker__item" role="option" data-pick="${escapeHtml(String(manager.id))}">${escapeHtml(manager.name)}</button>`)
    .join('');
}

function toggleEmployeePicker(open) {
  if (!els.employeePicker) return;
  const show = open ?? els.employeePicker.hidden;
  // На лимите 12 кнопка «+» уже дизейблена (syncAddButton) — поповер не открываем, els.messages не трогаем.
  if (show && state.employeeCardIds.length >= 12) return;
  els.employeePicker.hidden = !show;
  els.addEmployeeCardButton.setAttribute('aria-expanded', String(show));
  if (show) {
    els.employeePickerSearch.value = '';
    renderEmployeePickerList();
    els.employeePickerSearch.focus();
  }
}

// Кнопка «+ Добавить» дизейблится во время записи и при достижении лимита 12 (вместо тоста).
function syncAddButton() {
  if (els.addEmployeeCardButton) els.addEmployeeCardButton.disabled = state.employeeCardsBusy || state.employeeCardIds.length >= 12;
}

function setEmployeeButtonsDisabled(disabled) {
  for (const button of els.employeeCardsGrid?.querySelectorAll('.emp-card__remove') || []) button.disabled = disabled;
  syncAddButton();
}

async function saveEmployeeCards() {
  if (state.employeeCardsBusy) return;
  state.employeeCardsBusy = true;
  setEmployeeButtonsDisabled(true);
  try {
    await putDashboardSettings({ employeeCards: state.employeeCardIds });
  } finally {
    state.employeeCardsBusy = false;
    setEmployeeButtonsDisabled(false);
  }
}

function addEmployeeCard(id) {
  const value = String(id || '');
  if (!value || state.employeeCardsBusy) return;
  if (state.employeeCardIds.includes(value) || state.employeeCardIds.length >= 12) return;
  state.employeeCardIds = [...state.employeeCardIds, value];
  drawEmployeeCards(state.employeeCardIds, state.data);
  saveEmployeeCards();
}

function removeEmployeeCard(id) {
  const value = String(id || '');
  if (!value || state.employeeCardsBusy) return;
  state.employeeCardIds = state.employeeCardIds.filter((item) => item !== value);
  drawEmployeeCards(state.employeeCardIds, state.data);
  saveEmployeeCards();
}

function render(data) {
  const { reference, filters = {}, freshness, trends, period } = data;
  optionList(els.managerSelect, 'Все менеджеры', reference?.managers || []);
  optionList(els.sourceSelect, 'Все источники', reference?.sources || []);
  const filterOptions = reference?.filterOptions || {};
  optionList(els.objectTypeSelect, 'Все типы объектов', filterOptions.objectType || []);
  optionList(els.clientTypeSelect, 'Все типы клиентов', filterOptions.clientType || []);
  optionList(els.needSelect, 'Все потребности', filterOptions.need || []);
  optionList(els.projectRoleSelect, 'Все роли', filterOptions.projectRole || []);
  optionList(els.citySelect, 'Все города', filterOptions.city || []);
  optionList(els.turnoverSelect, 'Любой оборот', filterOptions.turnover || []);
  state.periodType = period?.type || filters.periodType || state.periodType;
  state.periodValue = period?.key || filters.periodValue || state.periodValue;
  state.granularity = period?.granularity || filters.granularity || state.granularity;
  updatePeriodVisibility();
  if (state.periodType === 'quarter') els.quarterSelect.value = data.quarter?.key || state.periodValue;
  if (state.periodType === 'day') els.dayInput.value = state.periodValue;
  if (state.periodType === 'week') els.weekInput.value = state.periodValue;
  if (state.periodType === 'month') els.monthInput.value = state.periodValue;
  if (state.periodType === 'year') els.yearSelect.value = state.periodValue;
  els.granularitySelect.value = state.granularity;
  setMode(filters.mode || state.mode);
  const rangeLabel = filters.from && filters.to ? `${filters.from} - ${filters.to}` : '—';
  els.periodLabel.textContent = `${periodTypeLabel(state.periodType)} · ${rangeLabel}`;
  els.freshnessLabel.textContent = `Кеш: ${formatDateTime(freshness?.lastSyncAt)}`;
  els.revenueTitle.textContent = `Выручка: ${periodTypeLabel(state.periodType)}`;
  renderKpis(data);
  renderLineChart(els.revenueTrend, trends?.revenue || [], { id: 'revenue', title: 'Выручка', money: true });
  renderFunnel(data.funnel || []);
  renderStageSelectors(data);
  renderMetricStageSelectors(data);
  renderCustomCharts(data);
  drawSourcesPanel(data);
  const reasonHi = createHighlight((r) => r.name);
  renderSourceDonut(els.failureReasonChart, data.failureReasons || [], { centerLabel: 'отказов', keyOf: (r) => r.name, highlight: reasonHi });
  renderMultiTrendChart(els.failureReasonTrend, data.failureReasonsTrend, { title: 'Причины отказов', highlight: reasonHi });
  renderManagerPlans(data.managerPlanRows || []);
  renderMessages(data);
  renderEmployeeCards(data);
}

async function loadDashboard() {
  if (state.loading) {
    state.reloadQueued = true;
    return;
  }
  state.loading = true;
  state.reloadQueued = false;
  const seq = ++state.dashSeq;      // M-1: этот запрос — текущий
  setStatus('Загрузка данных');
  els.refreshButton.disabled = true;
  state.periodValue = activePeriodValue();
  state.granularity = els.granularitySelect.value;
  const params = new URLSearchParams({
    periodType: state.periodType,
    periodValue: state.periodValue,
    granularity: state.granularity,
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode
  });
  try {
    const { res, body } = await fetchJson(`/api/dashboard-v2?${params}`);
    if (seq !== state.dashSeq) return;   // пришёл ответ на устаревший срез — игнор
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Ошибка подключения к API');
    state.data = body.data;
    render(body.data);
    setStatus('Данные обновлены', 'ok');
  } catch (error) {
    if (seq !== state.dashSeq) return;   // ошибку устаревшего запроса тоже глушим
    setStatus('Ошибка API', 'error');
    const c = classifyClientError(error, 'API');
    logClientProblem(c.category, c.code, c.message);
    els.messages.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка подключения к API')}</div>`;
  } finally {
    els.refreshButton.disabled = false;
    state.loading = false;
    if (state.reloadQueued) loadDashboard();
  }
}

const SEVERITY_LABEL = { critical: 'Критично', warning: 'Внимание', info: 'Инфо' };
const INSIGHT_TYPE_LABEL = {
  conversion: 'Конверсия',
  avg_check: 'Средний чек',
  source: 'Источник',
  manager: 'Менеджер',
  funnel: 'Воронка',
  loss: 'Отказы',
  other: 'Прочее'
};

function renderInsights(data) {
  const insights = data.insights || [];
  if (!insights.length) {
    els.aiInsights.innerHTML = `<div class="ai-placeholder">${escapeHtml(data.summary || 'Нет рекомендаций по текущему срезу.')}</div>`;
  } else {
    const summary = data.summary ? `<div class="ai-summary">${escapeHtml(data.summary)}</div>` : '';
    const cards = insights.map((item) => {
      const severity = ['critical', 'warning', 'info'].includes(item.severity) ? item.severity : 'info';
      const chips = [
        item.entity ? `<span class="ai-chip">${escapeHtml(item.entity)}</span>` : '',
        item.metric ? `<span class="ai-chip ai-chip-metric">${escapeHtml(item.metric)}</span>` : ''
      ].join('');
      return `
        <article class="ai-card ai-${severity}">
          <header class="ai-card-head">
            <span class="ai-badge ai-badge-${severity}">${SEVERITY_LABEL[severity]}</span>
            <span class="ai-type">${escapeHtml(INSIGHT_TYPE_LABEL[item.type] || 'Прочее')}</span>
            <h3 class="ai-card-title">${escapeHtml(item.title || '')}</h3>
          </header>
          <p class="ai-observation">${escapeHtml(item.observation || '')}</p>
          <p class="ai-recommendation"><b>Рекомендация:</b> ${escapeHtml(item.recommendation || '')}</p>
          ${chips ? `<div class="ai-chips">${chips}</div>` : ''}
        </article>`;
    }).join('');
    els.aiInsights.innerHTML = `${summary}<div class="ai-cards">${cards}</div>`;
  }
  const tokens = data.usage?.total_tokens ? ` · ${formatNumber(data.usage.total_tokens)} токенов` : '';
  const cached = data.cached ? ' · из кэша' : '';
  const slice = data.period?.current ? ` · срез ${data.period.current.from}–${data.period.current.to}` : '';
  const modeLabel = data.mode ? ` (${data.mode === 'static' ? 'статика' : 'динамика'})` : '';
  els.aiMeta.textContent = `Модель: ${data.model || ''}${slice}${modeLabel} · ${formatDateTime(data.generatedAt)}${tokens}${cached}`;
  els.aiMeta.hidden = false;
}

const REPORT_PERIOD_LABEL = { week: 'Недельный отчёт', month: 'Месячный отчёт', quarter: 'Квартальный отчёт' };
const CARD_TYPE_LABEL = { anomaly: 'Аномалия', trend: 'Тенденция', pattern: 'Паттерн' };
const CONFIDENCE_LABEL = { low: 'низкая', medium: 'средняя', high: 'высокая' };
const OUTCOME_LABEL = { fixed: 'Исправлено', unchanged: 'Без изменений', worse: 'Ухудшилось', qualitative: 'Качественная' };
const OUTCOME_SEVERITY = { fixed: 'info', unchanged: 'warning', worse: 'critical', qualitative: 'info' };

function formatMetricValue(kind, value) {
  if (value == null) return '—';
  if (kind === 'avg_check' || kind === 'revenue') return compactMoney(value);
  if (kind === 'stage_conversion' || kind === 'source_share') return `${formatNumber(value, 1)}%`;
  if (kind === 'deal_cycle') return `${formatNumber(value, 1)} дн.`;
  return formatNumber(value, 0);
}

function setAiBusy(busy, loadingText) {
  state.aiLoading = busy;
  els.aiGenerateButton.disabled = busy;
  els.aiGenerateButton.textContent = busy ? loadingText : 'Сформировать ▾';
  if (busy) {
    els.aiInsights.innerHTML = '<div class="ai-placeholder ai-loading">ИИ анализирует данные, это занимает несколько секунд…</div>';
    els.aiMeta.hidden = true;
  }
}

async function generateInsights() {
  if (state.aiLoading) return;
  setAiBusy(true, 'Анализирую…');
  const body = {
    periodType: state.periodType,
    periodValue: activePeriodValue(),
    granularity: els.granularitySelect.value,
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode
  };
  // Инсайты считает Opus (~30–90с) — синхронный ответ не укладывается в таймаут прокси-туннеля
  // и возвращал HTML 504 → «Unexpected token '<'». Сервер отдаёт 202 pending, опрашиваем тем же
  // запросом (buildSalesInsights дедупит по кэшу — второго платного вызова нет).
  const started = Date.now();
  const MAX_WAIT_MS = 3 * 60 * 1000;
  try {
    for (;;) {
      const { res, body: payload, isJson } = await fetchMaybeJson('/api/ai-insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const pending = res.status === 202 || !isJson || payload?.data?.status === 'pending';
      if (pending) {
        if (Date.now() - started > MAX_WAIT_MS) {
          throw new Error('Инсайты готовятся дольше обычного — попробуйте ещё раз через минуту');
        }
        setAiBusy(true, 'ИИ анализирует данные… это может занять до минуты');
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      if (res.ok === false || payload.success === false) {
        throw new Error(payload.error?.message || 'Не удалось получить рекомендации');
      }
      renderInsights(payload.data);
      break;
    }
  } catch (error) {
    const c = classifyClientError(error, 'Отчёт');
    logClientProblem(c.category, c.code, c.message);
    els.aiInsights.innerHTML = `<div class="ai-error">${escapeHtml(error.message || 'Ошибка ИИ-аналитика')}</div>`;
    els.aiMeta.hidden = true;
  } finally {
    setAiBusy(false);
  }
}

async function generateReport(periodType) {
  if (state.aiLoading) return;
  setAiBusy(true, 'Готовлю отчёт…');
  const body = {
    periodType,
    periodValue: state.periodType === periodType ? activePeriodValue() : '',
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode
  };
  // Отчёт готовит Opus и это долго: сервер сразу отдаёт 202 pending, а мы опрашиваем тем же
  // запросом, пока не будет готово. Это убирает таймаут прокси-туннеля (ошибку «Unexpected token '<'»).
  const started = Date.now();
  const MAX_WAIT_MS = 3 * 60 * 1000;
  try {
    for (;;) {
      const res = await fetch('/api/ai-reports/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let payload = null;
      try {
        payload = await res.json();
      } catch {
        payload = null; // не-JSON (напр. HTML-страница шлюза) — трактуем как «ещё готовится»
      }
      const pending = res.status === 202 || payload === null || payload?.data?.status === 'pending';
      if (pending) {
        if (Date.now() - started > MAX_WAIT_MS) {
          throw new Error('Отчёт готовится дольше обычного — попробуйте ещё раз через минуту');
        }
        setAiBusy(true, 'Готовлю отчёт… это может занять до минуты');
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      if (res.ok === false || payload.success === false) {
        throw new Error(payload.error?.message || 'Не удалось сформировать отчёт');
      }
      renderReport(payload.data);
      break;
    }
  } catch (error) {
    const c = classifyClientError(error, 'Отчёт');
    logClientProblem(c.category, c.code, c.message);
    els.aiInsights.innerHTML = `<div class="ai-error">${escapeHtml(error.message || 'Ошибка ИИ-аналитика')}</div>`;
    els.aiMeta.hidden = true;
  } finally {
    setAiBusy(false);
  }
}

// ── Чат-вопросы по данным (Claude) ───────────────────────────────────────
const AI_CHAT_KEY = 'aiChat:v1';
const aiChat = { messages: [], busy: false, seq: 0, ctrl: null };

function loadAiChat() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHAT_KEY) || '[]');
    aiChat.messages = Array.isArray(parsed)
      ? parsed.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];
  } catch { aiChat.messages = []; }
  // Если страницу перезагрузили во время ответа — последний ход остался неотвеченным вопросом.
  // Убираем его, чтобы чат не выглядел «зависшим» (пользователь просто спросит заново).
  while (aiChat.messages.length && aiChat.messages[aiChat.messages.length - 1].role === 'user') aiChat.messages.pop();
}
function persistAiChat() {
  try { localStorage.setItem(AI_CHAT_KEY, JSON.stringify(aiChat.messages.slice(-40))); } catch { /* приватный режим — пропускаем */ }
}
// Строчные стили поверх УЖЕ экранированного текста: **жирный**, *курсив*, `код`.
// Подчёркивание (_) намеренно не трогаем — ломает имена полей вроде ufCrm_…
function mdInline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}
function mdCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function isTableSep(line) {
  return line.includes('-') && /^\s*\|?[\s:|-]*-[-\s:|]*\|?\s*$/.test(line);
}
function isBlockStart(line, lines, idx) {
  const t = line.trim();
  return /^#{1,4}\s/.test(t) || /^[-*]\s/.test(t) || /^\d+[.)]\s/.test(t)
    || /^(-{3,}|\*{3,})$/.test(t)
    || (t.includes('|') && idx + 1 < lines.length && isTableSep(lines[idx + 1]));
}
// Лёгкий безопасный Markdown→HTML: экранируем, затем разбираем блоки (таблицы/списки/заголовки/абзацы).
function formatChatContent(text) {
  const src = escapeHtml(String(text == null ? '' : text)).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out = [];
  let listType = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].trim();

    // Таблица: строка с | и следующая — разделитель ---
    if (raw.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      closeList();
      const head = mdCells(raw);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) { rows.push(mdCells(lines[i])); i += 1; }
      const thead = `<thead><tr>${head.map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
      out.push(`<div class="ai-md-tablewrap"><table class="ai-md-table">${thead}${tbody}</table></div>`);
      continue;
    }
    // Заголовок
    const h = raw.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<div class="ai-md-h">${mdInline(h[2])}</div>`); i += 1; continue; }
    // Горизонтальная линия
    if (/^(-{3,}|\*{3,})$/.test(raw)) { closeList(); out.push('<hr>'); i += 1; continue; }
    // Маркированный список
    const ul = raw.match(/^[-*]\s+(.*)$/);
    if (ul) { if (listType !== 'ul') { closeList(); out.push('<ul class="ai-md-list">'); listType = 'ul'; } out.push(`<li>${mdInline(ul[1])}</li>`); i += 1; continue; }
    // Нумерованный список
    const ol = raw.match(/^\d+[.)]\s+(.*)$/);
    if (ol) { if (listType !== 'ol') { closeList(); out.push('<ol class="ai-md-list">'); listType = 'ol'; } out.push(`<li>${mdInline(ol[1])}</li>`); i += 1; continue; }
    // Пустая строка
    if (!raw) { closeList(); i += 1; continue; }
    // Абзац: собираем подряд идущие «обычные» строки
    closeList();
    const para = [raw];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines, i)) { para.push(lines[i].trim()); i += 1; }
    out.push(`<p>${mdInline(para.join('<br>'))}</p>`);
  }
  closeList();
  return out.join('');
}
function renderAiChat() {
  if (!els.aiChatLog) return;
  if (!aiChat.messages.length && !aiChat.busy) {
    els.aiChatLog.innerHTML = '<div class="ai-chat__empty">Задайте вопрос по данным выбранного среза — например, «у какого менеджера самый высокий средний чек?»</div>';
    return;
  }
  const bubbles = aiChat.messages.map((m) => `
    <div class="ai-chat__msg ai-chat__msg--${m.role === 'user' ? 'user' : 'bot'}">${formatChatContent(m.content)}</div>`).join('');
  const typing = aiChat.busy ? '<div class="ai-chat__msg ai-chat__msg--bot ai-chat__typing">Claude думает…</div>' : '';
  els.aiChatLog.innerHTML = bubbles + typing;
  els.aiChatLog.scrollTop = els.aiChatLog.scrollHeight;
}
function setAiChatBusy(busy) {
  if (els.aiChatSend) { els.aiChatSend.disabled = busy; els.aiChatSend.textContent = busy ? '…' : 'Спросить'; }
  if (els.aiChatInput) els.aiChatInput.disabled = busy;
}
async function askAiChat(question) {
  const q = String(question || '').trim();
  if (!q || aiChat.busy) return;
  aiChat.messages.push({ role: 'user', content: q });
  aiChat.busy = true;
  const seq = ++aiChat.seq;                 // M-1: этот запрос — текущий
  const ctrl = new AbortController();        // M-2: отменяемый fetch
  aiChat.ctrl = ctrl;
  persistAiChat();
  renderAiChat();
  setAiChatBusy(true);
  const payloadStr = JSON.stringify({
    periodType: state.periodType,
    periodValue: activePeriodValue(),
    granularity: els.granularitySelect.value,
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode,
    messages: aiChat.messages
  });
  // Чат async (может уйти в долгий разбор сделки): сервер отдаёт 202 pending, опрашиваем.
  const started = Date.now();
  const MAX_WAIT_MS = 3 * 60 * 1000;
  let badStreak = 0;                         // H-9: подряд идущих не-JSON/5xx ответов шлюза
  try {
    for (;;) {
      const res = await fetch('/api/ai-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: payloadStr, signal: ctrl.signal
      });
      if (seq !== aiChat.seq) return;        // M-1: запрос устарел (пришёл новый / очистили)
      let payload = null;
      try { payload = await res.json(); } catch { payload = null; }
      if (seq !== aiChat.seq) return;
      const gatewayError = payload === null && [502, 503, 504].includes(res.status);
      const pending = res.status === 202 || payload?.data?.status === 'pending' || gatewayError;
      // H-9: считаем ТОЛЬКО «мусорные» ответы шлюза; штатный 202 pending сбрасывает счётчик
      if (gatewayError || (payload === null && res.status >= 500)) badStreak += 1; else badStreak = 0;
      if (badStreak >= 4) {
        logClientProblem('ИИ-чат', 'TUNNEL_HTML', 'ИИ-сервис недоступен: 4 ответа шлюза подряд, поллинг остановлен');
        throw new Error('ИИ-сервис сейчас недоступен — попробуйте позже');
      }
      if (pending) {
        if (Date.now() - started > MAX_WAIT_MS) throw new Error('Ответ готовится дольше обычного — попробуйте ещё раз');
        await new Promise((resolve) => setTimeout(resolve, 4000));
        continue;
      }
      if (payload === null) throw new Error('Сервер вернул неожиданный ответ — попробуйте ещё раз');
      if (res.ok === false || payload.success === false) throw new Error(payload.error?.message || 'Не удалось получить ответ');
      aiChat.messages.push({ role: 'assistant', content: payload.data?.answer || '—' });
      if (payload.data?.model && els.aiChatNote) els.aiChatNote.textContent = `модель: ${payload.data.model}`;
      break;
    }
  } catch (error) {
    if (error.name === 'AbortError' || seq !== aiChat.seq) return;   // M-2/M-1: отменённый/устаревший — молча
    const c = classifyClientError(error, 'ИИ-чат');
    logClientProblem(c.category, c.code, c.message);
    aiChat.messages.push({ role: 'assistant', content: `⚠️ ${error.message || 'Ошибка ИИ-чата'}` });
  } finally {
    if (seq === aiChat.seq) {                // финализируем только если мы всё ещё актуальны
      aiChat.busy = false;
      aiChat.ctrl = null;
      persistAiChat();
      setAiChatBusy(false);
      renderAiChat();
    }
  }
}
function clearAiChat() {
  if (aiChat.busy && aiChat.ctrl) {
    aiChat.ctrl.abort();      // M-2: рвём текущий fetch/поллинг
    aiChat.ctrl = null;
  }
  aiChat.seq += 1;            // M-1: любой ответ «в полёте» станет устаревшим и будет проигнорирован
  aiChat.busy = false;
  aiChat.messages = [];
  persistAiChat();
  setAiChatBusy(false);
  renderAiChat();
}

function renderReport(data) {
  const plan = data.plan || {};
  const proj = data.projection || {};
  const report = data.report || {};
  const periodLabel = REPORT_PERIOD_LABEL[data.periodType] || 'Отчёт';
  const periodRange = data.period?.current ? `${data.period.current.from} – ${data.period.current.to}` : '';

  const percentText = plan.percent == null ? 'план не задан' : `${formatNumber(plan.percent, 1)}% плана`;
  const planStatus = `
    <article class="ai-card ai-plan-status">
      <header class="ai-card-head">
        <span class="ai-badge ai-badge-info">${escapeHtml(periodLabel)}</span>
        <span class="ai-type">${escapeHtml(periodRange)}</span>
        <h3 class="ai-card-title">План — Факт — Отставание</h3>
      </header>
      <div class="ai-plan-grid">
        <div><span>План</span><strong title="${money(plan.target || 0)}">${compactMoney(plan.target || 0)}</strong></div>
        <div><span>Факт</span><strong title="${money(plan.fact || 0)}">${compactMoney(plan.fact || 0)}</strong></div>
        <div><span>Отставание</span><strong title="${money(plan.gap || 0)}">${compactMoney(plan.gap || 0)}</strong></div>
        <div><span>Выполнение</span><strong>${escapeHtml(percentText)}</strong></div>
      </div>
      ${report.planComment ? `<p class="ai-observation">${escapeHtml(report.planComment)}</p>` : ''}
    </article>`;

  const cards = (report.cards || []).map((card) => {
    const severity = ['critical', 'warning', 'info'].includes(card.severity) ? card.severity : 'info';
    const chips = [
      card.entity ? `<span class="ai-chip">${escapeHtml(card.entity)}</span>` : '',
      card.metric ? `<span class="ai-chip ai-chip-metric">${escapeHtml(card.metric)}</span>` : ''
    ].join('');
    return `
      <article class="ai-card ai-${severity}">
        <header class="ai-card-head">
          <span class="ai-badge ai-badge-${severity}">${SEVERITY_LABEL[severity]}</span>
          <span class="ai-type">${escapeHtml(CARD_TYPE_LABEL[card.type] || 'Анализ')}</span>
          <h3 class="ai-card-title">${escapeHtml(card.title || '')}</h3>
        </header>
        ${card.evidence ? `<p class="ai-observation">${escapeHtml(card.evidence)}</p>` : ''}
        ${card.hypothesis ? `<p class="ai-observation ai-hypothesis"><b>Гипотеза:</b> ${escapeHtml(card.hypothesis)}</p>` : ''}
        ${chips ? `<div class="ai-chips">${chips}</div>` : ''}
      </article>`;
  }).join('');

  const recs = (report.recommendations || []).map((rec) => `
    <article class="ai-card ai-rec">
      <header class="ai-card-head">
        <span class="ai-badge ai-badge-rec">${formatNumber(rec.priority || 0)}</span>
        ${rec.targetEntity ? `<span class="ai-type">${escapeHtml(rec.targetEntity)}</span>` : ''}
        <h3 class="ai-card-title">${escapeHtml(rec.text || '')}</h3>
      </header>
      ${rec.expectedEffect ? `<p class="ai-observation"><b>Ожидаемый эффект:</b> ${escapeHtml(rec.expectedEffect)}</p>` : ''}
    </article>`).join('');

  const hit = proj.willHitPlan;
  const hitText = hit == null ? 'план не задан' : hit ? 'по текущему темпу план выполняется' : 'по текущему темпу план под угрозой';
  const forecast = `
    <article class="ai-card ai-forecast ${hit === false ? 'ai-warning' : 'ai-info'}">
      <header class="ai-card-head">
        <span class="ai-badge ai-badge-info">Прогноз</span>
        <span class="ai-type">надёжность: ${escapeHtml(CONFIDENCE_LABEL[proj.confidence] || '—')}</span>
        <h3 class="ai-card-title">Прогноз по плану</h3>
      </header>
      <div class="ai-plan-grid">
        <div><span>Прогноз на период</span><strong title="${money(proj.projectedFact || 0)}">${compactMoney(proj.projectedFact || 0)}</strong></div>
        <div><span>Разрыв до плана</span><strong title="${money(proj.gapToPlan || 0)}">${proj.gapToPlan == null ? '—' : compactMoney(proj.gapToPlan)}</strong></div>
        <div><span>Итог</span><strong>${escapeHtml(hitText)}</strong></div>
      </div>
      ${report.forecast ? `<p class="ai-observation">${escapeHtml(report.forecast)}</p>` : ''}
    </article>`;

  const outcomes = (data.recommendationOutcomes || []).map((o) => {
    const severity = OUTCOME_SEVERITY[o.status] || 'info';
    const kind = o.metricRef?.kind;
    const beforeAfter = (o.before != null && o.after != null)
      ? `<div class="ai-plan-grid">
          <div><span>Было</span><strong>${escapeHtml(formatMetricValue(kind, o.before))}</strong></div>
          <div><span>Стало</span><strong>${escapeHtml(formatMetricValue(kind, o.after))}</strong></div>
        </div>`
      : '';
    return `
      <article class="ai-card ai-${severity}">
        <header class="ai-card-head">
          <span class="ai-badge ai-badge-${severity}">${escapeHtml(OUTCOME_LABEL[o.status] || '—')}</span>
          ${o.fromPeriodKey ? `<span class="ai-type">${escapeHtml(o.fromPeriodKey)}</span>` : ''}
          <h3 class="ai-card-title">${escapeHtml(o.text || '')}</h3>
        </header>
        ${beforeAfter}
        ${o.note ? `<p class="ai-observation">${escapeHtml(o.note)}</p>` : ''}
      </article>`;
  }).join('');

  const section = (title, html) => (html ? `<div class="ai-section-title">${title}</div>${html}` : '');
  els.aiInsights.innerHTML = `
    ${planStatus}
    ${section('Анализ', cards ? `<div class="ai-cards">${cards}</div>` : '')}
    ${section('Рекомендации', recs ? `<div class="ai-cards">${recs}</div>` : '')}
    ${section('Прогноз', forecast)}
    ${section('Выполнение прошлых рекомендаций', outcomes ? `<div class="ai-cards">${outcomes}</div>` : '')}`;

  const tokens = data.usage?.total_tokens ? ` · ${formatNumber(data.usage.total_tokens)} токенов` : '';
  const cached = data.cached ? ' · из кэша' : '';
  const modeLabel = data.mode ? ` (${data.mode === 'static' ? 'статика' : 'динамика'})` : '';
  els.aiMeta.textContent = `Модель: ${data.model || ''} · ${periodLabel}${modeLabel} · ${formatDateTime(data.generatedAt)}${tokens}${cached}`;
  els.aiMeta.hidden = false;
}

function toggleAiMenu(open) {
  const show = open ?? els.aiMenu.hidden;
  els.aiMenu.hidden = !show;
  els.aiGenerateButton.setAttribute('aria-expanded', String(show));
}

async function savePlans() {
  const managerPlans = {};
  for (const input of [...document.querySelectorAll('.plan-input')]) {
    const value = Number(String(input.value || '0').replace(/\s/g, '').replace(',', '.'));
    managerPlans[input.dataset.managerId] = Number.isFinite(value) ? value : 0;
  }
  const month = els.planMonthSelect.value || monthKey();
  els.savePlansButton.disabled = true;
  setStatus('Сохранение плана');
  try {
    const { res, body } = await fetchJson(`/api/sales-plans?month=${encodeURIComponent(month)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ managerPlans })
    });
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось сохранить план');
    await loadDashboard();
    if (!els.plansModal.hidden) await loadPlanRowsForModal();
    setStatus('План сохранен', 'ok');
  } catch (error) {
    setStatus('Ошибка сохранения', 'error');
    els.messages.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка сохранения')}</div>`;
  } finally {
    els.savePlansButton.disabled = false;
  }
}

async function putDashboardSettings(patch) {
  try {
    const { res, body } = await fetchJson('/api/dashboard-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось сохранить настройки');
    await loadDashboard();
  } catch (error) {
    const c = classifyClientError(error, 'Конфигурация');
    logClientProblem(c.category, c.code, c.message);
    els.messages.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка сохранения настроек')}</div>`;
  }
}

function saveStageSettings() {
  return putDashboardSettings({ stageCharts: els.stageChartSelects.map((select) => select.value).filter(Boolean) });
}

function saveMetricStageSettings() {
  return putDashboardSettings({
    conversionStages: [els.conversionFromSelect.value, els.conversionToSelect.value].filter(Boolean),
    cycleStartStage: els.cycleStartSelect.value || ''
  });
}

function openPlansModal() {
  els.plansModal.hidden = false;
  loadPlanRowsForModal();
}

function closePlansModal() {
  els.plansModal.hidden = true;
}

function openContractsModal() {
  els.contractsModal.hidden = false;
  loadContracts();
}

function closeContractsModal() {
  els.contractsModal.hidden = true;
}

async function loadContracts() {
  els.contractsModalEyebrow.textContent = 'Выручка по факту'; // DOM общий с универсальной модалкой — вернуть подводку
  els.contractsModalTitle.textContent = `Договоры периода · ${periodTypeLabel(state.periodType)}`;
  els.contractsList.innerHTML = '<div class="empty">Загрузка…</div>';
  const seq = ++state.contractsSeq;    // M-1: этот запрос — текущий
  const params = new URLSearchParams({
    periodType: state.periodType,
    periodValue: activePeriodValue(),
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode
  });
  try {
    const { res, body } = await fetchJson(`/api/period-contracts?${params}`);
    if (seq !== state.contractsSeq) return;   // устаревший ответ — игнор
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось загрузить договоры');
    renderContracts(body.data);
  } catch (error) {
    if (seq !== state.contractsSeq) return;
    const c = classifyClientError(error, 'API');
    logClientProblem(c.category, c.code, c.message);
    els.contractsList.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка загрузки договоров')}</div>`;
  }
}

// В5: универсальная модалка «Сделки среза» — переиспользует DOM модалки договоров (eyebrow/title/list).
// Вторая колонка и подписи зависят от типа среза.
const SLICE_VIEWS = {
  funnelStage: { eyebrow: 'Воронка', second: 'manager', secondLabel: 'Менеджер', dateLabel: 'Дата этапа' },
  manager: { eyebrow: 'Карточка сотрудника', second: 'source', secondLabel: 'Источник', dateLabel: 'Дата договора' },
  source: { eyebrow: 'Источники оплат', second: 'manager', secondLabel: 'Менеджер', dateLabel: 'Дата договора' },
  failureReason: { eyebrow: 'Причины отказов', second: 'manager', secondLabel: 'Менеджер', dateLabel: 'Дата отказа' },
  stagePass: { eyebrow: 'Этап продаж', second: 'manager', secondLabel: 'Менеджер', dateLabel: 'Дата этапа' },
  inWork: { eyebrow: 'В работе', second: 'stage', secondLabel: 'Этап', dateLabel: 'Обновлено' }
};

function openSliceModal(slice, sliceValue, title) {
  const view = SLICE_VIEWS[slice];
  if (!view) return;
  els.contractsModal.hidden = false;
  els.contractsModalEyebrow.textContent = view.eyebrow;
  els.contractsModalTitle.textContent = title;
  loadSliceDeals(slice, sliceValue, view);
}

async function loadSliceDeals(slice, sliceValue, view) {
  els.contractsList.innerHTML = '<div class="empty">Загрузка…</div>';
  const seq = ++state.contractsSeq; // общий № запроса содержимого модалки (контейнер один)
  const params = new URLSearchParams({
    slice, sliceValue,
    periodType: state.periodType,
    periodValue: activePeriodValue(),
    managerId: els.managerSelect.value,
    sourceId: els.sourceSelect.value,
    ...extraFilterValues(),
    mode: state.mode
  });
  try {
    const { res, body } = await fetchJson(`/api/slice-deals?${params}`);
    if (seq !== state.contractsSeq) return;
    if (!res.ok || body.success === false) throw new Error(body.error?.message || 'Не удалось загрузить сделки среза');
    renderSliceDeals(body.data, view);
  } catch (error) {
    if (seq !== state.contractsSeq) return;
    const c = classifyClientError(error, 'API');
    logClientProblem(c.category, c.code, c.message);
    els.contractsList.innerHTML = `<div class="message error">${escapeHtml(error.message || 'Ошибка загрузки сделок')}</div>`;
  }
}

function renderSliceDeals(data, view) {
  const rows = data?.rows || [];
  if (!rows.length) {
    els.contractsList.innerHTML = '<div class="empty">Нет сделок в этом срезе за выбранный период</div>';
    return;
  }
  const head = `<div class="contracts-row contracts-row--slice contracts-head"><span>Компания</span><span>${escapeHtml(view.secondLabel)}</span><span>Сумма</span><span>${escapeHtml(view.dateLabel)}</span><span></span></div>`;
  const body = rows.map((row) => `
    <div class="contracts-row contracts-row--slice">
      <span class="contracts-company" title="${escapeHtml(row.company)}">${escapeHtml(row.company)}</span>
      <span class="contracts-type" title="${escapeHtml(row[view.second] || '')}">${escapeHtml(row[view.second] || '—')}</span>
      <span class="contracts-amount" title="${money(row.amount)}">${compactMoney(row.amount)}</span>
      <span class="contracts-date">${row.eventDate ? new Date(row.eventDate).toLocaleDateString('ru-RU') : '—'}</span>
      <a class="contracts-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener">Битрикс ↗</a>
    </div>`).join('');
  const truncated = data.truncated ? `<div class="empty">Показаны первые ${formatNumber(rows.length)} из ${formatNumber(data.count)}</div>` : '';
  const total = `<div class="contracts-total"><span>Итого: ${formatNumber(data.count)} сделок</span><strong title="${money(data.total || 0)}">${compactMoney(data.total || 0)}</strong></div>`;
  els.contractsList.innerHTML = head + body + truncated + total;
}

function renderContracts(data) {
  const rows = data?.rows || [];
  if (!rows.length) {
    els.contractsList.innerHTML = '<div class="empty">Нет договоров за выбранный период</div>';
    return;
  }
  const head = '<div class="contracts-row contracts-head"><span>Компания</span><span>Тип клиента</span><span>Сумма</span><span></span></div>';
  const body = rows.map((row) => `
    <div class="contracts-row">
      <span class="contracts-company" title="${escapeHtml(row.company)}">${escapeHtml(row.company)}</span>
      <span class="contracts-type" title="${escapeHtml(row.clientType || '')}">${escapeHtml(row.clientType || '—')}</span>
      <span class="contracts-amount" title="${money(row.amount)}">${compactMoney(row.amount)}</span>
      <a class="contracts-link" href="${escapeHtml(row.url)}" target="_blank" rel="noopener">Битрикс ↗</a>
    </div>`).join('');
  const total = `<div class="contracts-total"><span>Итого: ${formatNumber(data.count || rows.length)} договоров</span><strong title="${money(data.total || 0)}">${compactMoney(data.total || 0)}</strong></div>`;
  els.contractsList.innerHTML = head + body + total;
}

setupPeriodControls();
setMode('dynamic');

// В11: режим долей источников оплат — персональное визуальное предпочтение в localStorage (не в настройках
// дашборда: те общие и триггерят перезагрузку). Блок держим единым куском (TDZ: вызов после объявления const).
const SHARE_MODE_KEY = 'sourceShareMode:v1';
function loadShareMode() {
  try { return localStorage.getItem(SHARE_MODE_KEY) === 'revenue' ? 'revenue' : 'count'; } catch { return 'count'; }
}
function setShareMode(mode) {
  state.shareMode = mode === 'revenue' ? 'revenue' : 'count';
  for (const button of els.shareModeButtons) button.classList.toggle('active', button.dataset.shareMode === state.shareMode);
  try { localStorage.setItem(SHARE_MODE_KEY, state.shareMode); } catch { /* приватный режим — пропускаем */ }
}
for (const button of els.shareModeButtons) {
  button.addEventListener('click', () => {
    if (state.shareMode === button.dataset.shareMode) return;
    setShareMode(button.dataset.shareMode);
    if (state.data) drawSourcesPanel(state.data); // перерисовка без запроса к серверу
  });
}
setShareMode(loadShareMode()); // подсветить кнопки сохранённым режимом до первого рендера

// Тумблер «Средний чек»: медиана / среднее арифметическое. Обе метрики (крупная цифра, подпись,
// дельта, тренд) уже приходят в ответе дашборда — переключение перерисовывает без запроса к серверу.
function renderAverageCheck(avg) {
  if (!avg) return;
  const mean = state.avgMode === 'mean';
  const big = mean ? (avg.value || 0) : (avg.median || 0);
  const other = mean ? (avg.median || 0) : (avg.value || 0);
  els.averageCheckMetric.textContent = compactMoney(big);
  els.averageCheckMetric.title = `${mean ? 'Среднее арифметическое' : 'Медиана'}: ${money(big)}`;
  els.averageCheckHint.textContent = `${mean ? 'медиана' : 'среднее'}: ${compactMoney(other)} · ${formatNumber(avg.count || 0)} договоров`;
  renderDeltaBadge(els.averageCheckDelta, mean ? avg.meanDelta : avg.delta);
  renderTrendChart(els.averageCheckTrend, (mean ? avg.meanTrend : avg.trend) || [], { money: true, title: mean ? 'Средний чек' : 'Медианный чек' });
}
const AVG_MODE_KEY = 'avgCheckMode:v1';
function loadAvgMode() {
  try { return localStorage.getItem(AVG_MODE_KEY) === 'mean' ? 'mean' : 'median'; } catch { return 'median'; }
}
function setAvgMode(mode) {
  state.avgMode = mode === 'mean' ? 'mean' : 'median';
  for (const button of els.avgModeButtons) button.classList.toggle('active', button.dataset.avgMode === state.avgMode);
  try { localStorage.setItem(AVG_MODE_KEY, state.avgMode); } catch { /* приватный режим — пропускаем */ }
}
for (const button of els.avgModeButtons) {
  button.addEventListener('click', (event) => {
    event.stopPropagation();               // карточка кликабельна (открывает модалку) — гасим всплытие
    if (state.avgMode === button.dataset.avgMode) return;
    setAvgMode(button.dataset.avgMode);
    if (state.data) renderAverageCheck(state.data.kpis?.averageCheck); // перерисовка без запроса к серверу
  });
}
setAvgMode(loadAvgMode()); // подсветить кнопки сохранённым режимом до первого рендера

els.sidebarToggle.addEventListener('click', () => {
  els.shell.classList.toggle('sidebar-collapsed');
});
function granularityForPeriodType(periodType) {
  if (periodType === 'year') return 'month';
  if (periodType === 'quarter') return 'week';
  if (periodType === 'month') return 'week';
  if (periodType === 'week') return 'day';
  if (periodType === 'day') return 'day';
  return 'week';
}

for (const tab of els.periodTabs) {
  tab.addEventListener('click', () => {
    state.periodType = tab.dataset.periodType;
    state.granularity = granularityForPeriodType(state.periodType);
    els.granularitySelect.value = state.granularity;
    updatePeriodVisibility();
    loadDashboard();
  });
}
for (const control of [els.quarterSelect, els.dayInput, els.weekInput, els.monthInput, els.yearSelect, els.granularitySelect, els.managerSelect, els.sourceSelect,
  els.objectTypeSelect, els.clientTypeSelect, els.needSelect, els.projectRoleSelect, els.citySelect, els.turnoverSelect]) {
  control.addEventListener('change', loadDashboard);
}
for (const button of els.modeButtons) {
  button.addEventListener('click', () => {
    setMode(button.dataset.mode);
    loadDashboard();
  });
}
for (const select of els.stageChartSelects) {
  select.addEventListener('change', saveStageSettings);
}
for (const select of [els.conversionFromSelect, els.conversionToSelect, els.cycleStartSelect]) {
  select.addEventListener('change', saveMetricStageSettings);
}
els.openPlansButton.addEventListener('click', openPlansModal);
els.closePlansButton.addEventListener('click', closePlansModal);
els.planMonthSelect.addEventListener('change', loadPlanRowsForModal);
els.plansModal.addEventListener('click', (event) => {
  if (event.target === els.plansModal) closePlansModal();
});
els.contractMetric.addEventListener('click', openContractsModal);
els.contractMetric.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openContractsModal();
  }
});
els.closeContractsButton.addEventListener('click', closeContractsModal);
els.contractsModal.addEventListener('click', (event) => {
  if (event.target === els.contractsModal) closeContractsModal();
});

// В5: делегаты drill-down (innerHTML виджетов перезаписывается — слушатели на контейнерах, не на рядах).
els.funnelChart.addEventListener('click', (event) => {
  const row = event.target.closest('[data-stage-id]');
  if (!row) return;
  openSliceModal('funnelStage', row.dataset.stageId, `Ступень «${row.dataset.stageName}» · ${periodTypeLabel(state.periodType)}`);
});
els.funnelChart.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('[data-stage-id]');
  if (!row) return;
  event.preventDefault();
  openSliceModal('funnelStage', row.dataset.stageId, `Ступень «${row.dataset.stageName}» · ${periodTypeLabel(state.periodType)}`);
});
// Донаты «Источники оплат» и «Причины отказов»: клик по легенде/сегменту → сделки среза.
const donutSliceClick = (container, slice, eyebrowTitle) => {
  if (!container) return;
  container.addEventListener('click', (event) => {
    const leg = event.target.closest('[data-slice-id]');
    if (!leg) return;
    openSliceModal(slice, leg.dataset.sliceId, `${eyebrowTitle}: «${leg.dataset.sliceName}» · ${periodTypeLabel(state.periodType)}`);
  });
};
donutSliceClick(els.sourceRankChart, 'source', 'Источник');
donutSliceClick(els.failureReasonChart, 'failureReason', 'Причина отказа');

// Карточка «Средний чек» → договоры периода (тот же набор, что формирует чек).
if (els.averageCheckCard) {
  const openAvgContracts = () => openContractsModal();
  els.averageCheckCard.addEventListener('click', openAvgContracts);
  els.averageCheckCard.addEventListener('keydown', (event) => {
    if (event.target !== els.averageCheckCard) return;   // клавиши на тумблере не открывают модалку
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openAvgContracts(); }
  });
}
// Графики этапов «Получены исходники»/«Назначена встреча» → сделки, прошедшие этап в периоде (stagePass).
els.customTrends.forEach((chart, index) => {
  if (!chart) return;
  chart.style.cursor = 'pointer';
  chart.title = 'Показать сделки этапа';
  chart.addEventListener('click', () => {
    const stageId = els.stageChartSelects[index]?.value;
    const name = els.customChartTitles[index]?.textContent || 'этап';
    if (stageId) openSliceModal('stagePass', stageId, `Прошли этап «${name}» · ${periodTypeLabel(state.periodType)}`);
  });
});

els.refreshButton.addEventListener('click', loadDashboard);
els.aiGenerateButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleAiMenu();
});
for (const item of els.aiMenuItems) {
  item.addEventListener('click', () => {
    toggleAiMenu(false);
    const mode = item.dataset.report;
    if (mode === 'insights') generateInsights();
    else generateReport(mode);
  });
}
els.addEmployeeCardButton.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleEmployeePicker();
});
els.employeePickerSearch.addEventListener('input', renderEmployeePickerList);
els.employeePickerList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pick]');
  if (!button) return;
  addEmployeeCard(button.dataset.pick);
  toggleEmployeePicker(false);
});
// В5/В8: делегат карточек — удаление, клик «Факт» (договоры менеджера), клик «В работе» (открытые сделки).
function employeeCardActivate(event) {
  const remove = event.target.closest('[data-remove]');
  if (remove) { removeEmployeeCard(remove.dataset.remove); return; }
  const fact = event.target.closest('[data-fact-manager]');
  if (fact) { openSliceModal('manager', fact.dataset.factManager, `Договоры · ${fact.dataset.managerName} · ${periodTypeLabel(state.periodType)}`); return; }
  const inwork = event.target.closest('[data-inwork-manager]');
  if (inwork) { openSliceModal('inWork', inwork.dataset.inworkManager, `В работе · ${inwork.dataset.managerName}`); }
}
els.employeeCardsGrid.addEventListener('click', employeeCardActivate);
els.employeeCardsGrid.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.closest('[data-fact-manager],[data-inwork-manager]')) return;
  event.preventDefault();
  employeeCardActivate(event);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.employeePicker && !els.employeePicker.hidden) toggleEmployeePicker(false);
  if (event.key === 'Escape' && els.diagPanel && !els.diagPanel.hidden) closeDiag();
});
document.addEventListener('click', (event) => {
  if (!els.aiMenu.hidden && !els.aiMenu.contains(event.target) && event.target !== els.aiGenerateButton) toggleAiMenu(false);
  if (els.employeePicker && !els.employeePicker.hidden && !els.employeePicker.contains(event.target) && event.target !== els.addEmployeeCardButton) toggleEmployeePicker(false);
});
els.savePlansButton.addEventListener('click', savePlans);
els.diagOpenButton?.addEventListener('click', openDiag);
els.diagCloseButton?.addEventListener('click', closeDiag);
els.diagPanel?.addEventListener('click', (event) => {
  if (event.target === els.diagPanel) closeDiag();   // клик по фону закрывает
});
els.diagCategoryFilter?.addEventListener('change', renderDiagLog);
els.diagCopyButton?.addEventListener('click', copyDiagLog);
els.polzaBalanceRefresh?.addEventListener('click', refreshPolzaBalance);

if (els.aiChatForm) {
  els.aiChatForm.addEventListener('submit', (event) => {
    event.preventDefault();
    askAiChat(els.aiChatInput.value);
    els.aiChatInput.value = '';
  });
  els.aiChatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      els.aiChatForm.requestSubmit();
    }
  });
}
if (els.aiChatClear) els.aiChatClear.addEventListener('click', clearAiChat);
loadAiChat();
renderAiChat();

loadDashboard();
