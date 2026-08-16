// Атомарный JSON-стор аналитического снимка.
//
// Снимок — единственный источник данных для расчётного модуля: HTTP-запросы пользователя
// читают его, а не ходят в Битрикс. Отсюда два требования, которым подчинён весь файл:
// снимок нельзя порвать записью (падение процесса посреди write не должно оставить огрызок)
// и нельзя молча потерять (битый файл сохраняется как улика, а не затирается).
import { access, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ROOT_DIR, config } from '../config.js';

export const SNAPSHOT_VERSION = 1;

// Форма снимка. Задана здесь один раз и подмешивается при каждом чтении и записи,
// поэтому добавление нового раздела не требует миграции: старые файлы дочитываются
// с дефолтами, а не падают на отсутствующем ключе.
//
// Поля внутри записей — ожидаемая форма (её окончательно фиксируют тикеты 04 и 14);
// контрактом стора является набор ключей верхнего уровня.
export const EMPTY_CACHE = {
  // Версия схемы. Растёт, когда форма перестаёт быть обратно совместимой.
  version: SNAPSHOT_VERSION,
  // Момент записи файла (ISO). Проставляет сам стор.
  updatedAt: null,
  // Чем наполнен снимок: 'demo' | 'bitrix' | null у пустого.
  source: null,
  // Часовой пояс портала на момент получения данных — в нём считаются границы периодов.
  portalTimezone: null,

  // ── Сущности двух воронок ──
  // { id, title, sourceId, currentStageId, assignedById, createdAt }
  companies: [],
  // { id, companyId, title, sourceId, kevFormatId, currentStageId, assignedById, createdAt, isLost }
  deals: [],

  // ── История: на ней держатся откаты, докраска пропущенных этапов и атрибуция менеджера ──
  // { companyId, stageId, at }
  companyStageEvents: [],
  // { dealId, stageId, at }
  dealStageEvents: [],
  // { entityType: 'company' | 'deal', entityId, managerId, at } — кто был ответственным с этого момента
  assigneeEvents: [],
  // Отметка последней успешно полученной истории на сущность: { [id]: updatedAtОпрошенной версии }.
  // Позволяет пропускать перезапрос истории для сущности, которая не менялась с прошлого
  // раза (bitrix/fullSync.js) — без этого каждый заход синхронизации перезапрашивает
  // историю КАЖДОЙ компании и сделки заново, что не масштабируется на реальный портал.
  historySync: { companies: {}, deals: {} },

  // ── Справочники для фильтров и подписей ──
  // { id, name }
  managers: [],
  sources: [],
  kevFormats: [],
  // Технические стадии портала как есть: { id, name }. Порядок и смысл задаёт доменная конфигурация.
  stages: { companies: [], deals: [] },

  // ── Метаданные ──
  sync: {
    status: 'idle', // idle | running | success | error
    lastStartedAt: null,
    lastSuccessAt: null, // не обновляется, пока снимок не получен и не проверен целиком
    lastError: null,
    warnings: []
  },
  // Качество данных портала: не ошибка приложения, но пользователь обязан о нём знать.
  dataQuality: {
    companiesWithoutSource: 0,
    dealsWithoutSource: 0,
    dealsWithoutKev: 0,
    dealsWithoutCompany: 0,
    assigneeHistoryAvailable: null,
    warnings: []
  }
};

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptySnapshot() {
  // Клонируем: иначе массивы эталона оказались бы общими для всех снимков
  // и push в одном месте молча дописал бы данные во все остальные.
  return structuredClone(EMPTY_CACHE);
}

// Подмешивание формы: верхний уровень плюс один уровень вложенных объектов
// (sync, dataQuality, stages). Массивы не сливаются — они заменяются целиком,
// потому что снимок всегда приходит от источника как готовый набор, а не как патч.
export function withDefaults(data) {
  const base = emptySnapshot();
  if (!isPlainObject(data)) return base;
  const merged = { ...base, ...data };
  for (const [key, fallback] of Object.entries(base)) {
    if (!isPlainObject(fallback)) continue;
    merged[key] = isPlainObject(data[key]) ? { ...fallback, ...data[key] } : fallback;
  }
  return merged;
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

// Имя карантина. Вторая порча не должна стирать улику от первой, поэтому берём
// первое свободное имя; после десятка повреждений подряд смысла копить больше нет.
async function quarantinePath(file) {
  const base = `${file}.corrupt`;
  if (!(await exists(base))) return base;
  for (let index = 2; index <= 10; index += 1) {
    const candidate = `${base}.${index}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${base}.10`;
}

// Чтение с различением «файла нет» и «файл битый».
// ENOENT — штатная ситуация (первый старт, пустой том): тихий null.
// Битый JSON уводим в *.corrupt: сохраняем улику и не даём следующей записи затереть её вслепую.
async function readSnapshotFile(path, { quarantine = false } = {}) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    console.error(`[jsonStore] не удалось прочитать снимок ${path}: ${error.code || error.message}`);
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('снимок не является объектом');
    return parsed;
  } catch (error) {
    console.error(`[jsonStore] снимок повреждён ${path}: ${error.message}`);
    if (quarantine) {
      const target = await quarantinePath(path);
      try {
        await rename(path, target);
        console.error(`[jsonStore] битый снимок сохранён как ${target}`);
      } catch (moveError) {
        console.error(`[jsonStore] не удалось изолировать битый снимок: ${moveError.code || moveError.message}`);
      }
    }
    return null;
  }
}

