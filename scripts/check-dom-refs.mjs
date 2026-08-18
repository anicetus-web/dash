// Статическая сверка фронтенда с разметкой.
//
// Ловит ровно тот класс бага, который в этом проекте доезжал до экрана
// трижды: код обращается к элементу, которого в разметке нет. В браузере это
// даёт `Cannot set properties of undefined` внутри render()/init(), и дальше
// НИЧЕГО не выполняется — экран остаётся пустым или наполовину собранным,
// причём `npm test` до сих пор этого не видел: он гоняет только серверный код,
// а public/*.js в DOM никогда не исполняется.
//
// Проверка нарочно тупая и текстовая (без headless-браузера): она обязана
// быть быстрой и работать в любой среде, включая CI без графики.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');

const appJs = read('public/app.js');
const loginJs = read('public/login.js');
const indexHtml = read('public/index.html');
const loginHtml = read('public/login.html');

const cases = [];
function check(name, run) {
  cases.push([name, run]);
}

/** Все id, объявленные в разметке. */
function idsOf(html) {
  return new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
}

/** Все обращения вида querySelector('#id') в скрипте. */
function requestedIds(js) {
  return [...js.matchAll(/querySelectorAll?\('#([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]);
}

check('каждый #id, запрошенный dashboard-скриптом, есть в index.html', () => {
  const declared = idsOf(indexHtml);
  const missing = [...new Set(requestedIds(appJs))].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `в разметке нет элементов: ${missing.join(', ')}`);
});

check('каждый #id, запрошенный скриптом входа, есть в login.html', () => {
  const declared = idsOf(loginHtml);
  const missing = [...new Set(requestedIds(loginJs))].filter((id) => !declared.has(id));
  assert.deepStrictEqual(missing, [], `в разметке нет элементов: ${missing.join(', ')}`);
});

/**
 * Главная проверка: `els.чтоТо`, использованное в коде, обязано быть объявлено
 * в самом объекте `els`. Необъявленное поле даёт `undefined`, а запись в его
 * `.textContent` роняет весь рендер — именно так дашборд однажды перестал
 * показывать что-либо вообще, при полностью исправном сервере.
 */
check('все поля els объявлены в самом объекте els', () => {
  const start = appJs.indexOf('const els = {');
  assert.ok(start > 0, 'объект els не найден — проверка потеряла смысл, поправьте её');
  const end = appJs.indexOf('\n};', start);
  const declaration = appJs.slice(start, end);

  const declared = new Set([...declaration.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]));
  const used = new Set([...appJs.matchAll(/\bels\.([A-Za-z0-9_]+)/g)].map((m) => m[1]));

  const missing = [...used].filter((key) => !declared.has(key));
  assert.deepStrictEqual(missing, [], `els.${missing.join(', els.')} — используется, но не объявлено`);
});

check('в els нет полей, которые никто не читает', () => {
  const start = appJs.indexOf('const els = {');
  const end = appJs.indexOf('\n};', start);
  const declaration = appJs.slice(start, end);
  const declared = [...declaration.matchAll(/^\s*([A-Za-z0-9_]+)\s*:/gm)].map((m) => m[1]);
  const body = appJs.slice(0, start) + appJs.slice(end);
  const unused = declared.filter((key) => !new RegExp(`\\bels\\.${key}\\b`).test(body));
  // Не ошибка исполнения, но мёртвая ссылка на разметку: элемент удалят,
  // и обнаружится это уже только глазами.
  assert.deepStrictEqual(unused, [], `els.${unused.join(', els.')} — объявлено, но нигде не читается`);
});

check('data-атрибуты, по которым ищет скрипт, где-то действительно проставляются', () => {
  const requested = [...new Set([...appJs.matchAll(/querySelectorAll?\('\[data-([a-z-]+)[^\]]*\]'\)/g)].map((m) => m[1]))];
  // Часть разметки собирается самим скриптом (карточки воронки, кнопки типа
  // периода), поэтому источником истины здесь не только index.html: искать
  // надо и в шаблонных строках app.js, иначе проверка ругается на живой код.
  const missing = requested.filter((name) => !indexHtml.includes(`data-${name}`) && !appJs.includes(`data-${name}=`));
  assert.deepStrictEqual(missing, [], `атрибуты нигде не проставляются: data-${missing.join(', data-')}`);
});

/**
 * Исходник без комментариев. Строки и регулярные выражения НЕ вырезаются
 * намеренно: полноценный разбор JS текстом получается хрупким (кавычка внутри
 * регулярного выражения уводит его на десятки килобайт), а лишние совпадения
 * из строк дешевле закрыть списком известных имён, чем чинить самодельный
 * лексер. Проверка обязана быть тупой и предсказуемой.
 */
function stripComments(js) {
  return js
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Имена, объявленные в модуле: функции, переменные, классы, импорты И параметры.
 * Параметры обязательны: без них колбэк, полученный аргументом (`onPick`,
 * `resolve`), выглядит вызовом несуществующей функции.
 */
function declaredNames(js) {
  const names = new Set();
  for (const m of js.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of js.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of js.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of js.matchAll(/import\s+([^;]+?)\s+from/g)) addNames(names, m[1]);
  // Списки в скобках: аргументы функций и стрелок. Разбирается грубо — задача
  // не понять код, а собрать имена, которые в модуле связаны.
  for (const m of js.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) addNames(names, m[1]);
  for (const m of js.matchAll(/\b(?:const|let|var)\s*([{[][^}\]]*[}\]])/g)) addNames(names, m[1]);
  // Короткая запись метода в объекте или классе: `setState(next) {`. Без неё
  // собственное определение метода читается как вызов несуществующей функции.
  for (const m of js.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm)) names.add(m[1]);
  return names;
}

