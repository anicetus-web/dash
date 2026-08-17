// Детерминированный генератор демонстрационного снимка.
//
// Доступа к порталу Битрикс24 нет (приложение А4 спеки), поэтому до появления ключа
// снимок наполняет этот модуль. Он стоит на месте интеграционного адаптера: расчётный
// модуль, API и интерфейс не знают, кто наполнил снимок — генератор или портал.
//
// Три требования, которым подчинён весь файл:
//
//  1. ДЕТЕРМИНИЗМ. Одна и та же пара (зерно, «сейчас») даёт побайтово один и тот же снимок.
//     Собственный ГПСЧ; `Math.random()` не вызывается ни разу — иначе каждый запуск давал бы
//     другие числа и проверки перестали бы что-либо доказывать.
//  2. ПРАВДОПОДОБИЕ. Данные показывают заказчику: названия компаний, объектов и каналов
//     привлечения — настоящий B2B металлоконструкций и проектирования, воронка сужается
//     неровно, доли между этапами не совпадают и не круглые.
//  3. ПОЛНОТА КРАЕВЫХ СЛУЧАЕВ. На демо доказывается правильность расчёта, поэтому в снимке
//     обязаны физически присутствовать: компании с несколькими потребностями, откаты в обеих
//     воронках, повторные продвижения после отката, отказы с сохранённым путём, пропущенные
//     этапы, повторные входы на этап, передачи между менеджерами, записи без источника и КЭВ.
//     Наличие каждого случая проверяет `scripts/check-demo.mjs` фактическим поиском по снимку.
//
// Этапы и технические ID стадий берутся ИЗ ДОМЕННОЙ КОНФИГУРАЦИИ (`src/domain/funnels.js`)
// и здесь не выписываются литералами: после аудита портала генератор не правится.
// Форма снимка берётся из `src/storage/jsonStore.js` (EMPTY_CACHE) — генератор её не изобретает.
import { config } from '../config.js';
import {
  FUNNELS,
  LOST_STAGE_IDS,
  SERVICE_STAGE_IDS
} from '../domain/funnels.js';
import { dateOrNull } from '../lib/records.js';
import { emptySnapshot } from '../storage/jsonStore.js';

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 1. ПАРАМЕТРЫ ОБЪЁМА И ФОРМЫ ВОРОНКИ.
 * ------------------------------------------------------------------------- */

/** Пометка источника наполнения снимка. */
export const DEMO_SOURCE_ID = 'demo';

/** Сколько компаний генерируется по умолчанию (тикет 04: порядка 300–500). */
export const DEMO_COMPANY_COUNT = 500;

/** Глубина истории в календарных днях: больше 12 месяцев, чтобы год был непустым. */
export const DEMO_HISTORY_DAYS = 430;

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Рабочий день портала: события ложатся между 9:00 и 18:00 по часам портала.
const WORK_HOUR_FROM = 9;
const WORK_HOUR_TO = 18;

// Доля компаний, переходящих с этапа k на этап k+1 первой воронки.
// Числа намеренно неровные и разные: ровные доли на защите читаются как синтетика.
const COMPANY_PASS_RATES = [0.928, 0.907, 0.872, 0.849, 0.881];

// То же для второй воронки: от «Потребность выявлена» до «Передано в производство».
// Провалы на «КП защищено» и «Реквизиты получены» — узкое место реального цикла продаж.
const DEAL_PASS_RATES = [0.847, 0.792, 0.634, 0.581, 0.774, 0.826, 0.719, 0.853, 0.512];

// Разрыв между соседними этапами в рабочих днях: [минимум, максимум].
const COMPANY_STAGE_GAPS = [
  [0, 0], // «Новая компания» → «Взят в работу» задаётся якорем когорты, см. buildCompany
  [1, 7], // Взят в работу → Первичный контакт
  [2, 11], // Первичный контакт → Вышел на ЛПР
  [1, 9], // Вышел на ЛПР → Квалификация пройдена
  [2, 12] // Квалификация пройдена → Потребность выявлена
];

const DEAL_STAGE_GAPS = [
  [2, 14], // Потребность выявлена → Исходные данные получены
  [3, 16], // Исходные данные → КП отправлено
  [2, 12], // КП отправлено → КП защищено
  [2, 10], // КП защищено → Реквизиты получены
  [3, 15], // Реквизиты → Согласование договора
  [1, 8], // Согласование → Договор отправлен на подпись
  [2, 12], // Отправлен на подпись → Договор подписан
  [2, 14], // Договор подписан → Аванс получен
  [3, 18] // Аванс получен → Передано в производство
];

