/**
 * Пароли: хеширование, проверка, генерация.
 *
 * Внешних библиотек нет и здесь — всё нужное есть в node:crypto. Выбран scrypt:
 * он намеренно требует много памяти, поэтому перебор на видеокартах дорог, в
 * отличие от быстрых хешей вроде SHA-256, которыми пароли хешировать нельзя.
 *
 * Три правила файла:
 *   1. Открытый пароль не покидает эту границу: наружу уходит только строка
 *      хеша, и она же приходит на проверку. Ни логи, ни ответы API, ни хранилище
 *      открытого пароля не видят.
 *   2. Сравнение — только timingSafeEqual. Обычное === выходит из сравнения на
 *      первом несовпавшем байте, и по времени ответа хеш подбирается посимвольно.
 *   3. Асинхронный scrypt, не scryptSync: хеш считается ~50 мс, и синхронный
 *      вызов заблокировал бы событийный цикл целиком — на 200 пользователях
 *      каждая попытка входа останавливала бы дашборд у всех остальных.
 */

import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Параметры scrypt. N — главный множитель стоимости (16384 ≈ 50 мс на
 * современном сервере). Записываются В САМ хеш: если однажды поднять стоимость,
 * старые хеши продолжат проверяться со своими прежними параметрами, а не
 * сломаются все разом.
 */
const PARAMS = Object.freeze({ N: 16384, r: 8, p: 1, keyLength: 64 });

/** Длина соли. Соль у каждого пароля своя — одинаковые пароли дают разные хеши. */
const SALT_BYTES = 16;

/** Схема, записанная в начале строки хеша: по ней читается формат при проверке. */
const SCHEME = 'scrypt';

function scryptAsync(password, salt, keyLength, options) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

/**
 * Хеш пароля в виде самодостаточной строки:
 * `scrypt$N$r$p$сольBase64$хешBase64`.
 *
 * Всё нужное для проверки лежит внутри строки — хранилищу не нужно помнить
 * параметры отдельно, и они не могут разъехаться с хешем.
 */
export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('Пароль должен быть непустой строкой');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(plain.normalize('NFKC'), salt, PARAMS.keyLength, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p
  });
  return [SCHEME, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Проверка пароля против хранимой строки хеша.
 *
 * Возвращает false на любом непонятном входе (битая строка, чужая схема,
 * отсутствующий хеш) и НИКОГДА не бросает исключение: вход в систему не должен
 * падать пятисоткой из-за одной испорченной записи пользователя.
 */
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCHEME) return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Верхняя граница стоимости: испорченная (или подменённая) запись с N = 2^30
  // иначе съела бы всю память сервера при первой же попытке входа.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const derived = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, { N, r, p });
    // Длины совпадают по построению (derived запрошен длиной expected), но
    // timingSafeEqual бросает на разной длине — проверяем явно.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Алфавит генерируемых паролей. Умышленно без символов, которые путаются при
 * переписывании и диктовке: 0/O, 1/l/I, 5/S, 8/B. Пароль будут передавать
 * сотруднику голосом или в сообщении — неразличимые знаки here стоят дороже,
 * чем пара бит энтропии.
 */
const ALPHABET =
  'abcdefghijkmnpqrstuvwxyz' + // без l и o
  'ACDEFGHJKLMNPQRTUVWXYZ' +   // без B, I, O, S
  '234679';                    // без 0, 1, 5, 8

/**
 * Случайный пароль для нового сотрудника.
 *
 * randomInt из node:crypto, а не Math.random: последний предсказуем и для
 * выдачи паролей непригоден в принципе. Длина 14 при этом алфавите — около
 * 80 бит энтропии, с запасом достаточно для доступа к внутреннему дашборду.
 */
export function generatePassword(length = 14) {
  const size = Math.max(10, Math.trunc(length) || 14);
  let out = '';
  for (let i = 0; i < size; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Случайный токен сессии. */
export function generateToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Требования к паролю, который пользователь задаёт САМ (первый администратор
 * или смена пароля). Сгенерированные пароли им заведомо удовлетворяют.
 * Возвращает текст проблемы или null.
 */
export function passwordProblem(plain) {
  if (typeof plain !== 'string' || plain.length === 0) return 'Пароль не может быть пустым';
  if (plain.length < 10) return 'Пароль должен быть не короче 10 символов';
  if (plain.length > 200) return 'Пароль не может быть длиннее 200 символов';
  if (!/[^\s]/.test(plain)) return 'Пароль не может состоять из одних пробелов';
  return null;
}
