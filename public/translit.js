/**
 * Транслитерация кириллицы и подсказка логина по имени.
 *
 * Файл лежит в `public/`, но используется ОБЕИМИ сторонами: браузер
 * подставляет логин прямо во время набора имени, сервер по тем же правилам
 * разрешает совпадения (`ivanov`, `ivanov2`, `ivanov3`). Правила обязаны
 * совпадать до буквы — иначе подсказка в поле и сохранённый логин разойдутся,
 * и сотруднику выдадут не тот логин, который он видел. Поэтому таблица одна,
 * а не две копии: модуль чистый, без единого обращения к Node или к DOM,
 * и одинаково работает и там, и там.
 */

/** Таблица по практике русской транслитерации: щ→shch, ж→zh, х→h. */
const MAP = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e',
  ю: 'yu', я: 'ya',
  // Украинские и белорусские буквы: фамилии сотрудников часто их содержат,
  // и без них «Гнатюк» превратился бы в «гнатюк» с выпавшим знаком.
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u'
};

/** Кириллица → латиница. Некириллические знаки проходят как есть. */
export function transliterate(text) {
  const chars = [...String(text ?? '')];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const lower = char.toLowerCase();
    const mapped = MAP[lower];
    if (mapped === undefined) {
      out += char;
      continue;
    }
    if (char === lower) {
      out += mapped;
      continue;
    }
    // Заглавная буква. Если следующая тоже заглавная — слово набрано капсом,
    // и многобуквенное соответствие поднимается целиком: «ЩУКИН» → «SHCHUKIN»,
    // а не «ShchUKIN». Иначе поднимается только первая буква: «Щукин» → «Shchukin».
    const next = chars[i + 1];
    const capsRun = next !== undefined && next !== next.toLowerCase() && MAP[next.toLowerCase()] !== undefined;
    out += capsRun ? mapped.toUpperCase() : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }
  return out;
}

/** Отчество: в логине оно только занимает место, никого не различая. */
function isPatronymic(word) {
  return /(ович|евич|ьевич|ич|овна|евна|ьевна|ична|инична)$/i.test(word);
}

/**
 * Логин из имени сотрудника.
 *
 * «Мария Сидорова» → «maria.sidorova», «Пётр» → «petr».
 * Берутся первые два слова: отчество в логин не идёт, оно только удлиняет его,
 * ничего не различая. Результат уже удовлетворяет проверке логина на сервере
 * (только латиница, цифры, точка, дефис, подчёркивание).
 */
export function loginFromName(name) {
  // Отчество отбрасывается ДО транслитерации, пока видно кириллическое
  // окончание: «Иван Иванович Иванов» должен дать «ivan.ivanov», а не
  // «ivan.ivanovich» с потерянной фамилией.
  const source = String(name ?? '')
    .split(/\s+/)
    .filter((word) => word && !isPatronymic(word));

  const words = transliterate(source.join(' '))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 2);
  if (words.length === 0) return '';
  return words.join('.').slice(0, 64);
}

/**
 * Свободный логин с учётом уже занятых.
 *
 * Совпадение имён — обычное дело даже в небольшой компании, и молча отказать
 * при сохранении хуже, чем предложить «ivanov2» сразу. Сравнение регистро-
 * независимое, как и в самом хранилище.
 */
export function uniqueLogin(base, taken) {
  const occupied = new Set([...(taken ?? [])].map((item) => String(item).toLowerCase()));
  const root = (base || 'user').slice(0, 60);
  if (!occupied.has(root)) return root;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${root}${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  // Тысяча однофамильцев — сценарий за пределами разумного, но вернуть
  // заведомо занятый логин нельзя: добавляем случайный хвост.
  return `${root}${Math.floor(Math.random() * 1e6)}`;
}