// Вероятности краевых случаев. Подобраны так, чтобы каждый случай встречался
// в количестве, достаточном для проверки, но не превращался в основную массу данных.
const RATES = {
  companyServiceStage: 0.15, // компания заведена стадией «создана» до входа в воронку
  dealServiceStage: 0.12,
  companySkippedStage: 0.11, // менеджер не отметил промежуточный этап
  dealSkippedStage: 0.09,
  companyRollback: 0.11, // откат компании (история обязана сохраниться)
  companyRollbackRecovery: 0.45, // ... и часть откатившихся снова продвинулась
  dealLost: 0.52, // сделка ушла в отказ, не дойдя до аванса
  dealRollback: 0.34, // откат активной сделки (глубина обрезается текущей стадией)
  dealRollbackRecovery: 0.5,
  companyHandover: 0.19, // передача компании другому менеджеру посреди пути
  dealHandover: 0.23,
  companyWithoutSource: 0.065, // база не заполнена → «Источник не указан»
  dealSourceLost: 0.05, // источник не перенёсся в дочернюю сделку автоматизацией
  dealWithoutKev: 0.19 // формат КЭВ не заполнен → «Не указано»
};

// Сколько потребностей даёт компания, дошедшая до точки соединения.
const NEEDS_PER_COMPANY = [
  [1, 0.42],
  [2, 0.3],
  [3, 0.18],
  [4, 0.1]
];

// Звонки по сделке: большинство — 0–3, хвост длиннее у сложных циклов согласования.
const DEAL_CALL_COUNTS = [
  [0, 0.22],
  [1, 0.27],
  [2, 0.21],
  [3, 0.14],
  [4, 0.09],
  [5, 0.05],
  [6, 0.02]
];

// Прозвон компании ДО появления сделки (holodный обзвон/квалификация) — реже и короче.
const COMPANY_CALL_COUNTS = [
  [0, 0.58],
  [1, 0.24],
  [2, 0.12],
  [3, 0.06]
];

// Доля дозвонов, закончившихся разговором, а не гудками/автоответчиком.
const CALL_SUCCESS_RATE = 0.64;

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 2. СПРАВОЧНИКИ. Живые названия строительно-производственного B2B.
 * ------------------------------------------------------------------------- */

const MANAGERS = [
  { id: '101', name: 'Ирина Ковалёва', weight: 0.19 },
  { id: '102', name: 'Дмитрий Соколов', weight: 0.17 },
  { id: '103', name: 'Анна Мельникова', weight: 0.16 },
  { id: '104', name: 'Сергей Кузнецов', weight: 0.14 },
  { id: '105', name: 'Ольга Тарасова', weight: 0.13 },
  { id: '106', name: 'Павел Логинов', weight: 0.12 },
  { id: '107', name: 'Максим Дьяченко', weight: 0.09 }
];

const SOURCES = [
  { id: '301', name: 'Холодный обзвон', weight: 0.26 },
  { id: '302', name: 'Входящая заявка с сайта', weight: 0.21 },
  { id: '303', name: 'Тендерная площадка', weight: 0.17 },
  { id: '304', name: 'Отраслевая выставка «Металлоконструкции»', weight: 0.14 },
  { id: '305', name: 'Партнёрская сеть', weight: 0.12 },
  { id: '306', name: 'Рекомендация действующего клиента', weight: 0.1 }
];

const KEV_FORMATS = [
  { id: '401', name: 'Защита по телефону', weight: 0.33 },
  { id: '402', name: 'Онлайн-встреча', weight: 0.46 },
  { id: '403', name: 'Очная встреча', weight: 0.21 }
];

// Человеческие названия служебных стадий и стадий отказа: доменная конфигурация
// хранит только их технические ID, а справочник снимка обязан давать подпись.
const SERVICE_STAGE_NAMES = {
  '3DB_C:CREATED': 'Компания создана',
  '3DB_D:CREATED': 'Сделка создана'
};

const LOST_STAGE_NAMES = {
  '3DB_D:LOSE': 'Отказ клиента',
  '3DB_D:APOLOGY': 'Отказ: не беремся за объект'
};

// Названия компаний собираются комбинаторно из отраслевых частей: проектные бюро,
// застройщики, подрядчики, заводы металлоконструкций, инженерные компании.
const LEGAL_FORMS = ['ООО', 'АО', 'ЗАО', 'ПАО', 'ГК', 'НПО', 'ПКФ', 'ТД'];

const NAME_PREFIXES = [
  'Строй', 'Пром', 'Металл', 'Спец', 'Гидро', 'Энерго', 'Тех', 'Инж',
  'Урал', 'Сиб', 'Волга', 'Север', 'Транс', 'Тепло', 'Крон', 'Ново'
];

const NAME_TAILS = [
  'проект', 'монтаж', 'конструкция', 'комплект', 'ресурс', 'сервис',
  'инвест', 'индустрия', 'альянс', 'каркас', 'профиль', 'сталь'
];

const COMPANY_KINDS = [
  'Проектное бюро', 'Инженерный центр', 'Завод металлоконструкций',
  'Строительная компания', 'Монтажное управление', 'Производственное объединение',
  'Домостроительный комбинат', 'Конструкторское бюро', 'Подрядное управление',
  'Завод железобетонных изделий'
];

const COMPANY_BRANDS = [
  'Атлант', 'Меридиан', 'Вертикаль', 'Гранит', 'Каскад', 'Магистраль',
  'Пирамида', 'Форт', 'Ригель', 'Профиль', 'Вектор', 'Оптимум',
  'Тандем', 'Эталон', 'Аркада', 'Базис', 'Кристалл', 'Титан', 'Азимут', 'Опора'
];