// Счётчик временных файлов: имя уникально в пределах процесса, чтобы две записи
// подряд не подрались за один и тот же .tmp.
let tmpCounter = 0;

const sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

// На Windows rename() поверх существующего файла может на миг упасть с EPERM/EBUSY,
// даже когда ни один хендл в НАШЕМ процессе файл не держит: антивирус, индексатор
// или сама ФС удерживают целевой файл долями секунды сразу после предыдущей записи.
// На POSIX rename атомарен безусловно и такого не бывает — там цикл отработает
// с первой попытки. Пять попыток с растущей паузой достаточно, чтобы пережить
// транзиентную блокировку, но не маскируют настоящую проблему доступа (EACCES
// и всё прочее падает сразу, без единой лишней попытки).
// renameImpl/sleepImpl инъектируются, чтобы проверки могли надёжно воспроизвести
// транзиентную блокировку и исчерпание попыток, не гоняясь за настоящей гонкой
// файловой системы, которая по природе не воспроизводится детерминированно.
export async function renameWithRetry(from, to, { attempts = 5, renameImpl = rename, sleepImpl = sleep } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await renameImpl(from, to);
      return;
    } catch (error) {
      const transient = error.code === 'EPERM' || error.code === 'EBUSY';
      if (!transient || attempt === attempts) throw error;
      await sleepImpl(20 * attempt);
    }
  }
}

// Атомарная запись: временный файл в ТОМ ЖЕ каталоге + rename поверх целевого.
// rename атомарен только внутри одной файловой системы, поэтому tmp лежит рядом с целью.
// Падение процесса на записи портит только tmp — предыдущий снимок остаётся целым и читаемым.
async function writeAtomic(file, payload) {
  // Сериализуем ДО создания временного файла: ошибка сериализации не должна оставлять мусор.
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true });
  tmpCounter += 1;
  const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
  try {
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      // Сбрасываем на диск до rename: иначе после отключения питания rename мог бы
      // открыть новый снимок, содержимое которого ещё не доехало.
      await handle.sync().catch(() => {});
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export class JsonStore {
  // Абсолютный путь (persistent-том вроде /opt/app-data) НЕ вкладываем в ROOT_DIR:
  // join(ROOT_DIR, '/opt/app-data/x') дал бы путь внутри проекта, и снимок стирался бы
  // при каждом чистом деплое.
  constructor(file = config.snapshotFile) {
    this.file = isAbsolute(file) ? file : join(ROOT_DIR, file);
    this.cache = null;
    this.loading = null;
    // Очередь записи: параллельные save не должны переставлять rename местами.
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = readSnapshotFile(this.file, { quarantine: true })
        .then((data) => {
          this.cache = data ? withDefaults(data) : emptySnapshot();
          return this.cache;
        })
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  // Забыть содержимое в памяти и перечитать файл (снимок мог обновить другой процесс).
  async reload() {
    this.cache = null;
    return this.load();
  }

  async getSnapshot() {
    return this.load();
  }

  // now инъектируется, чтобы проверки не зависели от текущего момента.
  async save(data = this.cache, { now = new Date() } = {}) {
    const snapshot = {
      ...withDefaults(data),
      version: SNAPSHOT_VERSION,
      updatedAt: now.toISOString()
    };
    const task = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await writeAtomic(this.file, snapshot);
        // Память обновляем только после успешной записи: иначе после сбоя в памяти
        // висел бы снимок, которого нет на диске.
        this.cache = snapshot;
        return snapshot;
      });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  // Частичное обновление: разделы, которых нет в patch, остаются от последнего успешного снимка.
  async replaceSnapshot(patch, options = {}) {
    const current = await this.load();
    return this.save({ ...current, ...patch }, options);
  }

  // Статус синхронизации меняется отдельно от данных: неудачный заход обязан
  // записать ошибку, не тронув сами компании и сделки.
  async updateSync(patch, options = {}) {
    const current = await this.load();
    return this.save({ ...current, sync: { ...current.sync, ...patch } }, options);
  }

  // Наличие и размер файла для диагностики — без чтения содержимого.
  async snapshotInfo() {
    try {
      const info = await stat(this.file);
      return { exists: true, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() };
    } catch {
      return { exists: false, sizeBytes: 0, modifiedAt: null };
    }
  }
}

export const store = new JsonStore();
