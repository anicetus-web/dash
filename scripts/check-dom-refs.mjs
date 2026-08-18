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
