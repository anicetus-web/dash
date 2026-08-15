/**
 * Дашборд воронки продаж — клиентская часть.
 *
 * Ванильный модуль без сборки. Числа НЕ вычисляются здесь никогда: всё приходит
 * посчитанным с сервера (инвариант 9). Задача этого файла — собрать параметры
 * среза, показать результат и не перепутать ответы между собой.
 */

/* ─────────────────────────── Состояние ─────────────────────────── */

const state = {
  mode: 'static',
  periodType: 'quarter',
  periodValue: '',
  from: '',
  to: '',
  allHistory: false,
  filters: { sourceIds: [], managerIds: [], kevFormats: [] },
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
  shell: document.querySelector('#shell'),
  sidebarToggle: document.querySelector('#sidebarToggle'),
  periodTabs: [...document.querySelectorAll('[data-period-type]')],
  periodSelect: document.querySelector('#periodSelect'),
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
  detailsClose: document.querySelector('#detailsClose')
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

/** ISO-номер недели: неделя принадлежит году своего четверга. */
function currentWeekKey(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((target - firstThursday) / (7 * 86400000));
  return `${target.getUTCFullYear()}-W${pad(week)}`;
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
  } else if (type === 'week') {
    for (let back = 0; back < 12; back += 1) {
      const date = new Date(now.getTime() - back * 7 * 86400000);
      const key = currentWeekKey(date);
      options.push({ value: key, label: `Неделя ${key.split('-W')[1]} · ${date.getFullYear()}` });
    }
  }
  return options;
}

function defaultPeriodValue(type) {
  const now = new Date();
  if (type === 'week') return currentWeekKey(now);
  if (type === 'month') return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  if (type === 'year') return String(now.getFullYear());
  return currentQuarterKey(now);
}