const GEO_PREFIXES = ['Урал', 'Сиб', 'Волго', 'Дон', 'Балт', 'Кама', 'Ока', 'Печора'];

const GEO_TAILS = ['стальконструкция', 'стройпроект', 'металлсервис', 'промстрой', 'монтажстрой'];

// Объекты потребностей: по одному такому объекту заводится отдельная сделка.
const OBJECT_TYPES = [
  'Складской комплекс', 'Производственный цех', 'Ангар', 'Логистический терминал',
  'Автосалон', 'Торговый центр', 'Зерносушильный комплекс', 'Навес над эстакадой',
  'Надземный переход', 'Резервуарный парк', 'Административно-бытовой корпус',
  'Спортивный зал', 'Птицефабрика', 'Пожарное депо', 'Крытая парковка',
  'Ремонтное депо', 'Котельная', 'Элеватор', 'Цех металлообработки', 'Склад удобрений'
];

const WORK_TYPES = [
  'КМ', 'КМД', 'КМ/КМД', 'АР+КМ', 'обследование конструкций',
  'проект каркаса', 'усиление конструкций', 'КЖ', 'узлы и деталировка'
];

const CITIES = [
  'Тверь', 'Ногинск', 'Казань', 'Липецк', 'Череповец', 'Новосибирск',
  'Домодедово', 'Тольятти', 'Пермь', 'Ростов-на-Дону', 'Смоленск', 'Обнинск',
  'Псков', 'Курск', 'Энгельс', 'Тюмень', 'Иваново', 'Барнаул', 'Волжский', 'Клин'
];

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 3. ГЕНЕРАТОР ПСЕВДОСЛУЧАЙНЫХ ЧИСЕЛ.
 * mulberry32: короткий, быстрый, полностью воспроизводимый. Состояние — одно
 * 32-битное число, поэтому последовательность зависит ТОЛЬКО от зерна.
 * ------------------------------------------------------------------------- */