function addNames(names, source) {
  for (const part of source.replace(/[{}[\]]/g, ' ').split(',')) {
    const name = part.split(':').pop().split('=')[0].replace(/\.\.\./, '').trim();
    const bare = name.split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
  }
}

/**
 * Имена, которые выглядят вызовом, но функциями модуля не являются: глобальные
 * функции языка и браузера, ключевые слова и функции CSS из строк стилей.
 */
const NOT_MODULE_FUNCTIONS = new Set([
  'alert', 'confirm', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'encodeURIComponent', 'decodeURIComponent',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'String', 'Number', 'Boolean', 'Array',
  'Object', 'Set', 'Map', 'WeakMap', 'Date', 'Error', 'Promise', 'JSON', 'Math', 'RegExp',
  'Intl', 'FormData', 'URLSearchParams', 'URL', 'Blob', 'FileReader', 'Image', 'AbortController',
  'structuredClone', 'queueMicrotask', 'btoa', 'atob', 'BigInt', 'Symbol', 'Proxy', 'Reflect',
  // Ключевые слова: перед скобкой выглядят как вызов, но им не являются.
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'super', 'this',
  'await', 'yield', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'case', 'async',
  // Функции CSS — встречаются внутри строк стилей.
  'calc', 'min', 'max', 'clamp', 'translateX', 'translateY', 'translate', 'scale', 'rotate',
  'rgba', 'rgb', 'hsl', 'hsla', 'var', 'url', 'linear-gradient', 'cubic-bezier',
  // Псевдоклассы CSS в строках селекторов: `:not(...)`.
  'not', 'is', 'where', 'has'
]);

/**
 * Вызовы функций, которых в модуле нет.
 *
 * Тот же класс отказа, что и мёртвая ссылка на элемент: исключение внутри
 * render() обрывает отрисовку ВСЕЙ страницы, а консоль при этом чистая —
 * ошибка перехватывается и печатается в саму страницу. Так на бой уехал вызов
 * renderLineChart вместо renderChart: воронка ниже показывала «Не удалось
 * рассчитать воронку», хотя расчёт был полностью исправен.
 */
function undefinedCalls(source) {
  const js = stripComments(source);
  const declared = declaredNames(js);
  const called = new Set();
  const pattern = /([A-Za-z_$][\w$]*)\s*\(/g;
  let match = pattern.exec(js);
  while (match !== null) {
    const before = match.index > 0 ? js[match.index - 1] : ' ';
    // Обращение к методу объекта (`что-то.метод(`) проверять нечем: объект
    // приходит извне модуля. Проверяем только голые имена.
    if (before !== '.' && !/[A-Za-z0-9_$]/.test(before)) called.add(match[1]);
    match = pattern.exec(js);
  }
  return [...called].filter((name) => !declared.has(name) && !NOT_MODULE_FUNCTIONS.has(name));
}

check('dashboard-скрипт не вызывает функций, которых в нём нет', () => {
  const missing = undefinedCalls(appJs);
  assert.deepStrictEqual(missing, [], `вызовы несуществующих функций: ${missing.join(', ')}`);
});

check('скрипт входа не вызывает функций, которых в нём нет', () => {
  const missing = undefinedCalls(loginJs);
  assert.deepStrictEqual(missing, [], `вызовы несуществующих функций: ${missing.join(', ')}`);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error.message.split('\n')[0]);
  }
}
if (failed) {
  console.error(`${failed}/${cases.length} проверок связности фронтенда упало`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed: cases.length }));
