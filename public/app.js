/**
 * Дашборд воронки продаж — клиентская часть.
 *
 * Ванильный модуль без сборки. Числа НЕ вычисляются здесь никогда: всё приходит
 * посчитанным с сервера (инвариант 9). Задача этого файла — собрать параметры
 * среза, показать результат и не перепутать ответы между собой.
 */

import { loginFromName } from './translit.js';

/** Кто вошёл. Заполняется до инициализации интерфейса (см. start()). */
let currentUser = null;

/* ─────────────────────────── Состояние ─────────────────────────── */

const state = {
  mode: 'static',
  periodType: 'quarter',
  periodValue: '',
  weekStart: '',
  from: '',
  to: '',
  allHistory: false,
  filters: { sourceIds: [], managerIds: [], kevFormats: [] },
  // Отдельные от filters — сужают уже открытую ступень детализации ещё раз,
  // не трогая фильтры всего дашборда сверху.
  detailFilters: { sourceIds: [], managerIds: [], kevFormats: [], currentStage: [] },
  conversionFrom: '',
  conversionTo: '',
  reference: null,
  data: null,
  loading: false,
  reloadQueued: false,
  // Монотонные номера запросов: ответ на устаревший срез применять нельзя.
  dashboardSeq: 0,
  detailsSeq: 0,
  details: null,
  lastFocused: null
};

const els = {
  periodTabs: [...document.querySelectorAll('[data-period-type]')],
  periodSelect: document.querySelector('#periodSelect'),
  weekRange: document.querySelector('#weekRange'),
  weekStart: document.querySelector('#weekStart'),
  weekEndLabel: document.querySelector('#weekEndLabel'),
  periodRange: document.querySelector('#periodRange'),
  periodFrom: document.querySelector('#periodFrom'),
  periodTo: document.querySelector('#periodTo'),
  allHistory: document.querySelector('#allHistory'),
  allHistoryLine: document.querySelector('#allHistoryLine'),
  allHistoryHint: document.querySelector('#allHistoryHint'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  modeHint: document.querySelector('#modeHint'),
  sourceFilter: document.querySelector('#sourceFilter'),
  managerFilter: document.querySelector('#managerFilter'),
  kevFilter: document.querySelector('#kevFilter'),
  resetFilters: document.querySelector('#resetFilters'),
  refreshButton: document.querySelector('#refreshButton'),
  exportButton: document.querySelector('#exportButton'),
  syncStatus: document.querySelector('#syncStatus'),
  freshness: document.querySelector('#freshness'),
  periodLabel: document.querySelector('#periodLabel'),
  primaryValue: document.querySelector('#primaryValue'),
  primaryRange: document.querySelector('#primaryRange'),
  primaryNote: document.querySelector('#primaryNote'),
  primarySecondary: document.querySelector('#primarySecondary'),
  conversionFrom: document.querySelector('#conversionFrom'),
  conversionTo: document.querySelector('#conversionTo'),
  selectedValue: document.querySelector('#selectedValue'),
  selectedNote: document.querySelector('#selectedNote'),
  selectedSecondary: document.querySelector('#selectedSecondary'),
  totalCompanies: document.querySelector('#totalCompanies'),
  totalNeeds: document.querySelector('#totalNeeds'),
  totalDeals: document.querySelector('#totalDeals'),
  funnel: document.querySelector('#funnel'),
  messages: document.querySelector('#messages'),
  detailsBackdrop: document.querySelector('#detailsBackdrop'),
  detailsModal: document.querySelector('#detailsModal'),
  detailsEyebrow: document.querySelector('#detailsEyebrow'),
  detailsTitle: document.querySelector('#detailsTitle'),
  detailsSummary: document.querySelector('#detailsSummary'),
  detailsBody: document.querySelector('#detailsBody'),
  detailsClose: document.querySelector('#detailsClose'),
  detailSourceFilter: document.querySelector('#detailSourceFilter'),
  detailManagerFilter: document.querySelector('#detailManagerFilter'),
  detailKevFilter: document.querySelector('#detailKevFilter'),
  detailStageFilter: document.querySelector('#detailStageFilter')
};

/* ─────────────────────────── Утилиты ─────────────────────────── */

/** Экранирование обязательно: в названиях компаний встречается что угодно. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value) {
  return Number(value ?? 0).toLocaleString('ru-RU');
}

/** Проценты: целое показывается без дробной части (спека, Конверсии §2). */
function percent(value) {
  if (value === null || value === undefined) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1).replace('.', ',')}%`;
}

function dateTime(iso) {
  if (!iso) return 'ещё не выполнялась';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function dateOnly(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('ru-RU');
}

/**
 * Разбор ответа. Сервер за прокси иногда отдаёт HTML-страницу шлюза вместо JSON —
 * голый res.json() падал бы на этом с непонятным «Unexpected token '<'».
 */
async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Сервер вернул не JSON — вероятно, приложение перезапускается. Повторите через минуту.');
  }
  if (!response.ok || body?.success === false) {
    throw new Error(body?.error?.message || `Запрос не выполнен (${response.status})`);
  }
  return body?.data ?? body;
}

/* ─────────────────────────── Периоды ─────────────────────────── */

function pad(value) {
  return String(value).padStart(2, '0');
}

function currentQuarterKey(date = new Date()) {
  return `${date.getFullYear()}-Q${Math.floor(date.getMonth() / 3) + 1}`;
}

/** Дата в виде YYYY-MM-DD, как ожидает <input type="date"> и API. */
function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Дата + N дней, тем же строковым видом — для конца недели по выбранному началу. */
function addDaysKey(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + days);
  return dateKey(date);
}

/**
 * YYYY-MM-DD → ДД.ММ.ГГГГ для показа пользователю (везде в приложении даты
 * в русском формате). Строкой, не через new Date(...).toLocaleDateString():
 * тот путь читает часовой пояс БРАУЗЕРА, и для пояса западнее UTC подпись
 * могла бы показать день раньше настоящего конца недели.
 */
function formatDateRu(value) {
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

function periodOptions(type) {
  const now = new Date();
  const options = [];
  if (type === 'quarter') {
    for (let back = 0; back < 8; back += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - back * 3, 1);
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      options.push({ value: `${date.getFullYear()}-Q${quarter}`, label: `${quarter} квартал ${date.getFullYear()}` });
    }
  } else if (type === 'month') {
    for (let back = 0; back < 14; back += 1) {
      const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const label = date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
      options.push({ value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`, label: label[0].toUpperCase() + label.slice(1) });
    }
  } else if (type === 'year') {
    for (let back = 0; back < 5; back += 1) {
      const year = now.getFullYear() - back;
      options.push({ value: String(year), label: String(year) });
    }
  }
  return options;
}

function defaultPeriodValue(type) {
  const now = new Date();
  if (type === 'month') return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  if (type === 'year') return String(now.getFullYear());
  return currentQuarterKey(now);
}

