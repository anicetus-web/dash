import assert from 'node:assert';
import {
  normalizeDeal,
  enumText,
  enumTexts,
  cityFromAddress,
  contractYearOf,
  stripNeedPrefix
} from '../src/bitrix/normalize.js';

// Словари ID→текст, как их строит fullSync из /deals/fields.
const items = {
  objectType: { '5986': 'Гражданский', '5988': 'Промышленный' },
  need: { '6134': '(2D-BIM) Прохождение экспертизы', '6136': '(2D-BIM) Проверка ПД' },
  projectRole: { '6832': 'Генпроектировщик (полностью отвечает за проект)', '6834': 'Субпроектировщик' },
  turnover: { '2780': 'До 50 млн', '2782': 'До 100 млн' }
};

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok:', name); }
  catch (err) { failed += 1; console.error('FAIL:', name, '→', err.message); }
};

// --- Чистые хелперы ---
check('enumText: ID → текст', () => assert.strictEqual(enumText(5986, items.objectType), 'Гражданский'));
check('enumText: текст проходит как есть', () => assert.strictEqual(enumText('Гражданский', items.objectType), 'Гражданский'));
check('enumText: пусто → пустая строка', () => assert.strictEqual(enumText('', items.objectType), ''));
check('enumText: нерезолвимый ID → строка ID', () => assert.strictEqual(enumText(175, items.turnover), '175'));

check('enumTexts: массив ID → тексты', () => assert.deepStrictEqual(enumTexts([6832, 6834], items.projectRole), ['Генпроектировщик (полностью отвечает за проект)', 'Субпроектировщик']));
check('enumTexts: одиночное значение → массив', () => assert.deepStrictEqual(enumTexts(6832, items.projectRole), ['Генпроектировщик (полностью отвечает за проект)']));
check('enumTexts: пустой массив → []', () => assert.deepStrictEqual(enumTexts([], items.projectRole), []));
check('enumTexts: ID строками (прокси может отдавать строки)', () => assert.deepStrictEqual(enumTexts(['6832'], items.projectRole), ['Генпроектировщик (полностью отвечает за проект)']));

check('cityFromAddress: полный адрес → город', () => assert.strictEqual(cityFromAddress('Тверь, Тверская область, Россия|56.85;35.92|10654'), 'Тверь'));
check('cityFromAddress: короткий вариант', () => assert.strictEqual(cityFromAddress('Севастополь|;|11900'), 'Севастополь'));
check('cityFromAddress: пусто → пустая строка', () => assert.strictEqual(cityFromAddress(''), ''));

check('contractYearOf: «2026» → 2026', () => assert.strictEqual(contractYearOf('2026'), 2026));
check('contractYearOf: пусто → null', () => assert.strictEqual(contractYearOf(''), null));
check('contractYearOf: мусор → null', () => assert.strictEqual(contractYearOf('скоро'), null));
check('contractYearOf: вне диапазона → null', () => assert.strictEqual(contractYearOf('1999'), null));

check('stripNeedPrefix: срезает «(2D-BIM) »', () => assert.strictEqual(stripNeedPrefix('(2D-BIM) Прохождение экспертизы'), 'Прохождение экспертизы'));

// --- Интеграция normalizeDeal ---
const rawFull = {
  id: '1', title: 'ООО Ромашка', stageId: 'C78:UC_50O081', opportunity: 5000000, currencyId: 'RUB',
  assignedById: '10',
  ufCrm_1769063572057: 5986,            // objectType
  ufCrm_1771482054936: [6134, 6136],    // need (множ.)
  ufCrm_1783338543497: [],              // projectRoleNew — пусто
  ufCrm_1782886702182: [6832],          // projectRoleOld — фолбэк
  ufCrm_1690191665983: 'Тверь, Тверская область, Россия|56.85;35.92|10654',
  ufCrm_1690191601100: 2782,            // turnover
  ufCrm_1770125160081: '2025'
};
const dealFull = normalizeDeal(rawFull, { newFieldItems: items });

check('normalizeDeal: objectType', () => assert.strictEqual(dealFull.objectType, 'Гражданский'));
check('normalizeDeal: need без префикса', () => assert.deepStrictEqual(dealFull.need, ['Прохождение экспертизы', 'Проверка ПД']));
check('normalizeDeal: роль — фолбэк на старое поле, когда новое пусто', () => assert.deepStrictEqual(dealFull.projectRole, ['Генпроектировщик (полностью отвечает за проект)']));
check('normalizeDeal: city', () => assert.strictEqual(dealFull.city, 'Тверь'));
check('normalizeDeal: turnover', () => assert.strictEqual(dealFull.turnover, 'До 100 млн'));
check('normalizeDeal: contractYear число', () => assert.strictEqual(dealFull.contractYear, 2025));

// Приоритет нового поля роли, когда оно заполнено.
const dealRoleNew = normalizeDeal({ ...rawFull, ufCrm_1783338543497: [6834] }, { newFieldItems: items });
check('normalizeDeal: новое поле роли в приоритете', () => assert.deepStrictEqual(dealRoleNew.projectRole, ['Субпроектировщик']));

// Множественный enum строками ID.
const dealStrIds = normalizeDeal({ ...rawFull, ufCrm_1771482054936: ['6134', '6136'] }, { newFieldItems: items });
check('normalizeDeal: need из ID-строк', () => assert.deepStrictEqual(dealStrIds.need, ['Прохождение экспертизы', 'Проверка ПД']));

// Пустая сделка — контракт пустых значений.
const dealEmpty = normalizeDeal({ id: '2' }, { newFieldItems: items });
check('normalizeDeal: пустой objectType → ""', () => assert.strictEqual(dealEmpty.objectType, ''));
check('normalizeDeal: пустой need → []', () => assert.deepStrictEqual(dealEmpty.need, []));
check('normalizeDeal: пустой projectRole → []', () => assert.deepStrictEqual(dealEmpty.projectRole, []));
check('normalizeDeal: пустой city → ""', () => assert.strictEqual(dealEmpty.city, ''));
check('normalizeDeal: пустой contractYear → null', () => assert.strictEqual(dealEmpty.contractYear, null));

// Обратная совместимость: без newFieldItems ничего не падает (поля остаются ID/пустыми).
const dealNoItems = normalizeDeal(rawFull);
check('normalizeDeal: без словарей не падает', () => assert.strictEqual(typeof dealNoItems.objectType, 'string'));

if (failed) {
  console.error(`\n${failed} проверок normalize упало`);
  process.exit(1);
}
console.log('\nвсе проверки normalize прошли');
