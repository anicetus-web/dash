/**
 * Маршруты входа и управления сотрудниками.
 *
 * Границы ответственности:
 *   - здесь принимаются решения «кто вошёл» и «что ему можно»;
 *   - хеши паролей считаются в `src/auth/passwords.js`, записи хранятся
 *     в `src/auth/userStore.js` — этот файл открытых паролей не хранит и
 *     в ответы их не кладёт, кроме единственного случая: только что созданный
 *     или сброшенный пароль возвращается РОВНО ОДИН РАЗ, чтобы администратор
 *     успел передать его сотруднику. Повторно узнать его нельзя ни через API,
 *     ни из файла — там только хеш.
 */

import { config } from '../config.js';
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from '../auth/passwords.js';
import { ROLES, loginProblem, publicUser } from '../auth/userStore.js';
// Тот же модуль, что подставляет логин в браузере во время набора имени.
// Правила обязаны совпадать до буквы, поэтому файл один на обе стороны,
// а не две копии таблицы, которые однажды разойдутся.
import { loginFromName, uniqueLogin } from '../../public/translit.js';

const COOKIE_NAME = 'dash_session';

/** Разбор заголовка Cookie: нам нужен ровно один ключ, полноценный парсер тут лишний. */
export function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * Куки сессии.
 *
 * HttpOnly — скрипт страницы не должен уметь прочитать токен даже при XSS.
 * SameSite=Lax — браузер не пошлёт куку в межсайтовых POST-запросах, что
 * закрывает CSRF для изменяющих маршрутов. Secure — только когда приложение
 * реально за HTTPS: с ним на голом HTTP кука просто не сохранится, и вход
 * сломался бы при локальной проверке.
 */
function sessionCookie(token, { maxAgeSec, secure }) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Ограничение попыток входа.
 *
 * Без него 200 сотрудников означают 200 известных логинов, по которым можно
 * спокойно перебирать пароли. Счётчик — по паре «логин + адрес», чтобы один
 * подбирающий не заблокировал вход настоящему владельцу логина с другого адреса.
 */
function createLoginLimiter({ maxAttempts = 8, windowMs = 10 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    check(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry || now - entry.first > windowMs) return { blocked: false };
      if (entry.count < maxAttempts) return { blocked: false };
      return { blocked: true, retryAfterSec: Math.ceil((entry.first + windowMs - now) / 1000) };
    },
    fail(key, now = Date.now()) {
      const entry = attempts.get(key);
      if (!entry || now - entry.first > windowMs) attempts.set(key, { count: 1, first: now });
      else entry.count += 1;
      // Уборка на месте: карта не должна расти бесконечно от случайных логинов.
      if (attempts.size > 5000) {
        for (const [k, v] of attempts) if (now - v.first > windowMs) attempts.delete(k);
      }
    },
    succeed(key) {
      attempts.delete(key);
    }
  };
}

/** Адрес клиента с учётом обратного прокси (nginx ставит X-Forwarded-For). */
function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