function renderPeriodControls() {
  const custom = state.periodType === 'custom';
  const week = state.periodType === 'week';
  const listPicked = !custom && !week;

  els.periodSelect.hidden = !listPicked;
  els.weekRange.hidden = !week;
  els.periodRange.hidden = !custom;

  if (listPicked) {
    const options = periodOptions(state.periodType);
    if (!options.some((option) => option.value === state.periodValue)) {
      state.periodValue = defaultPeriodValue(state.periodType);
    }
    periodSelectCtl.setItems(options.map((option) => ({ id: option.value, name: option.label })));
    periodSelectCtl.setValue(state.periodValue);
  } else if (week) {
    if (!state.weekStart) state.weekStart = dateKey(new Date());
    els.weekStart.value = state.weekStart;
    els.weekEndLabel.textContent = formatDateRu(addDaysKey(state.weekStart, 6));
  } else if (!state.from || !state.to) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    state.from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`;
    state.to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    els.periodFrom.value = state.from;
    els.periodTo.value = state.to;
  }

  for (const tab of els.periodTabs) {
    const active = tab.dataset.periodType === state.periodType;
    tab.classList.toggle('is-on', active);
    tab.setAttribute('aria-pressed', String(active));
  }

  // «Вся история» осмысленна только для Статики: в Динамике период обязателен.
  const allowAllHistory = state.mode === 'static';
  els.allHistory.disabled = !allowAllHistory;
  els.allHistoryLine.classList.toggle('is-disabled', !allowAllHistory);
  els.allHistoryHint.hidden = allowAllHistory;
  if (!allowAllHistory && state.allHistory) {
    // Молча отправить недопустимый запрос нельзя — сбрасываем видимо для пользователя.
    state.allHistory = false;
    els.allHistory.checked = false;
  }

  const periodDisabled = state.allHistory;
  periodSelectCtl.setDisabled(periodDisabled);
  els.weekStart.disabled = periodDisabled;
  els.periodFrom.disabled = periodDisabled;
  els.periodTo.disabled = periodDisabled;
  for (const tab of els.periodTabs) tab.disabled = periodDisabled;
}

/* ─────────────────────── Множественный выбор ─────────────────────── */

function createMultiSelect(container, { label, emptyLabel = 'Все', onChange }) {
  let items = [];
  let selected = new Set();
  let open = false;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'glass-multi__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', label);

  const value = document.createElement('span');
  value.className = 'glass-multi__value';
  const badge = document.createElement('span');
  badge.className = 'glass-multi__badge';
  badge.hidden = true;
  trigger.append(value, badge);

  const panel = document.createElement('div');
  panel.className = 'glass-multi__panel';
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-multiselectable', 'true');
  panel.hidden = true;

  container.append(trigger, panel);

  function renderTrigger() {
    if (selected.size === 0) {
      value.textContent = emptyLabel;
      badge.hidden = true;
      return;
    }
    const names = items.filter((item) => selected.has(item.id)).map((item) => item.name);
    value.textContent = names.length === 1 ? names[0] : `Выбрано: ${names.length}`;
    badge.hidden = names.length < 2;
    badge.textContent = String(names.length);
  }

  function renderPanel() {
    panel.innerHTML = '';
    for (const item of items) {
      const option = document.createElement('label');
      option.className = `glass-multi__option${item.id === '__none__' ? ' glass-multi__option--none' : ''}`;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(selected.has(item.id)));

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(item.id);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(item.id);
        else selected.delete(item.id);
        option.setAttribute('aria-selected', String(box.checked));
        renderTrigger();
        onChange([...selected]);
      });

      const text = document.createElement('span');
      text.textContent = item.name;
      option.append(box, text);
      panel.append(option);
    }

    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.style.padding = '10px';
      empty.textContent = 'Значений нет';
      panel.append(empty);
    } else {
      const actions = document.createElement('div');
      actions.className = 'glass-multi__actions';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'glass-multi__clear';
      clear.textContent = 'Сбросить';
      clear.addEventListener('click', () => {
        selected.clear();
        renderPanel();
        renderTrigger();
        onChange([]);
      });
      actions.append(clear);
      panel.append(actions);
    }
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }

  trigger.addEventListener('click', () => setOpen(!open));

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      setOpen(true);
      panel.querySelector('input')?.focus();
    }
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      trigger.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target)) setOpen(false);
  });

  renderTrigger();

  return {
    setItems(next) {
      items = next || [];
      // Значения, исчезнувшие из справочника, из выбора убираем: иначе фильтр
      // молча отсекал бы всё по несуществующему идентификатору.
      const prevSize = selected.size;
      selected = new Set([...selected].filter((id) => items.some((item) => item.id === id)));
      renderPanel();
      renderTrigger();
      // Виджет сам почистил выбор — вызывающий (state.filters) должен узнать об
      // этом тем же путём, что и явный клик пользователя, иначе на сервер уйдёт
      // ID, которого сам виджет уже не показывает выбранным.
      if (selected.size !== prevSize) onChange([...selected]);
    },
    clear() {
      selected.clear();
      renderPanel();
      renderTrigger();
    },
    value: () => [...selected]
  };
}

const filters = {};
// Фильтры ВНУТРИ модалки детализации — источник/менеджер/КЭВ те же справочники,
// что и у filters.* сверху, но отдельный набор виджетов и состояния: выбор
// в одном не должен трогать другой.
const detailFilters = {};
// Заполняются в init() — та же схема, что и у filters.*: конструктор
// компонента должен идти после того, как els.conversionFrom/То уже в DOM.
let conversionFromSelect = null;
let conversionToSelect = null;
let periodSelectCtl = null;
let staffRoleSelect = null;
let detailStageSelect = null;

/* ─────────────────────────── Запросы ─────────────────────────── */

function sliceParams() {
  const params = new URLSearchParams();
  params.set('mode', state.mode);
  if (state.allHistory && state.mode === 'static') {
    params.set('periodType', 'allHistory');
  } else if (state.periodType === 'custom') {
    params.set('periodType', 'custom');
    params.set('from', state.from);
    params.set('to', state.to);
  } else if (state.periodType === 'week') {
    // Неделя выбирается календарём (начало + 7 дней), а не списком ISO-недель —
    // на бэкенд это уходит тем же путём, что и «Свой» период: сервер уже умеет
    // произвольный диапазон дат, второй способ считать неделю заводить незачем.
    params.set('periodType', 'custom');
    params.set('from', state.weekStart);
    params.set('to', addDaysKey(state.weekStart, 6));
  } else {
    params.set('periodType', state.periodType);
    params.set('periodValue', state.periodValue);
  }
  for (const [key, values] of Object.entries(state.filters)) {
    if (values.length > 0) params.set(key, values.join(','));
  }
  if (state.conversionFrom && state.conversionTo) {
    params.set('conversionFrom', state.conversionFrom);
    params.set('conversionTo', state.conversionTo);
  }
  return params;
}

function setStatus(element, text, kind = '') {
  element.textContent = text;
  element.className = `status-pill${kind ? ` is-${kind}` : ''}`;
}

/**
 * Одиночный выпадающий список СВОЕЙ вёрстки — не нативный `<select>`.
 *
 * Нативный список рисует свой попап силами ОС: у него нет доступа к нашей теме
 * (шрифт, цвета, скругления), и на выборе с длинным списком этапов это выглядит
 * чужеродной белой панелью посреди тёмного/светлого интерфейса — ровно то, на
 * что жаловались. Устройство то же, что и у `createMultiSelect` (та же CSS,
 * `glass-multi__*`), только выбор один и панель закрывается сразу после клика.
 */
function createSingleSelect(container, { label, onChange }) {
  let items = [];
  let value = null;
  let open = false;

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'glass-multi__trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', label);

  const valueEl = document.createElement('span');
  valueEl.className = 'glass-multi__value';
  trigger.append(valueEl, createChevron());

  const panel = document.createElement('div');
  panel.className = 'glass-multi__panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  container.append(trigger, panel);

  function renderTrigger() {
    const item = items.find((entry) => entry.id === value);
    valueEl.textContent = item ? item.name : 'Не выбрано';
  }

  function renderPanel() {
    panel.innerHTML = '';
    for (const item of items) {
      const option = document.createElement('div');
      option.className = 'glass-multi__option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.id === value));
      option.tabIndex = -1;
      option.textContent = item.name;
      option.addEventListener('click', () => {
        value = item.id;
        renderPanel();
        renderTrigger();
        setOpen(false);
        trigger.focus();
        onChange(value);
      });
      panel.append(option);
    }
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  }

  trigger.addEventListener('click', () => { if (!trigger.disabled) setOpen(!open); });

  trigger.addEventListener('keydown', (event) => {
    if (trigger.disabled) return;
    if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && !open) {
      event.preventDefault();
      setOpen(true);
      panel.querySelector('[aria-selected="true"]')?.focus();
    }
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      trigger.focus();
      return;
    }
    // Стрелками — по списку, без мыши: список этапов длинный (16 строк),
    // и без клавиатурной навигации внутри панели пришлось бы дотягиваться
    // мышью до каждого варианта.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const options = [...panel.querySelectorAll('[role="option"]')];
      const currentIndex = options.indexOf(document.activeElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = options[(currentIndex + delta + options.length) % options.length];
      next?.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target)) setOpen(false);
  });

  renderTrigger();

  return {
    setItems(next) {
      items = next || [];
      renderPanel();
      renderTrigger();
    },
    setValue(next) {
      value = next;
      renderPanel();
      renderTrigger();
    },
    setDisabled(next) {
      trigger.disabled = next;
      if (next) setOpen(false);
    },
    value: () => value
  };
}

/**
 * Сужает список конечных этапов до тех, что не раньше выбранного начального
 * (спека, Конверсии §5: «выбор конечного этапа раньше начального не допускается»).
 * Предотвращение вместо постфактум-ошибки: невалидную пару просто нельзя собрать.
 */
function updateConversionToOptions() {
  const stages = state.reference?.stages;
  if (!stages || stages.length === 0) return;
  const fromStage = stages.find((stage) => stage.role === state.conversionFrom);
  const minPosition = fromStage ? fromStage.position : 0;
  const allowed = stages.filter((stage) => stage.position >= minPosition);

  conversionToSelect.setItems(allowed.map((stage) => ({ id: stage.role, name: stage.name })));

  if (!allowed.some((stage) => stage.role === state.conversionTo)) {
    // Прежний конечный этап оказался раньше нового начального — сдвигаем
    // к ближайшему допустимому, а не оставляем рассинхронизацию с компонентом.
    state.conversionTo = allowed.at(-1).role;
  }
  conversionToSelect.setValue(state.conversionTo);
}

async function loadReference() {
  try {
    const reference = await fetchJson('/api/reference');
    state.reference = reference;

    filters.sourceIds.setItems(reference.sources);
    filters.managerIds.setItems(reference.managers);
    filters.kevFormats.setItems(reference.kevFormats);

    detailFilters.sourceIds.setItems(reference.sources);
    detailFilters.managerIds.setItems(reference.managers);
    detailFilters.kevFormats.setItems(reference.kevFormats);

    conversionFromSelect.setItems(reference.stages.map((stage) => ({ id: stage.role, name: stage.name })));

    // Дефолт — от входа в работу до коммерческого результата, но ТОЛЬКО при первом
    // заходе или если ранее выбранная роль исчезла из справочника. loadReference()
    // вызывается повторно при каждом «Обновить данные» — без этой проверки клик
    // по обновлению молча сбрасывал бы выбор пользователя на дефолтную пару.
    const knownRoles = new Set(reference.stages.map((stage) => stage.role));
    if (!state.conversionFrom || !knownRoles.has(state.conversionFrom)) {
      const first = reference.stages.find((stage) => stage.role === 'takenToWork') || reference.stages[0];
      state.conversionFrom = first.role;
    }
    if (!state.conversionTo || !knownRoles.has(state.conversionTo)) {
      const last = reference.stages.find((stage) => stage.commercialResult) || reference.stages.at(-1);
      state.conversionTo = last.role;
    }
    conversionFromSelect.setValue(state.conversionFrom);
    updateConversionToOptions();
  } catch (error) {
    showMessage(`Не удалось загрузить справочники: ${error.message}`, 'error');
  }
}

async function loadDashboard() {
  if (state.loading) {
    // Не параллелим запросы: помечаем, что нужен ещё один, и догоняем в конце.
    state.reloadQueued = true;
    return;
  }
  state.loading = true;
  state.reloadQueued = false;
  const seq = ++state.dashboardSeq;

  els.refreshButton.disabled = true;
  els.funnel.classList.add('is-busy');

  try {
    const data = await fetchJson(`/api/dashboard?${sliceParams()}`);
    if (seq !== state.dashboardSeq) return; // пришёл ответ на устаревший срез
    state.data = data;
    render(data);
  } catch (error) {
    if (seq !== state.dashboardSeq) return; // ошибку устаревшего запроса тоже глушим
    showMessage(error.message, 'error');
    els.funnel.innerHTML = '<p class="state state--error">Не удалось рассчитать воронку.</p>';
  } finally {
    if (seq === state.dashboardSeq) {
      state.loading = false;
      els.refreshButton.disabled = false;
      els.funnel.classList.remove('is-busy');
      if (state.reloadQueued) loadDashboard();
    }
  }
}

/* ─────────────────────────── Отрисовка ─────────────────────────── */

function showMessage(text, kind = 'warn') {
  const block = document.createElement('div');
  block.className = `state state--${kind}`;
  block.textContent = text;
  els.messages.append(block);
}

function renderMessages(warnings, notices) {
  els.messages.innerHTML = '';
  // Пояснения к прочтению цифр идут первыми: они объясняют то, что пользователь
  // видит прямо сейчас, а предупреждения о качестве данных — фон.
  for (const notice of notices || []) showMessage(notice.message, 'info');
  for (const warning of warnings || []) {
    showMessage(warning.message, warning.code === 'SNAPSHOT_EMPTY' ? 'error' : 'warn');
  }
}

/**
 * Каскад появления проигрывается только при ПЕРВОЙ отрисовке.
 *
 * Воронка пересоздаётся целиком на каждую смену фильтра, и полный каскад на
 * каждый клик читался не как «данные обновились», а как мигание нижней половины
 * экрана: верхние карточки меняют числа мгновенно, а воронка ещё три четверти
 * секунды въезжает — на одно действие интерфейс отвечал двумя разными способами.
 * При обновлении данных полосы просто меняют длину переходом (transition width),
 * что и есть спокойная обратная связь.
 */
let funnelFirstRender = true;

function renderFunnel(stages) {
  if (!stages || stages.length === 0) {
    els.funnel.innerHTML = '<p class="state state--empty">Воронка не рассчитана.</p>';
    return;
  }

  // Полосы двух воронок несравнимы по длине: до стыка считаются компании,
  // после — сделки (инвариант «единица учёта меняется на стыке»). Общий
  // максимум по всем ступеням смешивал обе единицы: доля сделок могла
  // оказаться визуально ШИРЕ доли компаний просто потому, что сделок больше
  // штук — воронка на стыке расширялась обратно вместо того, чтобы сужаться.
  const junctionStage = stages.find((stage) => stage.junction);
  const companyMax = Math.max(1,
    ...stages.filter((stage) => !stage.junction && stage.unit === 'company').map((stage) => stage.count),
    // Счётчик компаний стыка идёт из владения сделками, а не из истории самой
    // компании (см. предупреждение DEAL_AHEAD_OF_COMPANY_STAGE) — он МОЖЕТ
    // превысить верхнюю ступень воронки компаний, и максимум обязан это учесть.
    junctionStage ? junctionStage.companyCount : 0);
  const dealMax = Math.max(1,
    junctionStage ? junctionStage.count : 0,
    ...stages.filter((stage) => !stage.junction && stage.unit === 'deal').map((stage) => stage.count));
  // Доля, которую стык занимает от воронки компаний, — с неё непрерывно
  // продолжается сужение воронки сделок, а не начинается заново от 100%.
  const junctionRatio = junctionStage ? (junctionStage.companyCount / companyMax) : 1;

  let html = `<div class="glass-funnel${funnelFirstRender ? ' glass-funnel--intro' : ''}">`;
  let groupOpened = false;
  // Порядковый номер строки для каскадного появления: CSS сам считает из него
  // задержку (--row-index в glass-ui.css). Считаем отдельно от позиции ступени,
  // потому что подписи групп «Компании»/«Сделки» — тоже строки каскада.
  let rowIndex = 0;

  for (const [position, stage] of stages.entries()) {
    if (!groupOpened) {
      html += `<p class="glass-funnel__group" style="--row-index:${rowIndex++}">Компании</p>`;
      groupOpened = true;
    }

    const ratio = stage.junction
      ? stage.companyCount / companyMax
      : stage.unit === 'company'
        ? stage.count / companyMax
        // Сделки масштабируются в СВОЁМ максимуме, а результат сжимается до
        // ширины, которую стык оставил от воронки компаний — иначе ступень
        // сразу после стыка начинала бы рисоваться заново от 100%.
        : (stage.count / dealMax) * junctionRatio;
    // Минимальный порог ширины — только для НЕнулевых ступеней: иначе ступень
    // с одной сущностью и ступень с нулём рисуются одинаковым огрызком, и
    // полоса перестаёт нести смысл в нижней части воронки. Настоящий ноль
    // не рисуется вовсе — пустой жёлоб честнее «немножко есть».
    const width = stage.count === 0 ? 0 : Math.max(1.5, ratio * 100);
    const classes = ['glass-funnel__row', 'glass-funnel__row--clickable'];
    if (stage.junction) classes.push('glass-funnel__row--junction');
    else if (stage.unit === 'deal') classes.push('glass-funnel__row--deals');

    // Конверсия показывается только когда её есть от чего считать. У первой
    // ступени предыдущей нет (сервер не считает вовсе) — условные «100%»
    // уместны, лишь когда на ней кто-то есть. У остальных ступеней «0%» при
    // пустой предыдущей — не ноль, а отсутствие базы: на пустом срезе вся
    // воронка писала «0%», и только первая ступень «—», разнобой в одной таблице.
    const hasBase = position === 0 ? stage.count > 0 : stages[position - 1].count > 0;
    const conv = !hasBase
      ? '—'
      : (stage.conversionFromPrevious === null || stage.conversionFromPrevious === undefined
        ? '100%'
        : percent(stage.conversionFromPrevious));

    const row = rowIndex++;
    html += `<div class="${classes.join(' ')}" role="button" tabindex="0"
      style="--row-index:${row}"
      data-stage-role="${esc(stage.role)}" data-stage-name="${esc(stage.name)}"
      title="Показать состав ступени «${esc(stage.name)}»">
      <div class="glass-funnel__name">${esc(stage.position + 1)}. ${esc(stage.name)}</div>
      <div class="glass-funnel__track"><div class="glass-funnel__fill" style="width:${width.toFixed(1)}%; --row-index:${row}"></div></div>
      <div class="glass-funnel__count num">${num(stage.count)}</div>
      <div class="glass-funnel__conv num">${conv}</div>`;

    if (stage.junction) {
      html += `<div class="glass-funnel__subcount">из ${num(stage.companyCount)} компаний</div>`;
    }
    html += '</div>';

    if (stage.junction) html += `<p class="glass-funnel__group" style="--row-index:${rowIndex++}">Сделки</p>`;
  }

  html += '</div>';
  els.funnel.innerHTML = html;
  funnelFirstRender = false;
}

/**
 * Причина, по которой конверсию не от чего считать.
 *
 * Знаменатель у конверсии через стык — ПОТРЕБНОСТИ, а не компании начальной
 * ступени. Раньше здесь стояла одна жёстко зашитая фраза «нет компаний, взятых
 * в работу», и при девяти компаниях, ни одна из которых не дошла до выявленной
 * потребности, интерфейс уверенно сообщал, что компаний нет — прямо противореча
 * ступени воронки рядом, где стояла девятка.
 */
function emptyConversionReason(conversion, data) {
  if (conversion.crossesJunction && conversion.fromCount > 0 && (data.totals?.needs ?? 0) === 0) {
    return `Компании есть (${num(conversion.fromCount)}), но ни у одной не выявлена потребность — конверсию считать не от чего.`;
  }
  return `Нет сущностей на ступени «${conversion.fromName}» в этом срезе — считать не от чего.`;
}

function renderConversions(data) {
  const primary = data.primaryConversion;
  els.primarySecondary.hidden = true;
  if (primary && !primary.error) {
    els.primaryValue.textContent = primary.available ? percent(primary.value) : '0%';
    els.primaryRange.textContent = `${primary.fromName} → ${primary.toName}`;
    els.primaryNote.textContent = primary.available
      ? `${num(primary.toCount)} сделок с авансом из ${num(primary.crossesJunction ? data.totals.needs : primary.fromCount)} ${primary.crossesJunction ? 'потребностей' : 'компаний, взятых в работу'}.`
      : emptyConversionReason(primary, data);

    // Главная конверсия структурно всегда пересекает стык (компания → сделка),
    // поэтому сервер всегда возвращает дополнительный показатель (спека, Конверсии §8) —
    // без этого блока пользователь никогда не увидел бы вторую половину главной метрики.
    if (primary.secondary) {
      els.primarySecondary.hidden = false;
      els.primarySecondary.innerHTML =
        `<b>${esc(percent(primary.secondary.value))}</b> — ${esc(primary.secondary.note.toLowerCase())} `
        + `(${num(primary.secondary.baseCount)})`;
    }
  }

  const selected = data.selectedConversion;
  els.selectedSecondary.hidden = true;
  if (!selected) {
    els.selectedValue.textContent = '—';
    els.selectedNote.textContent = 'Выберите два этапа.';
  } else if (selected.error) {
    els.selectedValue.textContent = '—';
    els.selectedNote.textContent = 'Конечный этап раньше начального — выберите корректный диапазон.';
  } else {
    els.selectedValue.textContent = selected.available ? percent(selected.value) : '0%';
    els.selectedNote.textContent = selected.available
      ? `${num(selected.toCount)} из ${num(selected.crossesJunction ? data.totals.needs : selected.fromCount)}`
      : emptyConversionReason(selected, data);

    if (selected.secondary) {
      els.selectedSecondary.hidden = false;
      els.selectedSecondary.innerHTML =
        `<b>${esc(percent(selected.secondary.value))}</b> — ${esc(selected.secondary.note.toLowerCase())} `
        + `(${num(selected.secondary.baseCount)})`;
    }
  }
}

function render(data) {
  const period = data.appliedRequest.period;
  els.periodLabel.textContent = period.label;

  const freshness = data.freshness;
  const stale = freshness.stale;
  setStatus(
    els.freshness,
    `Данные на ${dateTime(freshness.lastSuccessAt || freshness.snapshotAt)}`,
    stale ? 'stale' : 'ok'
  );

  renderConversions(data);
  els.totalCompanies.textContent = num(data.totals.companies);
  els.totalNeeds.textContent = num(data.totals.needs);
  els.totalDeals.textContent = num(data.totals.deals);

  renderFunnel(data.stages);

  const notices = [...(data.notices || [])];
  if (period.clamped) {
    notices.unshift({
      code: 'PERIOD_CLAMPED',
      message: `Период ещё не закончился — расчёт выполнен по ${dateOnly(period.to)}.`
    });
  }
  // Сервер специально различает «пусто из-за фильтров» и «пустой снимок» (filtersActive) —
  // без этого пояснения нулевая воронка выглядит как сбой синхронизации, хотя это
  // законный результат текущей комбинации фильтров. totals.companies/deals здесь не годятся:
  // это размер кандидатского пула ДО фильтра по менеджеру (тот применяется только внутри
  // ступеней), поэтому пул может быть ненулевым, а каждая ступень — всё равно нулевой.
  const trulyEmptySnapshot = (data.warnings || []).some((w) => w.code === 'SNAPSHOT_EMPTY');
  const allStagesEmpty = data.stages.every((stage) => stage.count === 0);
  if (data.filtersActive && allStagesEmpty && !trulyEmptySnapshot) {
    notices.push({
      code: 'EMPTY_DUE_TO_FILTERS',
      message: 'Нет сущностей, подходящих под текущие фильтры за выбранный период — попробуйте изменить фильтры или период.'
    });
  }
  renderMessages(data.warnings, notices);
}

/* ─────────────────────── Детализация ступени ─────────────────────── */

function renderDetails(details) {
  const isDeal = details.stage.unit === 'deal';
  // На стыке единица учёта в данных — сделка (см. CONTEXT.md, единица учёта меняется
  // на стыке), но домен называет её потребностью до этого момента: строка воронки
  // подписана «Потребности выявлены», и детализация обязана говорить тем же словом,
  // а не «сделка» — иначе на одном экране расходится терминология одной и той же сущности.
  const entityWord = details.stage.junction ? 'потребность' : 'сделка';
  const entityWordGenitivePlural = details.stage.junction ? 'потребностей' : 'сделок';
  const rows = details.rows;
  const filtersNarrowed = details.count !== details.totalCount;

  if (rows.length === 0) {
    els.detailsBody.innerHTML = filtersNarrowed
      ? '<p class="state state--empty">Ничего не подходит под фильтры внутри детализации — попробуйте изменить их.</p>'
      : '<p class="state state--empty">На этой ступени нет сущностей в выбранном срезе.</p>';
    return;
  }

  const head = isDeal
    ? ['ID', entityWord[0].toUpperCase() + entityWord.slice(1), 'Компания', 'Источник', 'Менеджер', 'Формат КЭВ', 'Текущий этап', 'Дата этапа', '']
    : ['ID', 'Компания', 'Источник', 'Менеджер', 'Текущий этап', 'Дата этапа', ''];

  const body = rows.map((row) => {
    const cells = [`<td class="num">${esc(row.id)}</td>`, `<td>${esc(row.title)}</td>`];
    if (isDeal) cells.push(`<td>${esc(row.companyTitle || '—')}</td>`);
    cells.push(`<td>${esc(row.sourceName)}</td>`);
    cells.push(`<td>${esc(row.managerName)}</td>`);
    if (isDeal) cells.push(`<td>${esc(row.kevFormatName)}</td>`);
    cells.push(`<td>${esc(row.currentStageName)}${row.isLost ? ' <span class="tag tag--lost">отказ</span>' : ''}</td>`);
    cells.push(`<td class="num">${esc(dateOnly(row.stageAt))}</td>`);
    cells.push(row.url
      ? `<td><a class="registry__link" href="${esc(row.url)}" target="_blank" rel="noopener">Битрикс ↗</a></td>`
      : '<td></td>');
    return `<tr>${cells.join('')}</tr>`;
  }).join('');

  const pager = details.pageCount > 1
    ? `<div class="details-pager">
         <button class="glass-btn glass-btn--ghost" type="button" data-page="${details.page - 1}"
           ${details.page <= 1 ? 'disabled' : ''}>Назад</button>
         <span class="details-pager__label">${details.page} из ${details.pageCount}</span>
         <button class="glass-btn glass-btn--ghost" type="button" data-page="${details.page + 1}"
           ${details.page >= details.pageCount ? 'disabled' : ''}>Вперёд</button>
       </div>`
    : '';

  const countLabel = filtersNarrowed
    ? `<b class="num">${num(details.count)}</b> из <b class="num">${num(details.totalCount)}</b>`
    : `<b class="num">${num(details.count)}</b>`;

  els.detailsBody.innerHTML = `
    <div class="details-meta">
      <span>Всего: ${countLabel} ${isDeal ? entityWordGenitivePlural : 'компаний'}</span>
      ${pager}
    </div>
    <div class="registry-scroll">
      <table class="registry">
        <thead><tr>${head.map((title) => `<th>${esc(title)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

async function loadDetails(stageRole, page = 1) {
  const seq = ++state.detailsSeq;
  els.detailsBody.innerHTML = '<p class="state state--loading">Загружаю состав ступени…</p>';
  try {
    const params = sliceParams();
    params.set('stageRole', stageRole);
    params.set('page', String(page));
    if (state.detailFilters.sourceIds.length > 0) params.set('detailSourceIds', state.detailFilters.sourceIds.join(','));
    if (state.detailFilters.managerIds.length > 0) params.set('detailManagerIds', state.detailFilters.managerIds.join(','));
    if (state.detailFilters.kevFormats.length > 0) params.set('detailKevFormats', state.detailFilters.kevFormats.join(','));
    if (state.detailFilters.currentStage.length > 0) params.set('detailCurrentStage', state.detailFilters.currentStage.join(','));
    const details = await fetchJson(`/api/details?${params}`);
    if (seq !== state.detailsSeq) return; // открыли другую ступень, пока грузилась эта
    state.details = { stageRole, page };
    els.detailsSummary.textContent =
      `${details.appliedRequest.period.label} · ${details.appliedRequest.mode === 'static' ? 'Статика' : 'Динамика'}`;
    // Варианты «Текущего этапа» — свои на каждую ступень, обновляются вместе
    // с данными. setItems сам вычистит выбор, если ранее отмеченное значение
    // пропало из списка (та же защита, что и у фильтров дашборда сверху).
    detailStageSelect.setItems(details.stageOptions.map((name) => ({ id: name, name })));
    renderDetails(details);
  } catch (error) {
    if (seq !== state.detailsSeq) return;
    els.detailsBody.innerHTML = `<p class="state state--error">${esc(error.message)}</p>`;
  }
}

/** Фокусируемые элементы модалки — для удержания фокуса внутри. */
function focusable() {
  return [...els.detailsModal.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )];
}

function openDetails(stageRole, stageName) {
  state.lastFocused = document.activeElement;
  els.detailsTitle.textContent = stageName;
  els.detailsBackdrop.hidden = false;
  // Новая ступень — свежий контекст: фильтр по менеджеру, выбранный для
  // прошлой открытой ступени, скорее всего не имеет отношения к этой.
  state.detailFilters = { sourceIds: [], managerIds: [], kevFormats: [], currentStage: [] };
  detailFilters.sourceIds.clear();
  detailFilters.managerIds.clear();
  detailFilters.kevFormats.clear();
  detailStageSelect.clear();
  // Фон под открытым окном не должен прокручиваться: колесо над затемнением
  // уводило дашборд вниз, окно оставалось на месте, и при закрытии пользователь
  // оказывался не там, откуда открывал.
  document.body.classList.add('is-modal-open');
  els.detailsClose.focus();
  loadDetails(stageRole, 1);
}

function closeDetails() {
  els.detailsBackdrop.hidden = true;
  document.body.classList.remove('is-modal-open');
  state.details = null;
  // Фокус возвращается на ступень, с которой окно открыли: иначе пользователь
  // клавиатуры оказывается в начале страницы.
  state.lastFocused?.focus?.();
}

/* ─────────────────────── Синхронизация ─────────────────────── */

async function loadSyncStatus() {
  try {
    const status = await fetchJson('/api/sync-status');
    if (status.running) {
      setStatus(els.syncStatus, 'Обновление данных…');
      els.refreshButton.disabled = true;
      return status;
    }
    els.refreshButton.disabled = state.loading;
    if (status.lastError) setStatus(els.syncStatus, 'Ошибка обновления', 'error');
    else if (status.stale) setStatus(els.syncStatus, 'Данные устарели', 'stale');
    else setStatus(els.syncStatus, `Обновлено ${dateTime(status.lastSuccessAt)}`, 'ok');
    return status;
  } catch {
    setStatus(els.syncStatus, 'Состояние неизвестно', 'error');
    return null;
  }
}

async function runSync() {
  setStatus(els.syncStatus, 'Обновление данных…');
  els.refreshButton.disabled = true;
  try {
    await fetchJson('/api/sync', { method: 'POST' });
    await loadReference();
    await loadDashboard();
  } catch (error) {
    showMessage(`Обновление не выполнено: ${error.message}`, 'error');
  } finally {
    await loadSyncStatus();
  }
}

/* ─────────────────────────── События ─────────────────────────── */

function applyModeHint() {
  els.modeHint.textContent = state.mode === 'static'
    ? 'Куда дошли компании, взятые в работу в этом периоде.'
    : 'Что отдел фактически сделал за период, включая старые сущности.';
}

function init() {
  filters.sourceIds = createMultiSelect(els.sourceFilter, {
    label: 'База или источник',
    emptyLabel: 'Все источники',
    onChange: (values) => { state.filters.sourceIds = values; loadDashboard(); }
  });
  filters.managerIds = createMultiSelect(els.managerFilter, {
    label: 'Менеджер',
    emptyLabel: 'Все менеджеры',
    onChange: (values) => { state.filters.managerIds = values; loadDashboard(); }
  });
  filters.kevFormats = createMultiSelect(els.kevFilter, {
    label: 'Формат КЭВ',
    emptyLabel: 'Все форматы КЭВ',
    onChange: (values) => { state.filters.kevFormats = values; loadDashboard(); }
  });

  conversionFromSelect = createSingleSelect(els.conversionFrom, {
    label: 'Начальный этап',
    onChange: (role) => { state.conversionFrom = role; updateConversionToOptions(); loadDashboard(); }
  });
  conversionToSelect = createSingleSelect(els.conversionTo, {
    label: 'Конечный этап',
    onChange: (role) => { state.conversionTo = role; loadDashboard(); }
  });

  periodSelectCtl = createSingleSelect(els.periodSelect, {
    label: 'Значение периода',
    onChange: (value) => { state.periodValue = value; loadDashboard(); }
  });

  const reloadDetails = () => {
    if (state.details) loadDetails(state.details.stageRole, 1);
  };
  detailFilters.sourceIds = createMultiSelect(els.detailSourceFilter, {
    label: 'Источник (в этой ступени)',
    emptyLabel: 'Все источники',
    onChange: (values) => { state.detailFilters.sourceIds = values; reloadDetails(); }
  });
  detailFilters.managerIds = createMultiSelect(els.detailManagerFilter, {
    label: 'Менеджер (в этой ступени)',
    emptyLabel: 'Все менеджеры',
    onChange: (values) => { state.detailFilters.managerIds = values; reloadDetails(); }
  });
  detailFilters.kevFormats = createMultiSelect(els.detailKevFilter, {
    label: 'Формат КЭВ (в этой ступени)',
    emptyLabel: 'Все форматы КЭВ',
    onChange: (values) => { state.detailFilters.kevFormats = values; reloadDetails(); }
  });
  detailStageSelect = createMultiSelect(els.detailStageFilter, {
    label: 'Текущий этап',
    emptyLabel: 'Любой текущий этап',
    onChange: (values) => { state.detailFilters.currentStage = values; reloadDetails(); }
  });

  state.periodValue = defaultPeriodValue(state.periodType);
  renderPeriodControls();
  applyModeHint();

  for (const tab of els.periodTabs) {
    tab.addEventListener('click', () => {
      state.periodType = tab.dataset.periodType;
      renderPeriodControls();
      loadDashboard();
    });
  }

  els.weekStart.addEventListener('change', () => {
    if (!els.weekStart.value) return;
    state.weekStart = els.weekStart.value;
    els.weekEndLabel.textContent = formatDateRu(addDaysKey(state.weekStart, 6));
    loadDashboard();
  });

  const onRangeChange = () => {
    state.from = els.periodFrom.value;
    state.to = els.periodTo.value;
    if (!state.from || !state.to) return;
    if (state.from > state.to) {
      showMessage('Конец диапазона раньше начала — расчёт выполнен по переставленным границам.', 'warn');
    }
    loadDashboard();
  };
  els.periodFrom.addEventListener('change', onRangeChange);
  els.periodTo.addEventListener('change', onRangeChange);

  els.allHistory.addEventListener('change', () => {
    state.allHistory = els.allHistory.checked;
    renderPeriodControls();
    loadDashboard();
  });

  for (const button of els.modeButtons) {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      for (const other of els.modeButtons) {
        const active = other === button;
        other.classList.toggle('is-on', active);
        other.setAttribute('aria-pressed', String(active));
      }
      applyModeHint();
      renderPeriodControls();
      loadDashboard();
    });
  }

  els.resetFilters.addEventListener('click', () => {
    for (const control of Object.values(filters)) control.clear();
    state.filters = { sourceIds: [], managerIds: [], kevFormats: [] };
    loadDashboard();
  });

  els.refreshButton.addEventListener('click', runSync);

  els.exportButton.addEventListener('click', () => {
    window.location.href = `/api/export.xlsx?${sliceParams()}`;
  });

  // Клики по ступеням — делегатом: строки воронки пересоздаются при каждом рендере.
  const activateStage = (event) => {
    const row = event.target.closest('[data-stage-role]');
    if (!row) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    if (event.type === 'keydown') event.preventDefault();
    openDetails(row.dataset.stageRole, row.dataset.stageName);
  };
  els.funnel.addEventListener('click', activateStage);
  els.funnel.addEventListener('keydown', activateStage);

  els.detailsClose.addEventListener('click', closeDetails);
  els.detailsBackdrop.addEventListener('click', (event) => {
    if (event.target === els.detailsBackdrop) closeDetails();
  });
  els.detailsBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-page]');
    if (button && state.details) loadDetails(state.details.stageRole, Number(button.dataset.page));
  });

  document.addEventListener('keydown', (event) => {
    if (els.detailsBackdrop.hidden) return;
    if (event.key === 'Escape') {
      closeDetails();
      return;
    }
    // Фокус-трап: Tab не должен уводить за пределы открытого окна.
    if (event.key === 'Tab') {
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  loadReference().then(loadDashboard);
  loadSyncStatus();
  setInterval(loadSyncStatus, 60000);
}

/* ─────────────────────────── Учётная запись ─────────────────────────── */

const ROLE_LABEL = { admin: 'Администратор', employee: 'Сотрудник' };

/** Загруженная аватарка или инициал имени — общий код для рельса и профиля. */
function renderAvatar(img, initial, avatarDataUrl, name) {
  if (avatarDataUrl) {
    img.src = avatarDataUrl;
    img.hidden = false;
    initial.hidden = true;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    initial.hidden = false;
    initial.textContent = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  }
}

function renderAccount(user) {
  const rail = document.querySelector('#railAccount');
  if (!rail) return;
  rail.hidden = false;
  const name = user.name || user.login;

  renderAvatar(
    document.querySelector('#railAvatarImg'), document.querySelector('#railAvatarInitial'),
    user.avatarDataUrl, name
  );
  renderAvatar(
    document.querySelector('#profileAvatarImg'), document.querySelector('#profileAvatarInitial'),
    user.avatarDataUrl, name
  );
  document.querySelector('#avatarRemove').hidden = !user.avatarDataUrl;

  document.querySelector('#profileName').textContent = name;
  document.querySelector('#profileLogin').textContent = user.login;
  document.querySelector('#profileRole').textContent = ROLE_LABEL[user.role] || user.role;

  // Вкладка «Сотрудники» существует только для администратора — и в интерфейсе,
  // и на сервере (маршруты отвечают 403), скрытие пункта тут лишь следствие.
  const staffTab = document.querySelector('[data-tab="staff"]');
  if (staffTab) staffTab.hidden = user.role !== 'admin';
}

/** Подсвечивает активный пункт узкой колонки навигации. */
function setActiveTab(tab) {
  for (const button of document.querySelectorAll('#railNav [data-tab]')) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

/**
 * Узкая колонка: «Аналитика» — сам дашборд, «Сотрудники» — отдельная
 * страница (openStaff/closeStaff). «Профиль» как отдельный пункт меню
 * пока убран — открывается только по клику на аватар внизу колонки
 * (обработчик #railAvatarButton ниже), сама модалка профиля никуда
 * не делась.
 */
function bindRailTabs() {
  document.querySelector('[data-tab="analytics"]')?.addEventListener('click', () => {
    closeStaff();
    closeProfile();
  });
  document.querySelector('[data-tab="staff"]')?.addEventListener('click', () => {
    closeProfile();
    setActiveTab('staff');
    openStaff();
  });
  document.querySelector('[data-tab="profile"]')?.addEventListener('click', () => {
    closeStaff();
    setActiveTab('profile');
    openProfile();
  });
  document.querySelector('#railAvatarButton')?.addEventListener('click', () => {
    closeStaff();
    setActiveTab('profile');
    openProfile();
  });
  document.querySelector('#logoutButton')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login.html');
  });
}

/* ─────────────────────────── Сотрудники ─────────────────────────── */

const staffEls = {
  page: document.querySelector('#staffPage'),
  form: document.querySelector('#staffForm'),
  name: document.querySelector('#staffName'),
  login: document.querySelector('#staffLogin'),
  role: document.querySelector('#staffRole'),
  submit: document.querySelector('#staffSubmit'),
  error: document.querySelector('#staffError'),
  issued: document.querySelector('#staffIssued'),
  rows: document.querySelector('#staffRows')
};

/** Логин, введённый вручную, больше не перебивается подсказкой из имени. */
let loginEditedByHand = false;

function staffError(message) {
  staffEls.error.textContent = message || '';
  staffEls.error.hidden = !message;
}

/**
 * Выданный пароль показывается ОДИН раз: на сервере хранится только хеш,
 * и повторно узнать пароль нельзя ни через API, ни из файла. Поэтому блок
 * заметный и с кнопкой копирования — иначе администратор закроет окно и
 * останется без пароля, который уже назначен сотруднику.
 */
function showIssued(user, password) {
  staffEls.issued.hidden = false;
  staffEls.issued.innerHTML = `
    <p class="staff-issued__title">Доступ для «${esc(user.name)}» создан</p>
    <dl class="staff-issued__pair">
      <dt>Логин</dt><dd><code>${esc(user.login)}</code></dd>
      <dt>Пароль</dt><dd><code>${esc(password)}</code></dd>
    </dl>
    <p class="staff-issued__note">Пароль показывается один раз — сохраните и передайте сотруднику.
    Позже его можно только сбросить на новый.</p>
    <button class="glass-btn glass-btn--ghost" type="button" data-copy="${esc(user.login)}\t${esc(password)}">Скопировать</button>`;
  staffEls.issued.querySelector('[data-copy]')?.addEventListener('click', (event) => {
    navigator.clipboard?.writeText(event.currentTarget.dataset.copy.replace('\t', '  '))
      .then(() => { event.currentTarget.textContent = 'Скопировано'; })
      .catch(() => { event.currentTarget.textContent = 'Скопировать не вышло — выделите вручную'; });
  });
}

function renderStaff(users) {
  if (users.length === 0) {
    staffEls.rows.innerHTML = '<tr><td colspan="6" class="state state--empty">Сотрудников пока нет.</td></tr>';
    return;
  }
  staffEls.rows.innerHTML = users.map((user) => {
    const isSelf = currentUser && user.id === currentUser.id;
    return `<tr${user.active ? '' : ' class="staff-row--off"'}>
      <td>${esc(user.name)}${isSelf ? ' <span class="tag">это вы</span>' : ''}</td>
      <td><code>${esc(user.login)}</code></td>
      <td>${esc(ROLE_LABEL[user.role] || user.role)}</td>
      <td>${user.active ? 'Активен' : '<span class="tag tag--lost">Отключён</span>'}</td>
      <td>${user.lastLoginAt ? esc(dateOnly(user.lastLoginAt)) : '—'}</td>
      <td class="staff-actions">
        <button class="glass-btn glass-btn--ghost" data-staff-toggle="${esc(user.id)}"
          data-active="${user.active ? '1' : '0'}">${user.active ? 'Отключить' : 'Включить'}</button>
        <button class="glass-btn glass-btn--ghost" data-staff-reset="${esc(user.id)}">Сбросить пароль</button>
        <button class="glass-btn glass-btn--ghost" data-staff-delete="${esc(user.id)}">Удалить</button>
      </td>
    </tr>`;
  }).join('');
}

async function loadStaff() {
  try {
    const data = await fetchJson('/api/auth/users');
    renderStaff(data.users);
  } catch (error) {
    staffError(error.message || 'Не удалось получить список сотрудников');
  }
}

/**
 * «Сотрудники» — не модалка поверх дашборда, а отдельная полноценная
 * страница: занимает место topbar+board, а не накрывает их затемнением.
 * Профиль модалкой и остался — только этот раздел стал страницей, по явной
 * просьбе (у него самостоятельная таблица и форма, не короткая карточка).
 */
async function openStaff() {
  staffError('');
  staffEls.issued.hidden = true;
  document.querySelector('.topbar').hidden = true;
  document.querySelector('.board').hidden = true;
  staffEls.page.hidden = false;
  await loadStaff();
}

function closeStaff() {
  staffEls.page.hidden = true;
  document.querySelector('.topbar').hidden = false;
  document.querySelector('.board').hidden = false;
  setActiveTab('analytics');
}

function bindStaff() {
  if (!staffEls.page) return;

  staffRoleSelect = createSingleSelect(staffEls.role, {
    label: 'Роль',
    onChange: () => {}
  });
  staffRoleSelect.setItems([
    { id: 'employee', name: 'Сотрудник' },
    { id: 'admin', name: 'Администратор' }
  ]);
  staffRoleSelect.setValue('employee');

  // Логин подставляется из имени прямо во время набора — теми же правилами,
  // что применит сервер (public/translit.js один на обе стороны).
  staffEls.name.addEventListener('input', () => {
    if (loginEditedByHand) return;
    staffEls.login.value = loginFromName(staffEls.name.value);
  });
  staffEls.login.addEventListener('input', () => {
    // Опустевшее поле снова отдаётся под автоподстановку: пользователь стёр
    // логин, значит хочет получить подсказку обратно, а не пустое поле.
    loginEditedByHand = staffEls.login.value.trim().length > 0;
  });

  staffEls.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    staffError('');
    staffEls.submit.disabled = true;
    try {
      const data = await fetchJson('/api/auth/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: staffEls.name.value.trim(),
          login: staffEls.login.value.trim(),
          role: staffRoleSelect.value()
        })
      });
      showIssued(data.user, data.password);
      staffEls.form.reset();
      staffRoleSelect.setValue('employee'); // form.reset() не трогает свою вёрстку списка
      loginEditedByHand = false;
      await loadStaff();
    } catch (error) {
      staffError(error.message || 'Не удалось добавить сотрудника');
    } finally {
      staffEls.submit.disabled = false;
    }
  });

  // Действия по строкам — одним обработчиком на таблицу: строки
  // перерисовываются целиком, и вешать слушатели на каждую кнопку означало бы
  // терять их при каждой перерисовке.
  staffEls.rows.addEventListener('click', async (event) => {
    const toggle = event.target.closest('[data-staff-toggle]');
    const reset = event.target.closest('[data-staff-reset]');
    const remove = event.target.closest('[data-staff-delete]');
    if (!toggle && !reset && !remove) return;
    staffError('');

    try {
      if (toggle) {
        await fetchJson(`/api/auth/users/${toggle.dataset.staffToggle}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: toggle.dataset.active !== '1' })
        });
      } else if (reset) {
        const data = await fetchJson(`/api/auth/users/${reset.dataset.staffReset}/password`, { method: 'POST' });
        showIssued(data.user, data.password);
      } else if (remove) {
        const row = remove.closest('tr');
        const who = row?.querySelector('td')?.textContent?.trim() || 'сотрудника';
        // Удаление необратимо и лишает человека доступа — спрашиваем.
        if (!confirm(`Удалить ${who}? Доступ пропадёт сразу и восстановить его будет нельзя.`)) return;
        await fetchJson(`/api/auth/users/${remove.dataset.staffDelete}`, { method: 'DELETE' });
      }
      await loadStaff();
    } catch (error) {
      staffError(error.message || 'Действие не выполнено');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !staffEls.page.hidden) closeStaff();
  });
}