function hashSeed(seed) {
  const text = typeof seed === 'number' && Number.isFinite(seed) ? String(Math.trunc(seed)) : String(seed ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Поток псевдослучайных чисел от зерна. Одно зерно — одна последовательность,
 * поэтому весь снимок воспроизводим.
 */
export function createRandom(seed) {
  let state = hashSeed(seed) || 1;

  function float() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    float,
    /** Целое из диапазона включительно. */
    int(min, max) {
      if (max <= min) return min;
      return min + Math.floor(float() * (max - min + 1));
    },
    /** Событие с заданной вероятностью. */
    chance(probability) {
      return float() < probability;
    },
    pick(list) {
      return list[Math.floor(float() * list.length)];
    },
    /** Выбор из списка пар [значение, вес]. Веса не обязаны давать в сумме единицу. */
    weighted(pairs) {
      let total = 0;
      for (const [, weight] of pairs) total += weight;
      let point = float() * total;
      for (const [value, weight] of pairs) {
        point -= weight;
        if (point < 0) return value;
      }
      return pairs[pairs.length - 1][0];
    },
    shuffle(list) {
      const copy = [...list];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = Math.floor(float() * (index + 1));
        const swap = copy[index];
        copy[index] = copy[other];
        copy[other] = swap;
      }
      return copy;
    }
  };
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 4. КАЛЕНДАРЬ ПОРТАЛА.
 * События ложатся на рабочие дни и рабочие часы ПОРТАЛА, а не UTC: иначе вечерние
 * события уезжали бы в соседние сутки и демо расходилось бы с тем, что заказчик
 * увидит в карточке Битрикса (инвариант 11).
 * ------------------------------------------------------------------------- */

const formatterCache = new Map();

function zoneFormatter(timeZone) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function zoneParts(ms, timeZone) {
  const raw = {};
  for (const part of zoneFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') raw[part.type] = part.value;
  }
  return {
    year: Number(raw.year),
    month: Number(raw.month),
    day: Number(raw.day),
    hour: Number(raw.hour) % 24,
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: raw.weekday
  };
}

// Сдвиг зоны на конкретный момент. Берётся у Intl, а не «прошит числом часов»:
// в зонах с переводом стрелок фиксированный сдвиг дважды в год давал бы сбой на час.
function zoneOffsetMs(ms, timeZone) {
  const parts = zoneParts(ms, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

// Полночь по часам портала для суток, в которые попал момент, — в виде UTC-миллисекунд.
function startOfLocalDay(ms, timeZone) {
  const parts = zoneParts(ms, timeZone);
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day);
  const guess = wall - zoneOffsetMs(ms, timeZone);
  return wall - zoneOffsetMs(guess, timeZone);
}

const WEEKEND = new Set(['Sat', 'Sun']);

/**
 * Рабочие дни портала от начала окна истории до «сейчас».
 * Каждый элемент — полночь рабочего дня в UTC-миллисекундах.
 * Выходные пропускаются: продажи в субботу этапы не двигают, а ровное распределение
 * по всем семи дням выглядит неживым.
 */
function businessCalendar(fromMs, toMs, timeZone) {
  const days = [];
  let dayStart = startOfLocalDay(fromMs, timeZone);
  // Ограничение на число итераций — защита от зацикливания на экзотической зоне.
  for (let guard = 0; guard < 4000 && dayStart <= toMs; guard += 1) {
    const parts = zoneParts(dayStart + 12 * HOUR_MS, timeZone);
    if (!WEEKEND.has(parts.weekday)) days.push(dayStart);
    // Шаг «полночь + 36 часов» приходится на середину следующих суток при любом
    // переводе стрелок, поэтому день не теряется и не дублируется.
    dayStart = startOfLocalDay(dayStart + 36 * HOUR_MS, timeZone);
  }
  return days;
}

/**
 * Ход сущности по календарю. Возвращает момент очередного события или `null`,
 * если событие вышло бы за «сейчас»: будущего в истории не бывает (инвариант 10),
 * а оборванный путь — это нормальная незавершённая сущность.
 */
function createWalk({ calendar, random, nowMs, startDayIndex, notBefore = null }) {
  let dayIndex = startDayIndex;
  let lastMs = notBefore;

  function emit() {
    if (dayIndex < 0 || dayIndex >= calendar.length) return null;
    let ms = calendar[dayIndex] + random.int(WORK_HOUR_FROM, WORK_HOUR_TO) * HOUR_MS + random.int(0, 59) * MINUTE_MS;
    // Порядок событий строгий: два этапа не могут прийтись на один и тот же момент.
    if (lastMs !== null && ms <= lastMs) ms = lastMs + random.int(25, 95) * MINUTE_MS;
    if (ms > nowMs) return null;
    lastMs = ms;
    return ms;
  }

  return {
    dayIndex: () => dayIndex,
    lastMs: () => lastMs,
    /** Событие в текущем дне. */
    here: () => emit(),
    /** Событие через случайный разрыв в рабочих днях. */
    after(minGap, maxGap) {
      dayIndex += random.int(minGap, maxGap);
      return emit();
    }
  };
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 5. НАЗВАНИЯ.
 * ------------------------------------------------------------------------- */

// Пул названий компаний. Собирается один раз, перемешивается зерном и раздаётся
// без повторов: две компании с одинаковым названием в демо выглядят как ошибка выгрузки.
function buildCompanyNamePool(random) {
  const pool = new Set();
  for (const form of LEGAL_FORMS) {
    for (const prefix of NAME_PREFIXES) {
      for (const tail of NAME_TAILS) pool.add(`${form} «${prefix}${tail}»`);
    }
    for (const geo of GEO_PREFIXES) {
      for (const tail of GEO_TAILS) pool.add(`${form} «${geo}${tail}»`);
    }
  }
  for (const kind of COMPANY_KINDS) {
    for (const brand of COMPANY_BRANDS) pool.add(`${kind} «${brand}»`);
  }
  return random.shuffle([...pool]);
}

function dealTitle(random) {
  const object = random.pick(OBJECT_TYPES);
  const work = random.pick(WORK_TYPES);
  const city = random.pick(CITIES);
  const area = random.int(6, 84) * 100;
  // Часть потребностей описывается площадью объекта, часть — только видом работ:
  // в реальной CRM менеджеры заполняют название по-разному.
  return random.chance(0.55)
    ? `${object} ${area} м², ${city} — ${work}`
    : `${object}, ${city} — ${work}`;
}

/* ------------------------------------------------------------------------- *
 * РАЗДЕЛ 6. СБОРКА СНИМКА.
 * ------------------------------------------------------------------------- */

function iso(ms) {
  return new Date(ms).toISOString();
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Момент внутри окна [fromMs, toMs] на рабочем дне портала — тот же календарь и те
// же рабочие часы (9:00–18:00), которыми ходит createWalk, но без движения курсора:
// звонки не двигают этапы, поэтому им не нужен общий с ними walk.
function randomMomentInWindow(random, calendar, timeZone, fromMs, toMs) {
  const lowMs = Math.min(fromMs, toMs);
  const highMs = Math.max(fromMs, toMs);
  const candidates = calendar.filter((dayStart) => dayStart >= lowMs - DAY_MS && dayStart <= highMs);
  const dayStart = candidates.length > 0 ? random.pick(candidates) : startOfLocalDay(lowMs, timeZone);
  const ms = dayStart + random.int(WORK_HOUR_FROM, WORK_HOUR_TO - 1) * HOUR_MS + random.int(0, 59) * MINUTE_MS;
  return clamp(ms, lowMs, highMs);
}

function pushCall(calls, random, sequence, { companyId, dealId, at }) {
  const short = random.chance(0.62);
  const durationMinutes = short ? random.int(1, 6) : random.int(7, 42);
  calls.push({
    id: String(9000 + sequence),
    companyId,
    dealId: dealId ?? null,
    at: iso(at),
    durationMinutes,
    success: random.chance(CALL_SUCCESS_RATE)
  });
}

function weightPairs(items) {
  return items.map((item) => [item.id, item.weight]);
}

// Ответственный на заданный момент: последняя запись истории, не позже момента.
// Той же логикой пользуется расчётный модуль при атрибуции этапа (инвариант 7).
function managerAt(history, ms) {
  let managerId = history.length > 0 ? history[0].managerId : null;
  for (const record of history) {
    if (record.ms > ms) break;
    managerId = record.managerId;
  }
  return managerId;
}

/**
 * Демонстрационный снимок в форме `EMPTY_CACHE` (см. `src/storage/jsonStore.js`).
 *
 * @param {object}        options
 * @param {number|string} options.seed            зерно ГПСЧ; одно зерно — один снимок
 * @param {Date|string}   options.now             момент «сейчас»; инъектируется ради детерминизма
 * @param {string}        options.portalTimezone  часовой пояс портала для границ суток
 *                                                (синоним `timeZone` — так его зовёт адаптер источника)
 * @param {number}        options.companyCount    сколько компаний создать
 * @param {number}        options.historyDays     глубина истории в календарных днях
 * @returns {object} снимок, готовый к записи в стор
 */
export function generateDemoSnapshot(options = {}) {
  const seed = options.seed ?? config.demoSeed;
  const nowDate = dateOrNull(options.now) ?? new Date();
  // Зона приходит под двумя именами: `portalTimezone` — как в снимке, `timeZone` — как
  // в адаптере источника. Принимаем оба: молча проигнорированная зона дала бы границы
  // суток чужого пояса, и разъехалось бы всё, что считается по календарю.
  const timeZone = options.portalTimezone || options.timeZone || config.portalTimezone;
  const companyCount = Math.max(1, Math.trunc(options.companyCount ?? DEMO_COMPANY_COUNT));
  const historyDays = Math.max(30, Math.trunc(options.historyDays ?? DEMO_HISTORY_DAYS));

  const nowMs = nowDate.getTime();
  const random = createRandom(seed);
  // Отдельный поток для звонков: домен новый и не должен сдвигать последовательность
  // `random`, которая определяет форму воронок (глубину пути, откаты, отказы) —
  // иначе включение/исключение звонков молча меняло бы уже проверенную статистику
  // конверсий компаний и сделок, хотя звонки её не касаются.
  const callsRandom = createRandom(`${seed}::calls`);
  const calendar = businessCalendar(nowMs - historyDays * DAY_MS, nowMs, timeZone);

  const companyStages = FUNNELS.companies.stages;
  const dealStages = FUNNELS.deals.stages;
  const companyServiceStageId = SERVICE_STAGE_IDS.companies[0];
  const dealServiceStageId = SERVICE_STAGE_IDS.deals[0];
  const lostStageIds = LOST_STAGE_IDS.deals;

  const companies = [];
  const deals = [];
  const companyStageEvents = [];
  const dealStageEvents = [];
  const assigneeEvents = [];
  const calls = [];

  const names = buildCompanyNamePool(random);
  const managerPairs = weightPairs(MANAGERS);
  const sourcePairs = weightPairs(SOURCES);
  const kevPairs = weightPairs(KEV_FORMATS);

  let dealSequence = 0;
  let callSequence = 0;

  for (let index = 0; index < companyCount; index += 1) {
    // Якорь когорты — день перехода «Взят в работу». Компании раскладываются по всему
    // окну равномерно, поэтому непустыми оказываются и неделя, и месяц, и квартал, и год.
    const anchorDay = clamp(
      Math.floor(((index + 0.5) * calendar.length) / companyCount) + random.int(-3, 3),
      0,
      calendar.length - 1
    );

    // Глубина пути компании: на каждом переходе часть компаний отсеивается.
    let plannedDepth = 0;
    while (plannedDepth < COMPANY_PASS_RATES.length && random.chance(COMPANY_PASS_RATES[plannedDepth])) {
      plannedDepth += 1;
    }

    const companyId = String(1000 + index);
    const createdDayIndex = Math.max(0, anchorDay - random.int(0, 8));
    const walk = createWalk({ calendar, random, nowMs, startDayIndex: createdDayIndex });

    const events = [];
    // Окно истории кончилось прямо на этой компании (последний день уже прожит):
    // не заводим её вовсе, вместо того чтобы ставить событие задним числом.
    const firstMs = walk.here();
    if (firstMs === null) continue;

    // Часть компаний заведена служебной стадией «создана»: стадия существует в портале,
    // но этапом воронки не является и в математику попадать не должна.
    let createdAtMs = firstMs;
    if (random.chance(RATES.companyServiceStage)) {
      createdAtMs = firstMs - random.int(1, 3) * HOUR_MS;
      events.push({ index: -1, stageId: companyServiceStageId, ms: createdAtMs });
    }
    events.push({ index: 0, stageId: companyStages[0].id, ms: firstMs });

    for (let stage = 1; stage <= plannedDepth; stage += 1) {
      const [minGap, maxGap] = stage === 1
        ? [anchorDay - walk.dayIndex(), anchorDay - walk.dayIndex()]
        : COMPANY_STAGE_GAPS[stage - 1];
      const ms = walk.after(minGap, maxGap);
      if (ms === null) break; // путь ещё не пройден: компания в работе прямо сейчас
      // Пропущенный этап: менеджер отметил только более поздний. Расчёт обязан докрасить.
      // «Взят в работу» не пропускается никогда — на этом событии строится когорта Статики.
      const skipped = stage !== 1 && stage !== plannedDepth && random.chance(RATES.companySkippedStage);
      if (!skipped) events.push({ index: stage, stageId: companyStages[stage].id, ms });
    }

    const positives = events.filter((event) => event.index >= 0);
    const reachedIndex = positives[positives.length - 1].index;
    const junctionEvent = events.find((event) => event.index === companyStages.length - 1) ?? null;
    const junctionDayIndex = walk.dayIndex();

    // Откат компании. История достигнутых этапов остаётся в снимке целиком:
    // расчёт обязан брать исторический максимум, а не текущую стадию (инвариант 3).
    if (reachedIndex >= 3 && random.chance(RATES.companyRollback)) {
      const backIndex = Math.max(1, reachedIndex - random.int(1, 2));
      const backMs = walk.after(3, 14);
      if (backMs !== null) {
        events.push({ index: backIndex, stageId: companyStages[backIndex].id, ms: backMs });
        // Часть откатившихся компаний снова доходит до прежнего этапа: повторное
        // прохождение обязано считаться один раз, а не создавать дубль (инвариант 6).
        if (random.chance(RATES.companyRollbackRecovery)) {
          const forwardMs = walk.after(2, 6);
          if (forwardMs !== null) {
            events.push({ index: reachedIndex, stageId: companyStages[reachedIndex].id, ms: forwardMs });
          }
        }
      }
    }

    const lastEvent = events[events.length - 1];
    const sourceId = random.chance(RATES.companyWithoutSource) ? null : random.weighted(sourcePairs);

    // История ответственных. Первый ответственный назначается при создании,
    // передача — строго между двумя событиями, чтобы этапы «до» и «после»
    // относились к разным менеджерам (инвариант 7).
    const assigneeHistory = [{ managerId: random.weighted(managerPairs), ms: createdAtMs }];
    if (events.length >= 3 && random.chance(RATES.companyHandover)) {
      const cut = random.int(1, events.length - 1);
      const before = events[cut - 1].ms;
      const after = events[cut].ms;
      if (after - before > 2 * HOUR_MS) {
        const next = random.pick(MANAGERS.filter((manager) => manager.id !== assigneeHistory[0].managerId));
        assigneeHistory.push({ managerId: next.id, ms: before + Math.floor((after - before) / 2) });
      }
    }

    companies.push({
      id: companyId,
      title: names[index % names.length],
      sourceId,
      currentStageId: lastEvent.stageId,
      assignedById: assigneeHistory[assigneeHistory.length - 1].managerId,
      createdAt: iso(createdAtMs)
    });
    for (const event of events) {
      companyStageEvents.push({ companyId, stageId: event.stageId, at: iso(event.ms) });
    }
    for (const record of assigneeHistory) {
      assigneeEvents.push({ entityType: 'company', entityId: companyId, managerId: record.managerId, at: iso(record.ms) });
    }

    // Прозвон компании до появления сделки: окно от заведения до перехода на стык
    // (или до «сейчас», если компания ещё в работе) — звонок без сделки этого не ждёт.
    const prospectWindowEnd = junctionEvent ? junctionEvent.ms : Math.min(nowMs, lastEvent.ms + 14 * DAY_MS);
    if (prospectWindowEnd > createdAtMs) {
      const prospectCalls = callsRandom.weighted(COMPANY_CALL_COUNTS);
      for (let call = 0; call < prospectCalls; call += 1) {
        callSequence += 1;
        pushCall(calls, callsRandom, callSequence, {
          companyId,
          dealId: null,
          at: randomMomentInWindow(callsRandom, calendar, timeZone, createdAtMs, prospectWindowEnd)
        });
      }
    }

    if (!junctionEvent) continue;

    // ── Вторая воронка: каждая потребность компании даёт отдельную сделку ──
    const needCount = random.weighted(NEEDS_PER_COMPANY);
    for (let need = 0; need < needCount; need += 1) {
      // Вторая и последующие потребности той же компании появляются позже первой:
      // новый объект приходит к уже знакомому подрядчику через несколько недель.
      const startDay = junctionDayIndex + (need === 0 ? random.int(0, 3) : random.int(8, 60));
      if (startDay >= calendar.length) break;

      const dealWalk = createWalk({
        calendar,
        random,
        nowMs,
        startDayIndex: startDay,
        notBefore: junctionEvent.ms
      });
      let openedMs = dealWalk.here();
      if (openedMs === null) {
        // Потребность выявлена только что: сделка заводится сразу вслед за событием компании.
        const fallback = Math.min(nowMs, junctionEvent.ms + 45 * MINUTE_MS);
        if (fallback <= junctionEvent.ms) break;
        openedMs = fallback;
      }

      dealSequence += 1;
      const dealId = String(5000 + dealSequence);
      const dealEvents = [];
      let dealCreatedAtMs = openedMs;
      if (random.chance(RATES.dealServiceStage) && openedMs - junctionEvent.ms > 20 * HOUR_MS) {
        dealCreatedAtMs = openedMs - random.int(1, 3) * HOUR_MS;
        dealEvents.push({ index: -1, stageId: dealServiceStageId, ms: dealCreatedAtMs });
      }
      dealEvents.push({ index: 0, stageId: dealStages[0].id, ms: openedMs });

      let plannedDealDepth = 0;
      while (plannedDealDepth < DEAL_PASS_RATES.length && random.chance(DEAL_PASS_RATES[plannedDealDepth])) {
        plannedDealDepth += 1;
      }

      let truncated = false;
      for (let stage = 1; stage <= plannedDealDepth; stage += 1) {
        const [minGap, maxGap] = DEAL_STAGE_GAPS[stage - 1];
        const ms = dealWalk.after(minGap, maxGap);
        if (ms === null) {
          truncated = true;
          break;
        }
        // Точка соединения не пропускается: на ней стоит двойной счётчик воронок.
        const skipped = stage !== plannedDealDepth && random.chance(RATES.dealSkippedStage);
        if (!skipped) dealEvents.push({ index: stage, stageId: dealStages[stage].id, ms });
      }

      const dealPositives = dealEvents.filter((event) => event.index >= 0);
      const dealReached = dealPositives[dealPositives.length - 1].index;
      const commercialIndex = dealStages.length - 2; // «Аванс получен»
      let isLost = false;

      if (!truncated && dealReached < commercialIndex && random.chance(RATES.dealLost)) {
        // Отказ. Положительный путь до отказа остаётся в истории: проигранная сделка
        // сохраняет достигнутые этапы (инвариант 5), а её текущая стадия лежит вне воронки.
        const lostMs = dealWalk.after(2, 12);
        if (lostMs !== null) {
          const lostStageId = random.chance(0.78) ? lostStageIds[0] : lostStageIds[1];
          dealEvents.push({ index: -1, stageId: lostStageId, ms: lostMs });
          isLost = true;
        }
      } else if (!truncated && dealReached >= 2 && dealReached < dealStages.length - 1 && random.chance(RATES.dealRollback)) {
        // Откат активной сделки: глубина обязана обрезаться текущей стадией (инвариант 4).
        const backIndex = Math.max(0, dealReached - random.int(1, 2));
        const backMs = dealWalk.after(3, 14);
        if (backMs !== null) {
          dealEvents.push({ index: backIndex, stageId: dealStages[backIndex].id, ms: backMs });
          // Часть откатившихся сделок снова продвигается — повторное прохождение
          // того же этапа не должно дать дубль в расчёте.
          if (random.chance(RATES.dealRollbackRecovery)) {
            const forwardMs = dealWalk.after(2, 6);
            if (forwardMs !== null) {
              dealEvents.push({ index: dealReached, stageId: dealStages[dealReached].id, ms: forwardMs });
            }
          }
        }
      }

      const lastDealEvent = dealEvents[dealEvents.length - 1];
      // Источник переносится из компании автоматизацией портала; часть сделок
      // остаётся без него — такие записи попадают в «Источник не указан».
      const dealSourceId = sourceId === null || random.chance(RATES.dealSourceLost) ? null : sourceId;
      const kevFormatId = random.chance(RATES.dealWithoutKev) ? null : random.weighted(kevPairs);

      const dealAssignees = [{ managerId: managerAt(assigneeHistory, dealCreatedAtMs), ms: dealCreatedAtMs }];
      if (dealEvents.length >= 3 && random.chance(RATES.dealHandover)) {
        const cut = random.int(1, dealEvents.length - 1);
        const before = dealEvents[cut - 1].ms;
        const after = dealEvents[cut].ms;
        if (after - before > 2 * HOUR_MS) {
          const next = random.pick(MANAGERS.filter((manager) => manager.id !== dealAssignees[0].managerId));
          dealAssignees.push({ managerId: next.id, ms: before + Math.floor((after - before) / 2) });
        }
      }

      deals.push({
        id: dealId,
        companyId,
        title: dealTitle(random),
        sourceId: dealSourceId,
        kevFormatId,
        currentStageId: lastDealEvent.stageId,
        assignedById: dealAssignees[dealAssignees.length - 1].managerId,
        createdAt: iso(dealCreatedAtMs),
        isLost
      });
      for (const event of dealEvents) {
        dealStageEvents.push({ dealId, stageId: event.stageId, at: iso(event.ms) });
      }
      for (const record of dealAssignees) {
        assigneeEvents.push({ entityType: 'deal', entityId: dealId, managerId: record.managerId, at: iso(record.ms) });
      }

      // Звонки по сделке — по всему её пути, от заведения до последнего известного события.
      const dealCallCount = callsRandom.weighted(DEAL_CALL_COUNTS);
      for (let call = 0; call < dealCallCount; call += 1) {
        callSequence += 1;
        pushCall(calls, callsRandom, callSequence, {
          companyId,
          dealId,
          at: randomMomentInWindow(callsRandom, calendar, timeZone, dealCreatedAtMs, lastDealEvent.ms)
        });
      }
    }
  }

  // Сортировка истории по времени. Ключи-«хвосты» нужны, чтобы порядок был полным:
  // при совпадении момента снимок обязан быть побайтово одинаковым от запуска к запуску.
  companyStageEvents.sort((a, b) => a.at.localeCompare(b.at) || a.companyId.localeCompare(b.companyId) || a.stageId.localeCompare(b.stageId));
  dealStageEvents.sort((a, b) => a.at.localeCompare(b.at) || a.dealId.localeCompare(b.dealId) || a.stageId.localeCompare(b.stageId));
  assigneeEvents.sort(
    (a, b) => a.at.localeCompare(b.at) || a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId)
  );
  calls.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  // Качество данных считается ПО ФАКТУ собранного снимка, а не по задуманным вероятностям:
  // иначе предупреждение в интерфейсе разошлось бы с содержимым выборки.
  const companiesWithoutSource = companies.filter((company) => !company.sourceId).length;
  const dealsWithoutSource = deals.filter((deal) => !deal.sourceId).length;
  const dealsWithoutKev = deals.filter((deal) => !deal.kevFormatId).length;
  const companyIds = new Set(companies.map((company) => company.id));
  const dealsWithoutCompany = deals.filter((deal) => !companyIds.has(deal.companyId)).length;

  const snapshot = emptySnapshot();
  snapshot.updatedAt = iso(nowMs);
  snapshot.source = DEMO_SOURCE_ID;
  snapshot.portalTimezone = timeZone;
  snapshot.companies = companies;
  snapshot.deals = deals;
  snapshot.companyStageEvents = companyStageEvents;
  snapshot.dealStageEvents = dealStageEvents;
  snapshot.assigneeEvents = assigneeEvents;
  snapshot.calls = calls;
  snapshot.managers = MANAGERS.map((manager) => ({ id: manager.id, name: manager.name }));
  snapshot.sources = SOURCES.map((source) => ({ id: source.id, name: source.name }));
  snapshot.kevFormats = KEV_FORMATS.map((format) => ({ id: format.id, name: format.name }));
  snapshot.stages = {
    companies: [
      ...companyStages.map((stage) => ({ id: stage.id, name: stage.name })),
      ...SERVICE_STAGE_IDS.companies.map((id) => ({ id, name: SERVICE_STAGE_NAMES[id] ?? 'Служебная стадия' })),
      ...LOST_STAGE_IDS.companies.map((id) => ({ id, name: LOST_STAGE_NAMES[id] ?? 'Отказ' }))
    ],
    deals: [
      ...dealStages.map((stage) => ({ id: stage.id, name: stage.name })),
      ...SERVICE_STAGE_IDS.deals.map((id) => ({ id, name: SERVICE_STAGE_NAMES[id] ?? 'Служебная стадия' })),
      ...LOST_STAGE_IDS.deals.map((id) => ({ id, name: LOST_STAGE_NAMES[id] ?? 'Отказ' }))
    ]
  };
  snapshot.sync = {
    status: 'success',
    lastStartedAt: iso(nowMs - 4 * 1000),
    lastSuccessAt: iso(nowMs),
    lastError: null,
    // Не сюда: src/sync/service.js полностью заменяет этот объект целиком при сохранении
    // (см. store.save() в performSync) — что бы здесь ни лежало, оно никогда не долетает
    // до диска. Предупреждение генератора — ниже, в верхнеуровневом `warnings`, откуда
    // service.js его действительно читает (та же форма, что и у src/bitrix/fullSync.js).
    warnings: []
  };
  snapshot.dataQuality = {
    companiesWithoutSource,
    dealsWithoutSource,
    dealsWithoutKev,
    dealsWithoutCompany,
    assigneeHistoryAvailable: true,
    // Та же форма {code, message}, что и у верхнеуровневого warnings (см. ниже) — единый
    // контракт между демо- и bitrix-источниками, а не только внутри одного из них.
    warnings: [
      { code: 'SOURCE_MISSING', message: `Без базы/источника: компаний ${companiesWithoutSource}, сделок ${dealsWithoutSource} — попадут в «Источник не указан».` },
      { code: 'KEV_MISSING', message: `Без формата КЭВ: сделок ${dealsWithoutKev} — попадут в «Не указано».` }
    ]
  };
  // Верхнеуровневое поле: src/sync/service.js читает ИМЕННО его (fetched.warnings),
  // не sync.warnings, чтобы построить статус синхронизации — та же форма контракта,
  // что и у src/bitrix/fullSync.js ({code, message}, а не голая строка).
  snapshot.warnings = [
    { code: 'DEMO_DATA', message: 'Снимок собран генератором демо-данных: портал Битрикс24 ещё не подключён.' }
  ];
  return snapshot;
}
