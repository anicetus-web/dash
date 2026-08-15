import assert from 'node:assert';
import {
  matchesFilters,
  dealFilterValues,
  buildFilterReference,
  extraFilterSlice,
  NOT_SPECIFIED,
  EXTRA_FILTER_KEYS
} from '../src/analytics/dashboard.js';

// Нормализованные сделки (как их отдаёт итерация 1): enum → текст, множ. → массив, пусто → ''/[].
const deals = [
  { id: '1', managerId: '10', sourceId: '2678', objectType: 'Гражданский', clientType: 'Проектная компания', need: ['Экспертиза', 'ВОРы'], projectRole: ['Генпроектировщик'], city: 'Тверь', turnover: 'До 100 млн' },
  { id: '2', managerId: '11', sourceId: '2680', objectType: 'Промышленный', clientType: 'Застройщик/строитель', need: ['Экспертиза'], projectRole: [], city: 'Москва', turnover: 'До 50 млн' },
  { id: '3', managerId: '10', sourceId: '2678', objectType: '', clientType: '', need: [], projectRole: [], city: '', turnover: '' }
];

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok:', name); }
  catch (err) { failed += 1; console.error('FAIL:', name, '→', err.message); }
};

// --- matchesFilters ---
check('одиночное поле: совпадение', () => assert.strictEqual(matchesFilters(deals[0], { objectType: 'Гражданский' }), true));
check('одиночное поле: несовпадение', () => assert.strictEqual(matchesFilters(deals[1], { objectType: 'Гражданский' }), false));
check('многозначное поле: содержит выбранное', () => assert.strictEqual(matchesFilters(deals[0], { need: 'ВОРы' }), true));
check('многозначное поле: не содержит', () => assert.strictEqual(matchesFilters(deals[0], { need: 'Обучение' }), false));
check('«Не указано»: пустое поле проходит', () => assert.strictEqual(matchesFilters(deals[2], { objectType: NOT_SPECIFIED }), true));
check('«Не указано»: заполненное поле не проходит', () => assert.strictEqual(matchesFilters(deals[0], { objectType: NOT_SPECIFIED }), false));
check('нет активных фильтров → проходит', () => assert.strictEqual(matchesFilters(deals[0], {}), true));
check('комбинация полей (AND): город не тот', () => assert.strictEqual(matchesFilters(deals[0], { objectType: 'Гражданский', city: 'Москва' }), false));
check('комбинация с legacy (менеджер + оборот)', () => assert.strictEqual(matchesFilters(deals[0], { managerId: '10', turnover: 'До 100 млн' }), true));
check('clientType из deal.clientType', () => assert.strictEqual(matchesFilters(deals[0], { clientType: 'Проектная компания' }), true));
check('legacy managerId по-прежнему фильтрует', () => assert.strictEqual(matchesFilters(deals[1], { managerId: '10' }), false));

// --- dealFilterValues ---
check('dealFilterValues: многозначное', () => assert.deepStrictEqual(dealFilterValues(deals[0], 'need'), ['Экспертиза', 'ВОРы']));
check('dealFilterValues: одиночное → массив', () => assert.deepStrictEqual(dealFilterValues(deals[0], 'objectType'), ['Гражданский']));
check('dealFilterValues: пусто → []', () => assert.deepStrictEqual(dealFilterValues(deals[2], 'city'), []));
check('dealFilterValues: сделка без поля → []', () => assert.deepStrictEqual(dealFilterValues({ id: 'x' }, 'turnover'), []));

// --- buildFilterReference ---
const ref = buildFilterReference(deals);
check('reference: objectType — значения + «Не указано» последним', () => {
  assert.deepStrictEqual(ref.objectType.map((r) => r.name), ['Гражданский', 'Промышленный', 'Не указано']);
  assert.strictEqual(ref.objectType.at(-1).id, NOT_SPECIFIED);
});
check('reference: need по убыванию частоты (Экспертиза×2 → первой)', () => {
  assert.deepStrictEqual(ref.need.map((r) => r.name), ['Экспертиза', 'ВОРы', 'Не указано']);
});
check('reference: city по алфавиту (ru)', () => {
  assert.deepStrictEqual(ref.city.map((r) => r.name), ['Москва', 'Тверь', 'Не указано']);
});
check('reference: все шесть ключей присутствуют', () => {
  assert.deepStrictEqual(Object.keys(ref).sort(), [...EXTRA_FILTER_KEYS].sort());
});
check('reference: id === name для реальных значений (фронт кладёт value=id)', () => {
  assert.strictEqual(ref.objectType[0].id, ref.objectType[0].name);
});

// --- extraFilterSlice ---
check('extraFilterSlice: только известные ключи, отсутствующие → ""', () => {
  assert.deepStrictEqual(extraFilterSlice({ objectType: 'X', foo: 'bar' }), { objectType: 'X', clientType: '', need: '', projectRole: '', city: '', turnover: '' });
});

// --- Канонический порядок enum по справочнику (enumDictionaries из итерации 1) ---
const turnoverDeals = [
  { id: 'a', turnover: 'До 100 млн' }, { id: 'b', turnover: 'До 100 млн' }, // чаще
  { id: 'c', turnover: 'До 10 млн' }, { id: 'd', turnover: '175' }          // 175 — легаси-ID вне справочника
];
const dicts = { turnover: ['До 10 млн', 'До 50 млн', 'До 100 млн', 'до 250 млн'] };
const refDict = buildFilterReference(turnoverDeals, dicts);
check('оборот в каноническом порядке справочника (не по частоте)', () => {
  // «До 10 млн» раньше «До 100 млн» несмотря на меньшую частоту; «До 50 млн» нет в данных — пропущен;
  // легаси-ID «175» (чисто числовой) скрыт; «Не указано» последним.
  assert.deepStrictEqual(refDict.turnover.map((r) => r.name), ['До 10 млн', 'До 100 млн', 'Не указано']);
});

// --- Отсев мусорных городов (address-поле бывает «-», «?», индекс) ---
const cityDeals = [
  { id: '1', city: 'Москва' }, { id: '2', city: '-' }, { id: '3', city: '127083' }, { id: '4', city: 'Тверь' }, { id: '5', city: '?' }
];
check('город: мусор («-», «?», индекс) отсеян, буквенные остаются', () => {
  assert.deepStrictEqual(buildFilterReference(cityDeals).city.map((r) => r.name), ['Москва', 'Тверь', 'Не указано']);
});

if (failed) {
  console.error(`\n${failed} проверок filters упало`);
  process.exit(1);
}
console.log('\nвсе проверки filters прошли');
