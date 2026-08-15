import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ROOT_DIR, config } from '../config.js';

const EMPTY_CACHE = {
  version: 1,
  updatedAt: null,
  sourceField: null,
  sync: {
    status: 'idle',
    lastStartedAt: null,
    lastSuccessAt: null,
    lastError: null,
    warnings: []
  },
  historySync: {
    syncedDealIds: [],
    lastBatchAt: null,
    complete: false
  },
  deals: [],
  stageEvents: [],
  managers: [],
  sources: [],
  // Справочник стадий категории 78 (id→name) — чтобы код знал имена стадий вне STAGES (C78:NEW и др.).
  stages: [],
  // Списки значений enum-полей для фильтров (В2-В4): { objectType:[...], need:[...], projectRole:[...], turnover:[...], clientType:[...] }.
  enumDictionaries: {}
};

// Чтение кэша с различением «файла нет» и «файл битый/недоступен».
// ENOENT — норма (первый старт / пустой persistent-том) → тихий null.
// Прочее (битый JSON, EACCES) → лог в диагностику. Для целевого файла (quarantine=true)
// битый файл уводим в *.corrupt: сохраняем улику и НЕ даём следующему save() затереть её вслепую.
async function readCacheFile(path, { quarantine = false } = {}) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error(`jsonStore: не удалось прочитать кэш ${path}: ${err.code || err.message}`);
    return null;
  }
  try {
    return { ...EMPTY_CACHE, ...JSON.parse(raw) };
  } catch (err) {
    console.error(`jsonStore: кэш повреждён ${path}: ${err.message}`);
    if (quarantine) {
      const corruptPath = `${path}.corrupt`;
      try {
        await rename(path, corruptPath);
        console.error(`jsonStore: битый кэш перемещён в ${corruptPath}`);
      } catch (mvErr) {
        console.error(`jsonStore: не удалось изолировать битый кэш: ${mvErr.code || mvErr.message}`);
      }
    }
    return null;
  }
}

export class JsonStore {
  // ВАЖНО: абсолютный путь (persistent-том прода, напр. /opt/app-data) НЕ вкладываем в ROOT_DIR —
  // path.join('/opt/app', '/opt/app-data/x') дал бы '/opt/app/opt/app-data/x' и кэш стирался бы
  // при cleanDeploy. isAbsolute сохраняет абсолютный путь как есть (как и остальные сторы).
  constructor(file = config.cacheFile) {
    this.file = isAbsolute(file) ? file : join(ROOT_DIR, file);
    // Бандл-снапшот из архива — источник для seed'а, если persistent-кэш пуст/отсутствует.
    this.seedFile = join(ROOT_DIR, 'data/bi-cache.json');
    this.cache = null;
  }

  async load() {
    if (this.cache) return this.cache;
    this.cache = (await readCacheFile(this.file, { quarantine: true })) || structuredClone(EMPTY_CACHE);
    // Seed из бандла, когда persistent-кэш пуст (файла нет ИЛИ 0 сделок), а бандл непустой.
    // Непустой persistent-кэш бандлом не перезатираем.
    if (!this.cache.deals?.length && this.seedFile !== this.file) {
      const seed = await readCacheFile(this.seedFile);
      if (seed?.deals?.length) this.cache = seed;
    }
    return this.cache;
  }

  async save(data = this.cache) {
    this.cache = { ...EMPTY_CACHE, ...data, updatedAt: new Date().toISOString() };
    await mkdir(dirname(this.file), { recursive: true });
    // Атомарная запись: сначала во временный файл В ТОМ ЖЕ каталоге, потом rename поверх целевого.
    // rename атомарен только в пределах одной ФС, поэтому tmp лежит рядом с this.file.
    // Сбой/SIGTERM в момент writeFile портит только *.tmp — целевой bi-cache.json остаётся целым.
    const tmp = `${this.file}.tmp`;
    await rm(tmp, { force: true });
    await writeFile(tmp, `${JSON.stringify(this.cache, null, 2)}\n`);
    await rename(tmp, this.file);
    return this.cache;
  }

  async getSnapshot() {
    return this.load();
  }

  async replaceSnapshot(partial) {
    const current = await this.load();
    return this.save({ ...current, ...partial });
  }

  // Факт наличия и размер файла кэша для health-диагностики (без чтения содержимого).
  async cacheInfo() {
    try {
      const s = await stat(this.file);
      return { exists: true, sizeBytes: s.size };
    } catch {
      return { exists: false, sizeBytes: 0 };
    }
  }

  async updateSync(patch) {
    const current = await this.load();
    current.sync = { ...current.sync, ...patch };
    return this.save(current);
  }
}

export const store = new JsonStore();