function renderPeriodControls() {
  const custom = state.periodType === 'custom';
  els.periodSelect.hidden = custom;
  els.periodRange.hidden = !custom;

  if (!custom) {
    const options = periodOptions(state.periodType);
    els.periodSelect.innerHTML = options
      .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
      .join('');
    if (!options.some((option) => option.value === state.periodValue)) {
      state.periodValue = defaultPeriodValue(state.periodType);
    }
    els.periodSelect.value = state.periodValue;
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
  els.periodSelect.disabled = periodDisabled;
  els.periodFrom.disabled = periodDisabled;
  els.periodTo.disabled = periodDisabled;
  for (const tab of els.periodTabs) tab.disabled = periodDisabled;
}

/* ─────────────────────── Множественный выбор ─────────────────────── */

function createMultiSelect(container, { label, onChange }) {
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
      value.textContent = 'Все';
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
      selected = new Set([...selected].filter((id) => items.some((item) => item.id === id)));
      renderPanel();
      renderTrigger();
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

  els.conversionTo.innerHTML = allowed
    .map((stage) => `<option value="${esc(stage.role)}">${esc(stage.name)}</option>`)
    .join('');

  if (!allowed.some((stage) => stage.role === state.conversionTo)) {
    // Прежний конечный этап оказался раньше нового начального — сдвигаем
    // к ближайшему допустимому, а не оставляем рассинхронизацию с DOM.
    state.conversionTo = allowed.at(-1).role;
  }
  els.conversionTo.value = state.conversionTo;
}

async function loadReference() {
  try {
    const reference = await fetchJson('/api/reference');
    state.reference = reference;

    filters.sourceIds.setItems(reference.sources);
    filters.managerIds.setItems(reference.managers);
    filters.kevFormats.setItems(reference.kevFormats);

    const stageOptions = reference.stages
      .map((stage) => `<option value="${esc(stage.role)}">${esc(stage.name)}</option>`)
      .join('');
    els.conversionFrom.innerHTML = stageOptions;

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
    els.conversionFrom.value = state.conversionFrom;
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

function renderFunnel(stages) {
  if (!stages || stages.length === 0) {
    els.funnel.innerHTML = '<p class="state state--empty">Воронка не рассчитана.</p>';
    return;
  }

  const max = Math.max(1, ...stages.map((stage) => stage.count));
  let html = '<div class="glass-funnel">';
  let groupOpened = false;

  for (const stage of stages) {
    if (!groupOpened) {
      html += '<p class="glass-funnel__group">Компании</p>';
      groupOpened = true;
    }

    // Минимальный порог ширины: нулевая ступень обязана оставаться видимой,
    // иначе воронка выглядит оборванной.
    const width = Math.max(1.5, (stage.count / max) * 100);
    const classes = ['glass-funnel__row', 'glass-funnel__row--clickable'];
    if (stage.junction) classes.push('glass-funnel__row--junction');
    else if (stage.unit === 'deal') classes.push('glass-funnel__row--deals');

    const conv = stage.conversionFromPrevious === null || stage.conversionFromPrevious === undefined
      ? '100%'
      : percent(stage.conversionFromPrevious);

    html += `<div class="${classes.join(' ')}" role="button" tabindex="0"
      data-stage-role="${esc(stage.role)}" data-stage-name="${esc(stage.name)}"
      title="Показать состав ступени «${esc(stage.name)}»">
      <div class="glass-funnel__name">${esc(stage.position + 1)}. ${esc(stage.name)}</div>
      <div class="glass-funnel__track"><div class="glass-funnel__fill" style="width:${width.toFixed(1)}%"></div></div>
      <div class="glass-funnel__count num">${num(stage.count)}</div>
      <div class="glass-funnel__conv num">${conv}</div>`;

    if (stage.junction) {
      html += `<div class="glass-funnel__subcount">из ${num(stage.companyCount)} компаний</div>`;
    }
    html += '</div>';

    if (stage.junction) html += '<p class="glass-funnel__group">Сделки</p>';
  }

  html += '</div>';
  els.funnel.innerHTML = html;
}

function renderConversions(data) {
  const primary = data.primaryConversion;
  if (primary && !primary.error) {
    els.primaryValue.textContent = primary.available ? percent(primary.value) : '0%';
    els.primaryRange.textContent = `${primary.fromName} → ${primary.toName}`;
    els.primaryNote.textContent = primary.available
      ? `${num(primary.toCount)} сделок с авансом из ${num(primary.fromCount)} компаний, взятых в работу.`
      : 'Нет компаний, взятых в работу в этом срезе — считать не от чего.';
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
      : 'Нет исходных сущностей на начальном этапе.';

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
  renderMessages(data.warnings, notices);
}

/* ─────────────────────── Детализация ступени ─────────────────────── */

function renderDetails(details) {
  const isDeal = details.stage.unit === 'deal';
  const rows = details.rows;

  if (rows.length === 0) {
    els.detailsBody.innerHTML = '<p class="state state--empty">На этой ступени нет сущностей в выбранном срезе.</p>';
    return;
  }

  const head = isDeal
    ? ['ID', 'Сделка', 'Компания', 'Источник', 'Менеджер', 'Формат КЭВ', 'Текущий этап', 'Дата этапа', '']
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

  els.detailsBody.innerHTML = `
    <div class="details-meta">
      <span>Всего: <b class="num">${num(details.count)}</b> ${isDeal ? 'сделок' : 'компаний'}</span>
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
    const details = await fetchJson(`/api/details?${params}`);
    if (seq !== state.detailsSeq) return; // открыли другую ступень, пока грузилась эта
    state.details = { stageRole, page };
    els.detailsSummary.textContent =
      `${details.appliedRequest.period.label} · ${details.appliedRequest.mode === 'static' ? 'Статика' : 'Динамика'}`;
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
  els.detailsClose.focus();
  loadDetails(stageRole, 1);
}

function closeDetails() {
  els.detailsBackdrop.hidden = true;
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
    onChange: (values) => { state.filters.sourceIds = values; loadDashboard(); }
  });
  filters.managerIds = createMultiSelect(els.managerFilter, {
    label: 'Менеджер',
    onChange: (values) => { state.filters.managerIds = values; loadDashboard(); }
  });
  filters.kevFormats = createMultiSelect(els.kevFilter, {
    label: 'Формат КЭВ',
    onChange: (values) => { state.filters.kevFormats = values; loadDashboard(); }
  });

  state.periodValue = defaultPeriodValue(state.periodType);
  renderPeriodControls();
  applyModeHint();

  els.sidebarToggle.addEventListener('click', () => {
    const collapsed = els.shell.classList.toggle('is-collapsed');
    els.sidebarToggle.textContent = collapsed ? '›' : '‹';
    els.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    els.sidebarToggle.setAttribute('aria-label', collapsed ? 'Развернуть панель' : 'Свернуть панель');
  });

  for (const tab of els.periodTabs) {
    tab.addEventListener('click', () => {
      state.periodType = tab.dataset.periodType;
      renderPeriodControls();
      loadDashboard();
    });
  }

  els.periodSelect.addEventListener('change', () => {
    state.periodValue = els.periodSelect.value;
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

  els.conversionFrom.addEventListener('change', () => {
    state.conversionFrom = els.conversionFrom.value;
    updateConversionToOptions();
    loadDashboard();
  });
  els.conversionTo.addEventListener('change', () => {
    state.conversionTo = els.conversionTo.value;
    loadDashboard();
  });

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

init();
