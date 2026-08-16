/**
 * Хранилище сотрудников и сессий.
 *
 * ОТДЕЛЬНЫЙ файл, а не раздел снимка — и это принципиально: снимок
 * (`data/snapshot.json`) целиком ЗАМЕНЯЕТСЯ при каждой успешной синхронизации,
 * поэтому сотрудники, положенные туда, стирались бы каждые десять минут вместе
 * с данными портала.
 *
 * Запись — тем же `writeAtomic`, что и снимок: временный файл рядом плюс rename
 * поверх, с повтором на транзиентную блокировку Windows. Второй, менее
 * проверенный способ записи заводить незачем — этот уже пережил реальный баг
 * с EPERM на живом сервере.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ROOT_DIR, config } from '../config.js';
import { writeAtomic } from '../storage/jsonStore.js';
import { generateToken } from './passwords.js';

export const ROLES = Object.freeze({ admin: 'admin', employee: 'employee' });

/** Сколько живёт сессия без повторного входа. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const EMPTY = Object.freeze({ version: 1, users: [], sessions: [] });

function resolvePath(file) {
  // Абсолютный путь (постоянный том) используется как есть и НЕ вкладывается
  // в корень проекта: join('/opt/dash', '/data/users.json') дал бы
  // '/opt/dash/data/users.json' и потерял бы том при переустановке.
  return isAbsolute(file) ? file : join(ROOT_DIR, file);
}

/** Запись сотрудника в виде, пригодном для отдачи наружу: БЕЗ хеша пароля. */
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    role: user.role,
    active: user.active !== false,
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null
  };
}

/** Логин приводится к единому виду: регистр и пробелы не должны плодить двойников. */
export function normalizeLogin(login) {
  return String(login ?? '').trim().toLowerCase();
}

/** Проверка логина. Возвращает текст проблемы или null. */
export function loginProblem(login) {
  const value = normalizeLogin(login);
  if (value.length === 0) return 'Логин не может быть пустым';
  if (value.length < 3) return 'Логин должен быть не короче 3 символов';
  if (value.length > 64) return 'Логин не может быть длиннее 64 символов';
  if (!/^[a-z0-9._-]+$/.test(value)) {
    return 'В логине допустимы только латинские буквы, цифры, точка, дефис и подчёркивание';
  }
  return null;
}

export class UserStore {
  constructor(file = config.usersFile) {
    this.file = resolvePath(file);
    this.cache = null;
    this.loading = null;
    this.writeQueue = Promise.resolve();
  }