export function createAuthRoutes({ userStore, sendOk, httpError, readJsonBody }) {
  const limiter = createLoginLimiter();
  const sessionTtlSec = 12 * 60 * 60;

  /** Сотрудник текущего запроса или null. Используется и охраной остальных маршрутов. */
  async function currentUser(req) {
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    return userStore.userBySession(token);
  }

  function requireAdmin(user) {
    if (!user) throw httpError(401, 'UNAUTHORIZED', 'Требуется вход');
    if (user.role !== ROLES.admin) {
      throw httpError(403, 'FORBIDDEN', 'Действие доступно только администратору');
    }
  }

  async function routeAuth(req, res, url) {
    const path = url.pathname;
    const secure = config.cookieSecure;

    // ── Кто я / нужен ли первый запуск ────────────────────────────────────
    if (path === '/api/auth/me' && req.method === 'GET') {
      const user = await currentUser(req);
      sendOk(res, {
        user: publicUser(user),
        needsSetup: await userStore.needsSetup()
      });
      return true;
    }

    // ── Создание первого администратора ───────────────────────────────────
    // Доступно ТОЛЬКО пока администраторов нет вовсе: иначе это был бы
    // открытый маршрут создания администратора для кого угодно.
    if (path === '/api/auth/setup' && req.method === 'POST') {
      if (!(await userStore.needsSetup())) {
        throw httpError(409, 'SETUP_DONE', 'Администратор уже создан');
      }
      const body = await readJsonBody(req);
      const login = String(body.login ?? '');
      const password = String(body.password ?? '');
      const loginIssue = loginProblem(login);
      if (loginIssue) throw httpError(400, 'BAD_LOGIN', loginIssue);
      const passwordIssue = passwordProblem(password);
      if (passwordIssue) throw httpError(400, 'BAD_PASSWORD', passwordIssue);

      const user = await userStore.addUser({
        login,
        name: String(body.name ?? '').trim() || login,
        passwordHash: await hashPassword(password),
        role: ROLES.admin
      });
      const session = await userStore.createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(session.token, { maxAgeSec: sessionTtlSec, secure }));
      sendOk(res, { user });
      return true;
    }

    // ── Вход ──────────────────────────────────────────────────────────────
    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const login = String(body.login ?? '');
      const password = String(body.password ?? '');
      const key = `${login.toLowerCase()}|${clientAddress(req)}`;

      const limit = limiter.check(key);
      if (limit.blocked) {
        res.setHeader('Retry-After', String(limit.retryAfterSec));
        throw httpError(429, 'TOO_MANY_ATTEMPTS',
          `Слишком много попыток входа. Повторите через ${Math.ceil(limit.retryAfterSec / 60)} мин.`);
      }

      const user = await userStore.findByLogin(login);
      // Пароль проверяется ДАЖЕ когда логина нет: иначе несуществующий логин
      // отвечал бы заметно быстрее существующего, и перебором можно было бы
      // выяснить список действующих логинов.
      const stored = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA';
      const ok = await verifyPassword(password, stored);

      if (!user || !ok || user.active === false) {
        limiter.fail(key);
        // Одна и та же формулировка на «нет логина», «неверный пароль» и
        // «отключён»: разные тексты подсказали бы подбирающему, где он угадал.
        throw httpError(401, 'BAD_CREDENTIALS', 'Неверный логин или пароль');
      }

      limiter.succeed(key);
      const session = await userStore.createSession(user.id);
      res.setHeader('Set-Cookie', sessionCookie(session.token, { maxAgeSec: sessionTtlSec, secure }));
      sendOk(res, { user: publicUser(user) });
      return true;
    }

    // ── Выход ─────────────────────────────────────────────────────────────
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const token = readCookie(req.headers.cookie, COOKIE_NAME);
      await userStore.destroySession(token);
      res.setHeader('Set-Cookie', sessionCookie('', { maxAgeSec: 0, secure }));
      sendOk(res, { ok: true });
      return true;
    }

    // ── Смена СВОЕГО пароля ───────────────────────────────────────────────
    if (path === '/api/auth/password' && req.method === 'POST') {
      const user = await currentUser(req);
      if (!user) throw httpError(401, 'UNAUTHORIZED', 'Требуется вход');
      const body = await readJsonBody(req);
      const current = String(body.currentPassword ?? '');
      const next = String(body.newPassword ?? '');
      if (!(await verifyPassword(current, user.passwordHash))) {
        throw httpError(400, 'BAD_CREDENTIALS', 'Текущий пароль указан неверно');
      }
      const issue = passwordProblem(next);
      if (issue) throw httpError(400, 'BAD_PASSWORD', issue);
      await userStore.updateUser(user.id, { passwordHash: await hashPassword(next) });
      sendOk(res, { ok: true });
      return true;
    }

    // ── Список сотрудников ────────────────────────────────────────────────
    if (path === '/api/auth/users' && req.method === 'GET') {
      requireAdmin(await currentUser(req));
      sendOk(res, { users: await userStore.listUsers() });
      return true;
    }

    // ── Добавление сотрудника ─────────────────────────────────────────────
    if (path === '/api/auth/users' && req.method === 'POST') {
      requireAdmin(await currentUser(req));
      const body = await readJsonBody(req);
      const name = String(body.name ?? '').trim();

      // Логин можно не присылать вовсе: тогда он выводится из имени по тем же
      // правилам, что показывал браузер, и при совпадении получает номер
      // (ivanov → ivanov2). Молча отказать однофамильцу хуже, чем предложить
      // свободный логин сразу.
      let login = String(body.login ?? '').trim();
      if (!login) {
        const existing = (await userStore.listUsers()).map((user) => user.login);
        login = uniqueLogin(loginFromName(name), existing);
      }
      const issue = loginProblem(login);
      if (issue) throw httpError(400, 'BAD_LOGIN', issue);

      // Пароль либо задан явно, либо генерируется. Возвращается ОДИН раз.
      const password = String(body.password ?? '') || generatePassword();
      const passwordIssue = passwordProblem(password);
      if (passwordIssue) throw httpError(400, 'BAD_PASSWORD', passwordIssue);

      const user = await userStore.addUser({
        login,
        name,
        passwordHash: await hashPassword(password),
        role: body.role === ROLES.admin ? ROLES.admin : ROLES.employee
      });
      sendOk(res, { user, password });
      return true;
    }

    // ── Изменение и удаление сотрудника ───────────────────────────────────
    const userMatch = path.match(/^\/api\/auth\/users\/([A-Za-z0-9_-]{1,64})$/);
    if (userMatch) {
      requireAdmin(await currentUser(req));
      const id = userMatch[1];

      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.role !== undefined) patch.role = body.role;
        if (body.active !== undefined) patch.active = body.active;
        sendOk(res, { user: await userStore.updateUser(id, patch) });
        return true;
      }

      if (req.method === 'DELETE') {
        await userStore.deleteUser(id);
        sendOk(res, { ok: true });
        return true;
      }
    }

    // ── Сброс пароля сотруднику ───────────────────────────────────────────
    const resetMatch = path.match(/^\/api\/auth\/users\/([A-Za-z0-9_-]{1,64})\/password$/);
    if (resetMatch && req.method === 'POST') {
      requireAdmin(await currentUser(req));
      const body = await readJsonBody(req).catch(() => ({}));
      const password = String(body.password ?? '') || generatePassword();
      const issue = passwordProblem(password);
      if (issue) throw httpError(400, 'BAD_PASSWORD', issue);
      const user = await userStore.updateUser(resetMatch[1], { passwordHash: await hashPassword(password) });
      sendOk(res, { user, password });
      return true;
    }

    return false;
  }

  return { routeAuth, currentUser };
}