/* ─────────────────────────── Профиль и аватарка ─────────────────────────── */

const profileEls = {
  backdrop: document.querySelector('#profileBackdrop'),
  close: document.querySelector('#profileClose'),
  avatarInput: document.querySelector('#avatarInput'),
  avatarRemove: document.querySelector('#avatarRemove'),
  avatarError: document.querySelector('#avatarError'),
  uploadLabelText: document.querySelector('#avatarUploadLabelText')
};

function avatarError(message) {
  profileEls.avatarError.textContent = message || '';
  profileEls.avatarError.hidden = !message;
}

// Сервер тоже проверяет размер и формат (защита не только на клиенте), но
// гонять по сети мегабайтный оригинал ради круглой картинки 40×40 незачем —
// сжимаем квадратом с центральным кропом здесь же, в браузере, без единой
// внешней зависимости (Canvas — встроенный в браузер API).
const AVATAR_SIZE = 256;

function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Файл повреждён или это не изображение'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function openProfile() {
  avatarError('');
  profileEls.backdrop.hidden = false;
  document.body.classList.add('is-modal-open');
  profileEls.close.focus();
}

function closeProfile() {
  profileEls.backdrop.hidden = true;
  document.body.classList.remove('is-modal-open');
  setActiveTab('analytics');
}