  async load() {
    if (this.cache) return this.cache;
    if (!this.loading) {
      this.loading = readFile(this.file, 'utf8')
        .then((text) => JSON.parse(text))
        .then((data) => (data && typeof data === 'object' ? { ...EMPTY, ...data } : structuredClone(EMPTY)))
        .catch((error) => {
          // Файла нет — штатная ситуация первого запуска, а не ошибка.
          if (error.code !== 'ENOENT') {
            console.error(`[userStore] не удалось прочитать ${this.file}: ${error.code || error.message}`);
          }
          return structuredClone(EMPTY);
        })
        .then((data) => {
          this.cache = data;
          return data;
        })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async save(data) {
    const task = this.writeQueue.catch(() => {}).then(async () => {
      await writeAtomic(this.file, data);
      this.cache = data;
      return data;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  /** Есть ли хотя бы один администратор: от этого зависит экран первого запуска. */
  async needsSetup() {
    const data = await this.load();
    return !data.users.some((user) => user.role === ROLES.admin && user.active !== false);
  }

  async listUsers() {
    const data = await this.load();
    return data.users.map(publicUser);
  }

  async findByLogin(login) {
    const data = await this.load();
    const target = normalizeLogin(login);
    return data.users.find((user) => normalizeLogin(user.login) === target) ?? null;
  }

  async findById(id) {
    const data = await this.load();
    return data.users.find((user) => user.id === id) ?? null;
  }

  /**
   * Добавление сотрудника. Хеш пароля приходит уже готовым — этот модуль
   * открытого пароля не видит вовсе.
   */
  async addUser({ login, name, passwordHash, role = ROLES.employee }) {
    const data = await this.load();
    const normalized = normalizeLogin(login);
    if (data.users.some((user) => normalizeLogin(user.login) === normalized)) {
      const error = new Error('Сотрудник с таким логином уже есть');
      error.code = 'LOGIN_TAKEN';
      error.status = 409;
      throw error;
    }
    const user = {
      id: generateToken().slice(0, 16),
      login: normalized,
      name: String(name ?? '').trim() || normalized,
      passwordHash,
      role: role === ROLES.admin ? ROLES.admin : ROLES.employee,
      active: true,
      createdAt: new Date().toISOString(),
      lastLoginAt: null,
      // Место под будущий вход через Битрикс: когда появится доступ к порталу,
      // SSO станет ещё одним способом завести сессию, а не переделкой хранилища.
      bitrixUserId: null
    };
    await this.save({ ...data, users: [...data.users, user] });
    return publicUser(user);
  }

  /** Изменение сотрудника. `patch` может нести name, role, active, passwordHash. */
  async updateUser(id, patch) {
    const data = await this.load();
    const index = data.users.findIndex((user) => user.id === id);
    if (index < 0) {
      const error = new Error('Сотрудник не найден');
      error.code = 'USER_NOT_FOUND';
      error.status = 404;
      throw error;
    }

    const current = data.users[index];
    const next = { ...current };
    if (patch.name !== undefined) next.name = String(patch.name).trim() || current.login;
    if (patch.role !== undefined) next.role = patch.role === ROLES.admin ? ROLES.admin : ROLES.employee;
    if (patch.active !== undefined) next.active = patch.active !== false;
    if (patch.passwordHash !== undefined) next.passwordHash = patch.passwordHash;

    await this.assertNotLastAdmin(data, current, next);

    const users = [...data.users];
    users[index] = next;
    // Отключённый или разжалованный сотрудник обязан потерять активные сессии
    // немедленно, а не доживать до истечения срока.
    const revoked = (next.active === false || next.role !== current.role)
      ? data.sessions.filter((session) => session.userId !== id)
      : data.sessions;
    await this.save({ ...data, users, sessions: revoked });
    return publicUser(next);
  }

  async deleteUser(id) {
    const data = await this.load();
    const user = data.users.find((item) => item.id === id);
    if (!user) {
      const error = new Error('Сотрудник не найден');
      error.code = 'USER_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    await this.assertNotLastAdmin(data, user, { ...user, active: false, role: ROLES.employee });
    await this.save({
      ...data,
      users: data.users.filter((item) => item.id !== id),
      sessions: data.sessions.filter((session) => session.userId !== id)
    });
    return true;
  }

  /**
   * Защита от блокировки самих себя: последнего действующего администратора
   * нельзя ни удалить, ни отключить, ни разжаловать. Иначе управлять доступом
   * станет некому, и починить это можно будет только правкой файла на сервере.
   */
  async assertNotLastAdmin(data, current, next) {
    const wasAdmin = current.role === ROLES.admin && current.active !== false;
    const staysAdmin = next.role === ROLES.admin && next.active !== false;
    if (!wasAdmin || staysAdmin) return;
    const otherAdmins = data.users.filter(
      (user) => user.id !== current.id && user.role === ROLES.admin && user.active !== false
    );
    if (otherAdmins.length === 0) {
      const error = new Error('Это последний администратор — сначала назначьте другого');
      error.code = 'LAST_ADMIN';
      error.status = 409;
      throw error;
    }
  }

  // ── Сессии ────────────────────────────────────────────────────────────────

  async createSession(userId, { now = Date.now() } = {}) {
    const data = await this.load();
    const token = generateToken();
    const session = { token, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
    const users = data.users.map((user) => (
      user.id === userId ? { ...user, lastLoginAt: new Date(now).toISOString() } : user
    ));
    // Истёкшие чистим при каждом входе: отдельная уборка по таймеру не нужна,
    // а список не растёт бесконечно.
    const alive = data.sessions.filter((item) => item.expiresAt > now);
    await this.save({ ...data, users, sessions: [...alive, session] });
    return session;
  }

  /** Сотрудник по токену сессии или null. Истёкшая сессия равносильна её отсутствию. */
  async userBySession(token, { now = Date.now() } = {}) {
    if (!token) return null;
    const data = await this.load();
    const session = data.sessions.find((item) => item.token === token);
    if (!session || session.expiresAt <= now) return null;
    const user = data.users.find((item) => item.id === session.userId);
    if (!user || user.active === false) return null;
    return user;
  }

  async destroySession(token) {
    if (!token) return;
    const data = await this.load();
    if (!data.sessions.some((item) => item.token === token)) return;
    await this.save({ ...data, sessions: data.sessions.filter((item) => item.token !== token) });
  }
}

export const userStore = new UserStore();
