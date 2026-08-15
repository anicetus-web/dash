// Проверки чтения разнородных полей CRM. Правило простое: одно и то же значение,
// записанное порталом по-разному, обязано читаться одинаково — на этом держится
// дедупликация сущностей и попадание событий в границы периода.
import assert from 'node:assert';
import { boolOf, dateOrNull, idOf, idsOf, isoOrNull, normalizeText, numberOf, textOf, valueOf } from '../src/lib/records.js';

let failed = 0;

function check(name, run) {
  try {
    run();
    console.log(`ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} → ${error.message}`);
  }
}

check('один и тот же идентификатор в разных записях портала даёт один ключ', () => {
  assert.strictEqual(idOf(12), '12');
  assert.strictEqual(idOf('12'), '12');
  assert.strictEqual(idOf(' 12 '), '12');
  assert.strictEqual(idOf('012'), '12', 'ведущие нули не создают вторую сущность');
});

check('отсутствие связи не превращается в идентификатор', () => {
  for (const value of [0, '0', '', '   ', null, undefined, -5, 1.5, Number.NaN, {}, []]) {
    assert.strictEqual(idOf(value), '', `значение ${JSON.stringify(value)} не является ID`);
  }
});

check('нечисловой идентификатор стадии сохраняется как есть', () => {
  assert.strictEqual(idOf('C78:NEW'), 'C78:NEW');
  assert.strictEqual(idOf(' UC_9X7 '), 'UC_9X7');
});

check('список идентификаторов снимает дубли и мусор, сохраняя порядок', () => {
  assert.deepStrictEqual(idsOf(['7', 7, ' 007 ', '', null, '9']), ['7', '9']);
  assert.deepStrictEqual(idsOf('42'), ['42'], 'скаляр читается как список из одного значения');
  assert.deepStrictEqual(idsOf(undefined), []);
});

check('поле читается независимо от регистра и разделителей в имени', () => {
  // Один и тот же ответственный приходит из разных методов портала как ASSIGNED_BY_ID
  // и как assignedById. Разное чтение означало бы потерю атрибуции менеджера.
  assert.strictEqual(valueOf({ ASSIGNED_BY_ID: 7 }, ['assignedById']), 7);
  assert.strictEqual(valueOf({ assignedById: 7 }, ['ASSIGNED_BY_ID']), 7);
  assert.strictEqual(valueOf({ Company_Id: '5' }, ['companyId']), '5');
  assert.strictEqual(valueOf({ other: 1 }, ['companyId'], 'нет поля'), 'нет поля');
});

check('пустое значение поля не считается заполненным', () => {
  assert.strictEqual(valueOf({ title: '', name: 'ЖБИ-Комплект' }, ['title', 'name']), 'ЖБИ-Комплект');
  assert.strictEqual(valueOf({ title: null }, ['title'], 'по умолчанию'), 'по умолчанию');
  assert.strictEqual(textOf({ title: '  ' }, ['title'], 'Без названия'), 'Без названия');
  assert.strictEqual(textOf({ title: '  Мостострой  ' }, ['title']), 'Мостострой');
});

check('дата без часового пояса читается одинаково на любой машине', () => {
  // Портал иногда отдаёт «2026-08-15 10:30:00» без смещения. Если довериться разбору по
  // локальному времени, сервер в другом поясе отнёс бы событие к другому дню.
  assert.strictEqual(dateOrNull('2026-08-15 10:30:00').toISOString(), '2026-08-15T10:30:00.000Z');
  assert.strictEqual(dateOrNull('2026-08-15T10:30:00').toISOString(), '2026-08-15T10:30:00.000Z');
  assert.strictEqual(isoOrNull('2026-08-15'), '2026-08-15T00:00:00.000Z');
});

check('дата со смещением портала приводится к UTC без потери момента', () => {
  assert.strictEqual(isoOrNull('2026-08-15T10:30:00+03:00'), '2026-08-15T07:30:00.000Z');
  assert.strictEqual(isoOrNull('2026-08-15T07:30:00Z'), '2026-08-15T07:30:00.000Z');
});

check('нечитаемая дата исчезает, а не превращается в Invalid Date', () => {
  for (const value of ['не дата', '2026-13-45', '', null, undefined, {}, Number.NaN, 0]) {
    assert.strictEqual(dateOrNull(value), null, `значение ${JSON.stringify(value)} не является датой`);
  }
  assert.strictEqual(isoOrNull('позавчера'), null);
});

check('время эпохи читается и в секундах, и в миллисекундах', () => {
  assert.strictEqual(isoOrNull(1755259800), '2025-08-15T12:10:00.000Z');
  assert.strictEqual(isoOrNull(1755259800000), '2025-08-15T12:10:00.000Z');
  assert.strictEqual(isoOrNull('1755259800'), '2025-08-15T12:10:00.000Z');
});

check('готовый объект даты копируется, а не отдаётся ссылкой', () => {
  const source = new Date('2026-08-15T10:00:00.000Z');
  const parsed = dateOrNull(source);
  parsed.setUTCFullYear(1999);
  assert.strictEqual(source.toISOString(), '2026-08-15T10:00:00.000Z', 'исходная запись не изменилась');
});

check('число из поля портала не превращается в NaN', () => {
  assert.strictEqual(numberOf('1 234,50|RUB'), 1234.5);
  assert.strictEqual(numberOf(42), 42);
  assert.strictEqual(numberOf('не число'), 0);
  assert.strictEqual(numberOf(null), 0);
  assert.strictEqual(numberOf(Number.NaN), 0);
});

check('булево поле портала понимается в любой записи', () => {
  assert.strictEqual(boolOf('Y'), true);
  assert.strictEqual(boolOf('n'), false);
  assert.strictEqual(boolOf(1), true);
  assert.strictEqual(boolOf('true'), true);
  assert.strictEqual(boolOf('', true), true, 'пустое значение оставляет значение по умолчанию');
  assert.strictEqual(boolOf('может быть', false), false);
});

check('текст для сравнения не различает регистр, ё и пунктуацию', () => {
  assert.strictEqual(normalizeText('Стройзаказ «Ёлка», ООО'), normalizeText('стройзаказ  Елка ООО'));
  assert.strictEqual(normalizeText(null), '');
});

if (failed) {
  console.error(`\nПроверок чтения полей упало: ${failed}`);
  process.exit(1);
}
console.log('\nПроверки чтения полей пройдены');
