/**
 * Дашборд воронки продаж — клиентская часть.
 *
 * Ванильный модуль без сборки. Числа НЕ вычисляются здесь никогда: всё приходит
 * посчитанным с сервера (инвариант 9). Задача этого файла — собрать параметры
 * среза, показать результат и не перепутать ответы между собой.
 */

// Скользящий индикатор сегментов (.glass-seg__thumb) требует JS для расчёта
// позиции — без этого класса CSS держит старую мгновенную заливку кнопки
// как страховку (см. glass-ui.css), а не невидимую активную кнопку.
document.documentElement.classList.add('js-ready');

/** Кто вошёл. Заполняется до инициализации интерфейса (см. start()). */
let currentUser = null;

/* ─────────────────────────── Состояние ─────────────────────────── */

const state = {
  mode: 'static',
  periodType: 'quarter',
  periodValue: '',
  weekStart: '',
  dayValue: '',
  from: '',
  to: '',
  allHistory: false,
  filters: { sourceIds: [], managerIds: [], kevFormats: [] },
  // Отдельные от filters — сужают уже открытую ступень детализации ещё раз,
  // не трогая фильтры всего дашборда сверху.
  detailFilters: { sourceIds: [], managerIds: [], kevFormats: [], currentStage: [], search: '' },
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
  periodPicker: document.querySelector('#periodPicker'),
  periodFrom: document.querySelector('#periodFrom'),
  periodTo: document.querySelector('#periodTo'),
  allHistory: document.querySelector('#allHistory'),
  allHistoryLine: document.querySelector('#allHistoryLine'),
  allHistoryHint: document.querySelector('#allHistoryHint'),
  modeButtons: [...document.querySelectorAll('[data-mode]')],
  modeSeg: document.querySelector('.mode-toggle'),
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
  primaryChart: document.querySelector('#primaryChart'),
  conversionFrom: document.querySelector('#conversionFrom'),
  conversionTo: document.querySelector('#conversionTo'),
  selectedValue: document.querySelector('#selectedValue'),
  selectedNote: document.querySelector('#selectedNote'),
  selectedSecondary: document.querySelector('#selectedSecondary'),
  selectedChart: document.querySelector('#selectedChart'),
  callsPanel: document.querySelector('#callsPanel'),
  callsTotal: document.querySelector('#callsTotal'),
  callsSuccessful: document.querySelector('#callsSuccessful'),
  callsMinutes: document.querySelector('#callsMinutes'),
  callsChart: document.querySelector('#callsChart'),
  callsNote: document.querySelector('#callsNote'),
  sourceBadge: document.querySelector('#sourceBadge'),
  funnel: document.querySelector('#funnel'),
  messages: document.querySelector('#messages'),
  detailsBackdrop: document.querySelector('#detailsBackdrop'),
  detailsModal: document.querySelector('#detailsModal'),
  detailsTitle: document.querySelector('#detailsTitle'),
  detailsSummary: document.querySelector('#detailsSummary'),
  detailsBody: document.querySelector('#detailsBody'),
  detailsClose: document.querySelector('#detailsClose'),
  detailsFiltersToggle: document.querySelector('#detailsFiltersToggle'),
  detailsFilters: document.querySelector('#detailsFilters'),
  detailsSearchToggle: document.querySelector('#detailsSearchToggle'),
  detailsSearchInput: document.querySelector('#detailsSearchInput'),
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
      // Без « г. » на конце: подпись периода в заголовке приходит с сервера
      // (period.js, labelFor) и пишется «Август 2026». Локаль ru-RU добавляет
      // « г. », и один и тот же месяц назывался бы в списке и над ним по-разному.
      const label = date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
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

/**
 * Двигает .glass-seg__thumb к текущей активной кнопке сегмента. Позиция и
 * ширина считаются из реального offsetLeft/offsetWidth активной кнопки —
 * кнопки разной длины текста («Кв» и «Свой», «Статика» и «Динамика»),
 * фиксированное число тут в принципе неверно.
 */
function positionSegThumb(seg) {
  const thumb = seg?.querySelector('.glass-seg__thumb');
  const active = seg?.querySelector('.glass-seg__btn.is-on');
  if (!thumb || !active) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

function renderPeriodControls() {
  if (state.periodType === 'week' && !state.weekStart) state.weekStart = dateKey(new Date());
  if (state.periodType === 'day' && !state.dayValue) state.dayValue = dateKey(new Date());
  if (['month', 'quarter', 'year'].includes(state.periodType)) {
    const options = periodOptions(state.periodType);
    if (!options.some((option) => option.value === state.periodValue)) {
      state.periodValue = defaultPeriodValue(state.periodType);
    }
  }

  // Ручные поля даты видны в попапе картинки независимо от выбранного быстрого
  // типа (раздел «указать даты вручную») — держим их заполненными сразу,
  // а не только в момент, когда пользователь реально переключился на «Свой».
  if (!state.from || !state.to) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    state.from = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`;
    state.to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    els.periodFrom.value = state.from;
    els.periodTo.value = state.to;
    els.periodTo.min = state.from;
    els.periodFrom.max = state.to;
  }

  periodPicker.setState({
    periodType: state.periodType,
    periodValue: state.periodValue,
    weekStart: state.weekStart,
    dayValue: state.dayValue
  });

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
  periodPicker.setDisabled(periodDisabled);
  els.periodFrom.disabled = periodDisabled;
  els.periodTo.disabled = periodDisabled;
}

/* ─────────────────────── Множественный выбор ─────────────────────── */

/**
 * Переносит панель списка в document.body и позиционирует её fixed-координатами
 * триггера — «портал», не просто position:absolute внутри контейнера.
 *
 * Каждая `.glass-panel` (карточка конверсии, воронки) несёт CSS-анимацию
 * появления (rise-in), а анимация — один из способов создать СВОЙ контекст
 * наложения. Список, лежащий внутри такой карточки, физически не может
 * нарисоваться поверх СЛЕДУЮЩЕЙ карточки на странице никаким z-index —
 * стек одного контекста наложения не может перекрыть соседний контекст
 * снаружи себя. Единственный надёжный выход — вынести панель туда, где
 * такого соседа-контекста больше нет: прямо в <body>.
 */
function positionPanelFixed(trigger, panel, { maxWidth = 320 } = {}) {
  const rect = trigger.getBoundingClientRect();
  panel.style.position = 'fixed';
  panel.style.left = `${rect.left}px`;
  panel.style.top = `${rect.bottom + 6}px`;
  // min-width (не width): в CSS у панели ЕЩЁ есть `width: max-content` и
  // `max-width` — так длинные варианты справочника по-прежнему могут
  // раздвинуть панель шире триггера. Инлайновый min-width лишь гарантирует
  // нижнюю границу и перебивает `min-width: 100%` из стилевого файла — та
  // сотня процентов была рассчитана на absolute-позиционирование внутри
  // триггера, а не на fixed-позиционирование от края видового окна.
  panel.style.minWidth = `${rect.width}px`;
  // Не шире окна: без этого длинный текст мог бы вытолкнуть панель вправо
  // за край экрана на узкой мобильной раскладке. Предел параметризован:
  // у календаря периода своя ширина (сетка месяца и подписи недель в неё
  // не помещаются), и общий для списков предел резал бы её вёрстку.
  panel.style.maxWidth = `min(${maxWidth}px, calc(100vw - ${rect.left + 16}px))`;
  document.body.append(panel);
}

/**
 * Стрелка «раскрыть список» для кнопки-триггера. Размеры задаёт CSS
 * (.glass-multi__chevron), здесь только форма — иначе SVG без width/height
 * растягивается на всю доступную высоту строки.
 */
function createChevron() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('glass-multi__chevron');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.append(path);
  return svg;
}

const WEEKDAY_LABELS = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС'];
const MONTH_NAMES = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'
];

/** 42 клетки (6 недель, понедельник первым) для месячной сетки календаря. */
function monthGrid(year, month) {
  const firstOfMonth = new Date(year, month, 1);
  const startWeekday = (firstOfMonth.getDay() + 6) % 7; // 0 = понедельник
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(year, month, i - startWeekday + 1);
    cells.push({ key: dateKey(date), day: date.getDate(), outside: date.getMonth() !== month });
  }
  return cells;
}

const QUICK_PERIOD_TYPES = ['day', 'week', 'month', 'quarter', 'year'];
const QUICK_PERIOD_LABELS = { day: 'День', week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год' };

/**
 * Единая кнопка-календарь: один попап содержит быстрые типы периода
 * (день/неделя/месяц/квартал/год) и произвольный диапазон дат — вместо
 * прежних трёх раздельных виджетов (сегмент типа + список/календарь/диапазон),
 * которые визуально распадались на разные элементы полосы фильтров.
 *
 * Панель сама не хранит применённое состояние периода — только то, что нужно
 * ей самой для отрисовки (какой быстрый тип открыт, на каком месяце сетка).
 * Источник истины — `state.*` снаружи; сюда его заносит `setState()`.
 */
function createPeriodPicker(container, { onPick }) {
  let open = false;
  let quickType = 'quarter';
  let viewYear = 0;
  let viewMonth = 0;
  let current = { periodType: 'quarter', periodValue: '', weekStart: '', dayValue: '' };

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'glass-multi__trigger period-picker__trigger';
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="3"></rect>
      <path d="M8 3v4M16 3v4M3 10h18"></path>
    </svg>`;
  const labelEl = document.createElement('span');
  labelEl.className = 'glass-multi__value';
  labelEl.textContent = 'Период';
  trigger.append(labelEl, createChevron());

  const panel = document.createElement('div');
  panel.className = 'glass period-picker__panel';
  panel.setAttribute('role', 'dialog');
  panel.hidden = true;
  // Сетка, а не сегмент со скользящим бегунком: пять подписей («КВАРТАЛ»
  // длиннее всех) в одну строку не влезали в ширину попапа — крайняя кнопка
  // обрезалась, а внизу панели появлялась горизонтальная прокрутка. В сетке
  // кнопки переносятся сами и всегда видны целиком.
  panel.innerHTML = `
    <div class="period-picker__types" role="group" aria-label="Тип периода">
      ${QUICK_PERIOD_TYPES.map((type) => `<button class="period-picker__type" type="button" data-quick-type="${type}">${QUICK_PERIOD_LABELS[type]}</button>`).join('')}
    </div>
    <div class="period-picker__body"></div>
    <div class="period-picker__manual">
      <span class="period-picker__manual-label">Или укажите даты вручную</span>
    </div>
  `;
  const typesSeg = panel.querySelector('.period-picker__types');
  const body = panel.querySelector('.period-picker__body');
  const manual = panel.querySelector('.period-picker__manual');
  // periodFrom/periodTo — уже существующие элементы разметки (index.html), логика
  // их изменения (onFromChange/onToChange) не переписывается, только переносится
  // сам узел внутрь панели пикера — обработчики переезжают вместе с ним.
  const rangeField = document.querySelector('#periodRange');
  // Разметка могла измениться — молча падать на null нельзя: исключение здесь
  // оборвало бы весь init() и оставило страницу без единого рабочего фильтра.
  if (rangeField) {
    rangeField.hidden = false;
    manual.append(rangeField);
  } else {
    manual.hidden = true;
  }

  container.append(trigger, panel);

  for (const button of typesSeg.querySelectorAll('[data-quick-type]')) {
    button.addEventListener('click', () => setQuickType(button.dataset.quickType));
  }

  /**
   * Два РАЗНЫХ состояния кнопки, которые легко перепутать:
   *  • ПРИМЕНЁН (`.is-on` + бегунок) — период, по которому сейчас построен экран;
   *  • ПРОСМАТРИВАЕТСЯ (`.is-browsing`, только обводка) — чей список/календарь
   *    открыт в панели прямо сейчас.
   * Раньше подсвечивался только применённый, и клик по «День» при применённом
   * квартале выглядел так, будто кнопка не нажалась: тело панели менялось, а
   * подсветка оставалась на «Квартале».
   */
  function renderTypes() {
    const appliedIsQuick = QUICK_PERIOD_TYPES.includes(current.periodType);
    for (const button of typesSeg.querySelectorAll('[data-quick-type]')) {
      const active = appliedIsQuick && button.dataset.quickType === current.periodType;
      button.classList.toggle('is-on', active);
      button.classList.toggle('is-browsing', !active && button.dataset.quickType === quickType);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  function renderCalendarBody(mode) {
    body.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'week-calendar__head';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'week-calendar__nav';
    prev.textContent = '‹';
    prev.setAttribute('aria-label', 'Предыдущий месяц');
    prev.addEventListener('click', () => shiftMonth(-1, mode));
    const title = document.createElement('span');
    title.className = 'week-calendar__title';
    const monthName = MONTH_NAMES[viewMonth];
    title.textContent = `${monthName[0].toUpperCase()}${monthName.slice(1)} ${viewYear}`;
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'week-calendar__nav';
    next.textContent = '›';
    next.setAttribute('aria-label', 'Следующий месяц');
    next.addEventListener('click', () => shiftMonth(1, mode));
    head.append(prev, title, next);
    body.append(head);

    const weekdays = document.createElement('div');
    weekdays.className = 'week-calendar__weekdays';
    for (const label of WEEKDAY_LABELS) {
      const cell = document.createElement('span');
      cell.textContent = label;
      weekdays.append(cell);
    }
    body.append(weekdays);

    const grid = document.createElement('div');
    grid.className = 'week-calendar__grid';
    const rangeStart = mode === 'week' ? current.weekStart : null;
    const rangeEnd = rangeStart ? addDaysKey(rangeStart, 6) : null;
    const today = dateKey(new Date());
    for (const cell of monthGrid(viewYear, viewMonth)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'week-calendar__day';
      if (cell.outside) button.classList.add('is-outside');
      // Будущее выбрать нельзя: такой период даёт пустой расчёт и пустой график,
      // то есть экран, из которого ничего не узнать. Лучше не дать нажать, чем
      // показать правильную подпись периода над тремя нулями.
      if (cell.key > today) button.disabled = true;
      if (mode === 'day' && cell.key === current.dayValue) {
        button.classList.add('is-range-start', 'is-range-end');
      }
      if (mode === 'week' && rangeStart && cell.key >= rangeStart && cell.key <= rangeEnd) {
        button.classList.add('is-in-range');
        if (cell.key === rangeStart) button.classList.add('is-range-start');
        if (cell.key === rangeEnd) button.classList.add('is-range-end');
      }
      button.textContent = String(cell.day);
      button.addEventListener('click', () => {
        setOpen(false);
        if (mode === 'day') onPick({ periodType: 'day', dayValue: cell.key });
        else onPick({ periodType: 'week', weekStart: cell.key });
      });
      grid.append(button);
    }
    body.append(grid);
  }

  function renderListBody(type) {
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'period-picker__list';
    const activeValue = current.periodType === type ? current.periodValue : defaultPeriodValue(type);
    for (const option of periodOptions(type)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'period-picker__list-item';
      if (option.value === activeValue) button.classList.add('is-on');
      button.textContent = option.label;
      button.addEventListener('click', () => {
        setOpen(false);
        onPick({ periodType: type, periodValue: option.value });
      });
      list.append(button);
    }
    body.append(list);
  }

  function renderBody() {
    if (quickType === 'day' || quickType === 'week') renderCalendarBody(quickType);
    else renderListBody(quickType);
  }

  function shiftMonth(delta, mode) {
    viewMonth += delta;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    else if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendarBody(mode);
  }

  function setQuickType(type) {
    quickType = type;
    const anchor = (
      type === 'day' ? (current.dayValue || dateKey(new Date()))
        : type === 'week' ? (current.weekStart || dateKey(new Date()))
          : dateKey(new Date())
    ).split('-').map(Number);
    viewYear = anchor[0];
    viewMonth = anchor[1] - 1;
    renderTypes();
    renderBody();
  }

  function setOpen(next) {
    open = next;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      // Открываем на виде применённого типа, если он один из пяти быстрых; если применён
      // произвольный диапазон (custom), вид панели НЕ сбрасывается принудительно на квартал —
      // остаётся тот, что был открыт в прошлый раз (иначе после «Свой» повторное открытие
      // всегда прыгало бы на квартал, будто он и есть применённый период).
      if (QUICK_PERIOD_TYPES.includes(current.periodType)) setQuickType(current.periodType);
      else { renderTypes(); renderBody(); }
      // 344, а не общий предел 320: под эту ширину свёрстаны сетка месяца
      // и подписи недель вида «27.05–02.06» (см. .period-picker__panel).
      positionPanelFixed(trigger, panel, { maxWidth: 344 });
    }
  }

  trigger.addEventListener('click', () => { if (!trigger.disabled) setOpen(!open); });
  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target) && !panel.contains(event.target)) setOpen(false);
  });
  // Только скролл СНАРУЖИ панели должен её закрывать (панель визуально «отклеилась» бы
  // от триггера) — сама панель и список внутри неё (period-picker__list) прокручиваются
  // своим overflow-y:auto, и это должно оставаться внутренним скроллом, а не закрывать
  // popover на первом же тике колеса мыши.
  window.addEventListener('scroll', (event) => {
    if (open && !panel.contains(event.target)) setOpen(false);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') { setOpen(false); trigger.focus(); }
  });

  return {
    // `label` — готовая строка с сервера (period.label, напр. «III квартал 2026»):
    // форматирование периода уже решено расчётным модулем, дублировать его
    // здесь ради подписи на кнопке незачем.
    setState(next) {
      current = { ...current, ...next };
      if (next.label !== undefined) labelEl.textContent = next.label;
    },
    setDisabled(next) {
      trigger.disabled = next;
      if (next) setOpen(false);
    }
  };
}

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
  trigger.append(value, badge, createChevron());

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
    if (open) positionPanelFixed(trigger, panel);
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

  // container.contains() одного уже не хватает: панель при открытии переезжает
  // в <body> (positionPanelFixed) и перестаёт быть потомком container — клик
  // внутри самой панели читался бы как «снаружи» и закрывал её мгновенно.
  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target) && !panel.contains(event.target)) setOpen(false);
  });
  // Скролл СТРАНИЦЫ — самый частый способ незаметно рассинхронизировать fixed-панель
  // с триггером, к которому она визуально «приклеена», поэтому закрываем. Но скролл
  // САМОЙ панели (у неё `overflow-y: auto` — список источников/менеджеров может быть
  // длиннее max-height) — это внутренняя прокрутка списка, а не открепление от триггера.
  window.addEventListener('scroll', (event) => {
    if (open && !panel.contains(event.target)) setOpen(false);
  }, true);

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
let periodPicker = null;
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
  } else if (state.periodType === 'day') {
    params.set('periodType', 'day');
    params.set('periodValue', state.dayValue);
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
  trigger.append(valueEl);

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
    if (open) positionPanelFixed(trigger, panel);
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

  // container.contains() одного уже не хватает: панель при открытии переезжает
  // в <body> (positionPanelFixed) и перестаёт быть потомком container.
  document.addEventListener('click', (event) => {
    if (open && !container.contains(event.target) && !panel.contains(event.target)) setOpen(false);
  });
  // Список этапов длинный (16 строк) и прокручивается сам (`overflow-y: auto`) —
  // закрывать popover нужно на скролле СТРАНИЦЫ, не на прокрутке этого списка.
  window.addEventListener('scroll', (event) => {
    if (open && !panel.contains(event.target)) setOpen(false);
  }, true);

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
  // Оттенок темнее→светлее сверху вниз, отдельным счётчиком на каждую из двух
  // воронок (стык раскрашен своим цветом --junction, в счётчик не входит) —
  // раньше все полосы одной воронки были совершенно одинакового тона, и
  // ступени читались только по подписи, не по цвету.
  let companyShade = 0;
  let dealShade = 0;

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
    // Капается на 6 шагов: дальше эффект бы не менялся заметно на глаз,
    // а сам диапазон (92%→38% и 55%→18%, ниже) посчитан так, чтобы даже
    // самая светлая ступень (shade=6) оставалась ЯВНО закрашенной полосой,
    // а не почти сливалась с треком — первая версия шагала слишком мелко
    // (7 п.п. за шаг) и на глаз читалась как «все ступени одного цвета».
    const shade = stage.junction ? 0 : Math.min(6, stage.unit === 'company' ? companyShade++ : dealShade++);
    const shadeRatio = shade / 6;
    const mixTop = Math.round(92 - shadeRatio * 54);
    const mixBottom = Math.round(55 - shadeRatio * 37);
    html += `<div class="${classes.join(' ')}" role="button" tabindex="0"
      style="--row-index:${row}"
      data-stage-role="${esc(stage.role)}" data-stage-name="${esc(stage.name)}"
      title="Показать состав ступени «${esc(stage.name)}»">
      <div class="glass-funnel__name">${esc(stage.position + 1)}. ${esc(stage.name)}</div>
      <div class="glass-funnel__track"><div class="glass-funnel__fill" style="width:${width.toFixed(1)}%; --row-index:${row}; --shade:${shade}"></div></div>
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

/* ─────────────────────────── Графики динамики ─────────────────────────── */

/**
 * Реестр отрисованных графиков: элемент → его данные.
 *
 * График рисуется в РЕАЛЬНЫХ пикселях контейнера, а не в условном viewBox с
 * растяжением: только так круглые точки остаются круглыми, а подписи осей —
 * одного кегля с остальным интерфейсом. Обратная сторона — при изменении
 * ширины окна картинку надо перерисовать, для чего и нужен реестр.
 */
const charts = new Map();

/** Шаг сетки «красивым» числом: 1, 2, 5 × 10^n — иначе на оси стоят 37, 74, 111. */
function niceTicks(maxValue, targetCount = 4) {
  if (!(maxValue > 0)) return [0];
  const rough = maxValue / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  // Верхний уровень округляется ВВЕРХ до кратного шагу. Раньше тики шли до
  // maxValue включительно, то есть последний тик оказывался НИЖЕ максимума ряда
  // (при 74,3% шкала заканчивалась на 50%), а линия рисовалась выше области
  // графика — поверх подписей и соседних элементов карточки.
  const top = Math.ceil(maxValue / step - 1e-9) * step;
  const ticks = [];
  for (let value = 0; value <= top + step * 1e-9; value += step) ticks.push(value);
  return ticks;
}

/**
 * Сколько подписей влезет по ширине, чтобы они не наехали друг на друга.
 * Считается от реальной ширины и длины самой длинной подписи («01.06–07.06»),
 * а не берётся константой: на узком экране подписей должно остаться меньше.
 */
function fitLabelCount(plotWidth, sample) {
  const approxCharWidth = 6.2;
  const needed = Math.max(28, sample.length * approxCharWidth + 14);
  return Math.max(2, Math.min(12, Math.floor(plotWidth / needed)));
}

function labelIndexes(count, maxLabels) {
  if (count <= maxLabels) return Array.from({ length: count }, (_, i) => i);
  const step = (count - 1) / (maxLabels - 1);
  const shown = new Set();
  for (let i = 0; i < maxLabels; i += 1) shown.add(Math.round(i * step));
  return [...shown].sort((a, b) => a - b);
}

function svgEl(name, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/**
 * Линейный график x/y: ось значений слева, пунктирная сетка, точки на каждом
 * измерении, подписи периодов снизу. Без внешних библиотек — тот же принцип,
 * что и у воронки: числа приходят посчитанными с сервера, здесь только рисование.
 *
 * Точки без значения (null — считать не от чего) рвут линию, а не соединяются
 * прямой через пропуск и не превращаются в ноль: ноль и «нет данных» на графике
 * конверсии — разные утверждения.
 */
function drawChart(container, points, format) {
  container.innerHTML = '';
  const values = points.map((point) => point.value).filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    container.innerHTML = '<p class="glass-chart__empty">Недостаточно данных за период</p>';
    return;
  }
  // Ряд целиком в нуле — это не «график сломался», а «когорта окна ещё не дошла
  // до последнего этапа»: цикл сделки длиннее окна тренда. Плоская линия по нулю
  // выглядит поломкой, поэтому вместо неё объясняем причину словами.
  if (values.every((value) => value === 0)) {
    container.innerHTML = '<p class="glass-chart__empty">За это окно ни одна сущность не дошла до конечного этапа —'
      + ' цикл сделки длиннее выбранного масштаба. Возьмите период шире (год).</p>';
    return;
  }

  const width = Math.max(280, Math.round(container.clientWidth || 720));
  const height = 190;
  const padLeft = 46;
  const padRight = 10;
  const padTop = 12;
  const padBottom = 26;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  // Шкала всегда от нуля: у процента конверсии и у минут ноль — осмысленная
  // точка отсчёта, и «обрезанная» снизу шкала преувеличила бы колебания.
  const maxValue = Math.max(...values);
  const ticks = niceTicks(maxValue, 2);
  const scaleMax = ticks[ticks.length - 1] || 1;
  const xAt = (index) => (points.length > 1
    ? padLeft + (plotWidth * index) / (points.length - 1)
    : padLeft + plotWidth / 2);
  const yAt = (value) => padTop + plotHeight * (1 - value / scaleMax);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: String(height) });
  svg.classList.add('glass-chart__svg');

  // Немного горизонтальных линий с подписями уровня — как в ERP: три-четыре
  // ориентира, а не частая сетка, которая спорит с самой линией за внимание.
  for (const tick of ticks) {
    const y = yAt(tick);
    svg.append(svgEl('line', { x1: padLeft, y1: y.toFixed(1), x2: width - padRight, y2: y.toFixed(1), class: 'glass-chart__grid' }));
    const label = svgEl('text', { x: padLeft - 8, y: (y + 3.5).toFixed(1), class: 'glass-chart__axis' });
    label.textContent = format(tick);
    svg.append(label);
  }

  const coords = points.map((point, index) => (
    Number.isFinite(point.value) ? { x: xAt(index), y: yAt(point.value), point } : null
  ));

  const segments = [];
  let run = [];
  for (const coord of coords) {
    if (coord === null) {
      if (run.length > 0) segments.push(run);
      run = [];
    } else {
      run.push(coord);
    }
  }
  if (run.length > 0) segments.push(run);

  const baseY = yAt(0).toFixed(1);
  for (const segment of segments) {
    if (segment.length > 1) {
      const line = segment.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
      svg.append(svgEl('path', {
        d: `${line} L${segment[segment.length - 1].x.toFixed(1)},${baseY} L${segment[0].x.toFixed(1)},${baseY} Z`,
        class: 'glass-chart__area'
      }));
      svg.append(svgEl('path', { d: line, class: 'glass-chart__line' }));
    }
    for (const coord of segment) {
      svg.append(svgEl('circle', { cx: coord.x.toFixed(1), cy: coord.y.toFixed(1), r: '3', class: 'glass-chart__dot' }));
    }
  }

  // Прозрачная полоса на каждый бакет: попасть курсором в саму точку трудно,
  // а в её вертикальную полосу — легко. Сама полоса ничего не рисует — при
  // наведении показываются вертикальная направляющая, увеличенная точка и
  // карточка со значением, как в ERP. Широкая цветная подсветка полосы,
  // которая была здесь раньше, спорила с линией за внимание.
  const hover = document.createElement('div');
  hover.className = 'glass-chart__hover';

  const guide = document.createElement('span');
  guide.className = 'glass-chart__guide';
  const marker = document.createElement('span');
  marker.className = 'glass-chart__marker';
  const tip = document.createElement('div');
  tip.className = 'glass-chart__tip';
  const tipLabel = document.createElement('span');
  tipLabel.className = 'glass-chart__tip-label';
  const tipValue = document.createElement('span');
  tipValue.className = 'glass-chart__tip-value';
  tip.append(tipLabel, tipValue);
  hover.append(guide, marker, tip);

  const percent = (px) => `${(px / width) * 100}%`;

  const showAt = (index) => {
    const point = points[index];
    const known = Number.isFinite(point.value);
    tipLabel.textContent = point.label;
    tipValue.textContent = known ? format(point.value) : 'нет данных';
    guide.style.left = percent(xAt(index));
    guide.classList.add('is-visible');
    tip.style.left = percent(xAt(index));
    // Карточка держится над точкой, а над самой верхней точкой — под ней,
    // иначе она уходит за границу панели и обрезается.
    const y = known ? yAt(point.value) : padTop + plotHeight / 2;
    const above = y > padTop + 34;
    tip.style.top = `${above ? y - 12 : y + 46}px`;
    // У краёв карточка прижимается к своей стороне вместо центрирования:
    // отцентрированная по крайней точке, она наполовину вылезает за панель.
    const edge = index === 0 ? 'left' : (index === points.length - 1 ? 'right' : 'center');
    const shiftX = edge === 'left' ? '0' : (edge === 'right' ? '-100%' : '-50%');
    tip.style.transform = `translate(${shiftX}, ${above ? '-100%' : '0'})`;
    tip.classList.add('is-visible');
    if (known) {
      marker.style.left = percent(xAt(index));
      marker.style.top = `${y}px`;
      marker.classList.add('is-visible');
    } else {
      marker.classList.remove('is-visible');
    }
  };

  const hide = () => {
    guide.classList.remove('is-visible');
    marker.classList.remove('is-visible');
    tip.classList.remove('is-visible');
  };

  for (let index = 0; index < points.length; index += 1) {
    const band = document.createElement('div');
    band.className = 'glass-chart__band';
    band.style.left = `${((xAt(index) - plotWidth / points.length / 2) / width) * 100}%`;
    band.style.width = `${(plotWidth / points.length / width) * 100}%`;
    const value = Number.isFinite(points[index].value) ? format(points[index].value) : 'нет данных';
    // Доступное имя остаётся: для чтения с экрана карточка-подсказка бесполезна.
    band.setAttribute('aria-label', `${points[index].label}: ${value}`);
    band.addEventListener('pointerenter', () => showAt(index));
    band.addEventListener('pointerleave', hide);
    hover.append(band);
  }
  hover.addEventListener('pointerleave', hide);

  const shown = labelIndexes(points.length, fitLabelCount(plotWidth, points[0].label));
  for (const index of shown) {
    const text = svgEl('text', {
      x: xAt(index).toFixed(1),
      y: String(height - 8),
      class: 'glass-chart__axis glass-chart__axis--x',
      'text-anchor': index === 0 ? 'start' : (index === points.length - 1 ? 'end' : 'middle')
    });
    text.textContent = points[index].label;
    svg.append(text);
  }

  container.append(svg, hover);
}

/** Рисует и запоминает график, чтобы перерисовать его при изменении ширины окна. */
function renderChart(container, points, format) {
  charts.set(container, { points, format });
  drawChart(container, points, format);
}

let chartResizeTimer = null;
window.addEventListener('resize', () => {
  // Перерисовка на каждый пиксель ресайза не нужна: ширина меняется пачками.
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    for (const [container, chart] of charts) {
      if (container.isConnected) drawChart(container, chart.points, chart.format);
    }
  }, 120);
});

const formatPercent = (value) => `${Math.round(value * 10) / 10}%`;
const formatMinutes = (value) => num(Math.round(value));

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
  } else {
    // Иначе число осталось бы от ПРОШЛОГО среза, а график ниже перерисовывается
    // всегда — карточка показывала бы число одного периода и линию другого.
    els.primaryValue.textContent = '—';
    els.primaryNote.textContent = primary?.error
      ? 'Конечный этап раньше начального — выберите корректный диапазон.'
      : 'Главная конверсия недоступна для этого среза.';
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

  const buckets = data.dynamics?.buckets || [];

  const primaryPoints = buckets.map((bucket) => ({ label: bucket.label, value: bucket.primaryValue }));
  renderChart(els.primaryChart, primaryPoints, formatPercent);

  const selectedPoints = buckets.map((bucket) => ({ label: bucket.label, value: bucket.selectedValue }));
  if (selected && !selected.error) {
    renderChart(els.selectedChart, selectedPoints, formatPercent);
  } else {
    els.selectedChart.innerHTML = '<p class="glass-chart__empty">Выберите два этапа, чтобы увидеть динамику</p>';
  }
}

function render(data) {
  const period = data.appliedRequest.period;
  els.periodLabel.textContent = period.label;
  periodPicker.setState({ label: period.label });

  // Поля «указать даты вручную» держим отражающими РЕАЛЬНО применённый период, а не
  // застывший дефолт с первого открытия — иначе они показывали бы один и тот же диапазон
  // независимо от того, какой квартал/месяц сейчас выбран, что выглядит как не считанные
  // данные. Если период не имеет нижней границы («Вся история») — оставляем поле «от» как есть.
  if (period.fromDay) state.from = period.fromDay;
  state.to = period.toDay;
  els.periodFrom.value = state.from;
  els.periodTo.value = state.to;
  // Верхнюю границу поля «от» здесь НЕ ставим: после просмотра I квартала max
  // остался бы 31 марта, и выбрать июнь началом нового диапазона стало бы
  // нельзя, пока не поправишь сначала «до». Перевёрнутый ввод и так чинится
  // подтягиванием соседнего поля (onFromChange/onToChange).
  els.periodTo.min = state.from;

  const freshness = data.freshness;
  const stale = freshness.stale;
  setStatus(
    els.freshness,
    `Данные на ${dateTime(freshness.lastSuccessAt || freshness.snapshotAt)}`,
    stale ? 'stale' : 'ok'
  );

  // Источник данных — постоянная плашка, а не сообщение в общем списке: список
  // сообщений прокручивается и его можно не заметить, а спутать демо-цифры
  // с боевыми — самая дорогая ошибка, которую этот экран допускает.
  els.sourceBadge.hidden = freshness.source !== 'demo';

  renderConversions(data);

  const calls = data.calls || { total: 0, successful: 0, minutes: 0, series: [] };
  // Нули из-за неподключённой телефонии — это не измерение. Сервер отличает
  // «звонков не было» от «раздел не наполняется» (CALLS_UNAVAILABLE), и карточка
  // обязана показывать прочерк, а не убедительный ноль.
  const callsUnavailable = (data.warnings || []).some((w) => w.code === 'CALLS_UNAVAILABLE');
  els.callsPanel.classList.toggle('is-unavailable', callsUnavailable);
  els.callsNote.hidden = !callsUnavailable;
  els.callsTotal.textContent = callsUnavailable ? '—' : num(calls.total);
  els.callsSuccessful.textContent = callsUnavailable ? '—' : num(calls.successful);
  els.callsMinutes.textContent = callsUnavailable ? '—' : num(calls.minutes);
  if (callsUnavailable) {
    els.callsChart.innerHTML = '<p class="glass-chart__empty">Телефония портала не подключена</p>';
  } else {
    renderChart(
      els.callsChart,
      calls.series.map((bucket) => ({ label: bucket.label, value: bucket.minutes })),
      (value) => `${num(value)} мин`
    );
  }

  renderFunnel(data.stages);

  // YOUNG_COHORT («период ещё не закончился, когорта не успела дойти до низа»)
  // намеренно не показываем: вместе с клиентским PERIOD_CLAMPED (тоже убран)
  // это читалось как два почти одинаковых сообщения подряд ради одного факта.
  // Мастхэв — пустой снимок и «пусто из-за фильтров» — остаются.
  const notices = (data.notices || []).filter((notice) => notice.code !== 'YOUNG_COHORT');
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
    ? ['ID', entityWord[0].toUpperCase() + entityWord.slice(1), 'Компания', 'База', 'Менеджер', 'Формат КЭВ', 'Текущий этап', 'Дата этапа', '']
    : ['ID', 'Компания', 'База', 'Менеджер', 'Текущий этап', 'Дата этапа', ''];

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

/** Строк детализации на одной странице. */
const DETAILS_PAGE_SIZE = 10;

async function loadDetails(stageRole, page = 1) {
  const seq = ++state.detailsSeq;
  els.detailsBody.innerHTML = '<p class="state state--loading">Загружаю состав ступени…</p>';
  try {
    const params = sliceParams();
    params.set('stageRole', stageRole);
    params.set('page', String(page));
    // По десять строк на страницу: на ступени «Новая компания» их тысячи, и
    // сотня строк в модалке — это простыня, которую листают колесом вместо
    // того, чтобы смотреть состав. Постраничный переход уже есть ниже.
    params.set('pageSize', String(DETAILS_PAGE_SIZE));
    if (state.detailFilters.sourceIds.length > 0) params.set('detailSourceIds', state.detailFilters.sourceIds.join(','));
    if (state.detailFilters.managerIds.length > 0) params.set('detailManagerIds', state.detailFilters.managerIds.join(','));
    if (state.detailFilters.kevFormats.length > 0) params.set('detailKevFormats', state.detailFilters.kevFormats.join(','));
    if (state.detailFilters.currentStage.length > 0) params.set('detailCurrentStage', state.detailFilters.currentStage.join(','));
    if (state.detailFilters.search) params.set('detailSearch', state.detailFilters.search);
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
  state.detailFilters = { sourceIds: [], managerIds: [], kevFormats: [], currentStage: [], search: '' };
  detailFilters.sourceIds.clear();
  detailFilters.managerIds.clear();
  detailFilters.kevFormats.clear();
  detailStageSelect.clear();
  els.detailsFilters.hidden = true;
  els.detailsFiltersToggle.setAttribute('aria-expanded', 'false');
  els.detailsSearchInput.hidden = true;
  els.detailsSearchInput.value = '';
  els.detailsSearchToggle.setAttribute('aria-expanded', 'false');
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
    label: 'База',
    emptyLabel: 'Все базы',
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

  periodPicker = createPeriodPicker(els.periodPicker, {
    onPick: (patch) => {
      Object.assign(state, patch);
      renderPeriodControls();
      loadDashboard();
    }
  });

  const reloadDetails = () => {
    if (state.details) loadDetails(state.details.stageRole, 1);
  };
  detailFilters.sourceIds = createMultiSelect(els.detailSourceFilter, {
    label: 'База (в этой ступени)',
    emptyLabel: 'Все базы',
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
  positionSegThumb(els.modeSeg);
  applyModeHint();

  // Ширина кнопок сегмента (особенно даты в topbar__row) может пересчитаться
  // при переносе строк на ресайзе — слайдер обязан ехать следом, а не
  // застревать на координатах предыдущей ширины окна.
  window.addEventListener('resize', () => {
    positionSegThumb(els.modeSeg);
  });

  // Раньше при начале позже конца поле «конец» просто получало min выше
  // своего же текущего значения и застревало в нативно-невалидном состоянии
  // (браузер помечает поле некорректным, но само значение не трогает) —
  // пользователь видел путаницу в самих полях, хотя расчёт (с серверной
  // перестановкой границ) внизу уже показывал верный диапазон. Проще
  // подтянуть соседнее поле сразу, чем оставлять на нём невалидную дату.
  const onFromChange = () => {
    state.from = els.periodFrom.value;
    if (!state.from) return;
    if (state.to && state.to < state.from) {
      state.to = state.from;
      els.periodTo.value = state.to;
    }
    els.periodTo.min = state.from;
    if (!state.to) return;
    // Поля даты видны независимо от выбранного быстрого типа — их правка
    // всегда означает «применить произвольный диапазон», а не «поправить
    // диапазон, который и так уже применён» (то было верно, когда поля
    // были видны только при уже выбранном «Свой»).
    state.periodType = 'custom';
    renderPeriodControls();
    loadDashboard();
  };
  const onToChange = () => {
    state.to = els.periodTo.value;
    if (!state.to) return;
    if (state.from && state.from > state.to) {
      state.from = state.to;
      els.periodFrom.value = state.from;
    }
    els.periodFrom.max = state.to;
    if (!state.from) return;
    state.periodType = 'custom';
    renderPeriodControls();
    loadDashboard();
  };
  els.periodFrom.addEventListener('change', onFromChange);
  els.periodTo.addEventListener('change', onToChange);

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
      positionSegThumb(els.modeSeg);
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
  els.detailsFiltersToggle.addEventListener('click', () => {
    const next = els.detailsFilters.hidden;
    els.detailsFilters.hidden = !next;
    els.detailsFiltersToggle.setAttribute('aria-expanded', String(next));
  });

  els.detailsSearchToggle.addEventListener('click', () => {
    const opening = els.detailsSearchInput.hidden;
    els.detailsSearchInput.hidden = !opening;
    els.detailsSearchToggle.setAttribute('aria-expanded', String(opening));
    if (opening) {
      els.detailsSearchInput.focus();
    } else if (state.detailFilters.search) {
      els.detailsSearchInput.value = '';
      state.detailFilters.search = '';
      if (state.details) loadDetails(state.details.stageRole, 1);
    }
  });
  let detailsSearchDebounce = null;
  els.detailsSearchInput.addEventListener('input', () => {
    // Дебаунс — ищем по ID сервером на каждое изменение поля, а не только
    // по Enter, но без задержки это была бы отдельная сеть-заявка на КАЖДУЮ
    // нажатую цифру.
    clearTimeout(detailsSearchDebounce);
    detailsSearchDebounce = setTimeout(() => {
      state.detailFilters.search = els.detailsSearchInput.value.trim();
      if (state.details) loadDetails(state.details.stageRole, 1);
    }, 300);
  });
  els.detailsSearchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      els.detailsSearchToggle.click();
    }
  });
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
}

/**
 * Узкая колонка: «Аналитика» — единственный раздел. Профиль открывается по
 * клику на аватар внизу колонки, отдельным пунктом навигации он не является,
 * поэтому подсветку пунктов при его открытии не трогаем: гасить единственную
 * вкладку ради модалки поверх неё означало бы показывать раздел неактивным,
 * пока пользователь в нём и находится.
 */
function bindRailTabs() {
  document.querySelector('[data-tab="analytics"]')?.addEventListener('click', () => {
    closeProfile();
  });
  document.querySelector('#railAvatarButton')?.addEventListener('click', () => {
    openProfile();
  });
  document.querySelector('#logoutButton')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.replace('/login.html');
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
        // По вертикали — не строго по центру. Портретное фото (выше, чем шире)
        // почти всегда снято с лицом в верхней трети и запасом под плечи/грудь
        // ниже — центр кадра приходится на шею, а не на лицо, и кроп срезал
        // макушку/половину лица. Смещение отступа к 20% сверху вместо 50%
        // достаёт лицо в кадр для типичного портрета, не ломая квадратные
        // и горизонтальные фото (там наверху и так почти нечего срезать).
        const sy = (img.naturalHeight - side) * 0.2;
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
  bindProfile();
  init();
}

start();