function bindProfile() {
  if (!profileEls.backdrop) return;

  profileEls.close.addEventListener('click', closeProfile);
  profileEls.backdrop.addEventListener('click', (event) => {
    if (event.target === profileEls.backdrop) closeProfile();
  });

  profileEls.avatarInput.addEventListener('change', async () => {
    const file = profileEls.avatarInput.files?.[0];
    profileEls.avatarInput.value = ''; // тот же файл повторно должен вызвать change ещё раз
    if (!file) return;
    avatarError('');
    const original = profileEls.uploadLabelText.textContent;
    profileEls.uploadLabelText.textContent = 'Загрузка…';
    try {
      const dataUrl = await resizeAvatar(file);
      const data = await fetchJson('/api/auth/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ avatarDataUrl: dataUrl })
      });
      currentUser = data.user;
      renderAccount(currentUser);
    } catch (error) {
      avatarError(error.message || 'Не удалось загрузить аватарку');
    } finally {
      profileEls.uploadLabelText.textContent = original;
    }
  });

  profileEls.avatarRemove.addEventListener('click', async () => {
    avatarError('');
    try {
      const data = await fetchJson('/api/auth/avatar', { method: 'DELETE' });
      currentUser = data.user;
      renderAccount(currentUser);
    } catch (error) {
      avatarError(error.message || 'Не удалось удалить аватарку');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !profileEls.backdrop.hidden) closeProfile();
  });
}

/**
 * Вход обязателен: данные закрыты на сервере, но и оболочку показывать без
 * входа незачем — пользователь увидел бы пустой каркас и ошибки вместо
 * понятного «войдите». Проверка идёт ДО инициализации: до ответа сервера
 * ни один запрос данных не уходит.
 */
async function start() {
  let state = null;
  try {
    const response = await fetch('/api/auth/me');
    state = (await response.json())?.data ?? null;
  } catch {
    // Сервер недоступен — не уводим на страницу входа (там будет то же самое),
    // а честно говорим об этом на месте.
    document.querySelector('#shell')?.insertAdjacentHTML('afterbegin',
      '<p class="state state--error">Сервер не отвечает. Обновите страницу.</p>');
    return;
  }

  if (!state?.user) {
    location.replace('/login.html');
    return;
  }

  currentUser = state.user;
  renderAccount(state.user);
  bindRailTabs();
  bindStaff();
  bindProfile();
  init();
}

start();
