// Проверки границ периода и часового пояса портала (инварианты 10 и 11).
//
// Каждая проверка — утверждение о бизнес-правиле, а не о вызове функции.
// Текущий момент везде передаётся параметром: `new Date()` без аргументов в ожиданиях
// не встречается, иначе результат зависел бы от дня запуска.
import assert from 'node:assert';
import {
  resolvePeriod,
  inPeriod,
  periodKeyFromDate,
  formatDayInZone,
  formatDateTimeInZone,
  DEFAULT_PERIOD_TYPE,
  PERIOD_TYPES
} from '../src/domain/period.js';

const MOSCOW = 'Europe/Moscow';
const NEW_YORK = 'America/New_York';
const KATHMANDU = 'Asia/Kathmandu';
const SANTIAGO = 'America/Santiago';

const cases = [];
function check(name, run) {
  cases.push([name, run]);
}

function iso(date) {
  return date === null ? null : date.toISOString();
}

function day(dayString, timeZone, now = new Date('2030-01-01T00:00:00.000Z')) {
  return resolvePeriod({ type: 'custom', from: dayString, to: dayString }, { now, timeZone });
}

// ── Часовой пояс портала ─────────────────────────────────────────────────────

check('сутки портала начинаются по часам портала, а не в полночь UTC', () => {
  const moscow = day('2026-08-15', MOSCOW);
  assert.strictEqual(iso(moscow.from), '2026-08-14T21:00:00.000Z');
  assert.strictEqual(iso(moscow.to), '2026-08-15T20:59:59.999Z');

  const utc = day('2026-08-15', 'UTC');
  assert.strictEqual(iso(utc.from), '2026-08-15T00:00:00.000Z');
  assert.strictEqual(iso(utc.to), '2026-08-15T23:59:59.999Z');
});

check('вечернее событие остаётся в своих сутках портала, а не уезжает в следующие', () => {
  const moscow = day('2026-08-15', MOSCOW);
  // 23:30 по Москве — ещё 15-е число.
  assert.strictEqual(inPeriod('2026-08-15T20:30:00.000Z', moscow), true);
  // 00:30 по Москве — уже 16-е, в сутках 15-го числа этого события быть не должно.
  assert.strictEqual(inPeriod('2026-08-15T21:30:00.000Z', moscow), false);

  // Тот же момент в UTC-периоде 15-го числа попадает внутрь — ровно эта ошибка
  // и возникает, если считать границы в UTC вместо часов портала.
  const utc = day('2026-08-15', 'UTC');
  assert.strictEqual(inPeriod('2026-08-15T21:30:00.000Z', utc), true);
});

check('сдвиг зоны берётся у самой зоны: пояс с 45 минутами считается точно', () => {
  const kathmandu = day('2026-08-15', KATHMANDU);
  assert.strictEqual(iso(kathmandu.from), '2026-08-14T18:15:00.000Z');
  assert.strictEqual(iso(kathmandu.to), '2026-08-15T18:14:59.999Z');
});

check('сутки перевода стрелок длятся 23 и 25 часов, а не ровно 24', () => {
  const spring = day('2026-03-08', NEW_YORK);
  assert.strictEqual(iso(spring.from), '2026-03-08T05:00:00.000Z');
  assert.strictEqual(iso(spring.to), '2026-03-09T03:59:59.999Z');
  assert.strictEqual(spring.to.getTime() - spring.from.getTime() + 1, 23 * 3600 * 1000);

  const autumn = day('2026-11-01', NEW_YORK);
  assert.strictEqual(autumn.to.getTime() - autumn.from.getTime() + 1, 25 * 3600 * 1000);
});

check('начало и конец суток — первый и последний момент этих суток по часам портала', () => {
  // Правило одно для любой зоны, включая ту, где полночь не существует из-за перевода
  // стрелок (Сантьяго переводит часы в 00:00) и где сдвиг не кратен часу.
  const pairs = [
    [MOSCOW, '2026-08-15', '2026-08-14', '2026-08-16'],
    [NEW_YORK, '2026-03-08', '2026-03-07', '2026-03-09'],
    [NEW_YORK, '2026-11-01', '2026-10-31', '2026-11-02'],
    [SANTIAGO, '2026-09-06', '2026-09-05', '2026-09-07'],
    [KATHMANDU, '2026-08-15', '2026-08-14', '2026-08-16'],
    ['UTC', '2026-08-15', '2026-08-14', '2026-08-16']
  ];
  for (const [timeZone, target, previous, next] of pairs) {
    const period = day(target, timeZone);
    assert.strictEqual(formatDayInZone(period.from, timeZone), target, `${timeZone}: начало не в целевых сутках`);
    assert.strictEqual(formatDayInZone(period.from.getTime() - 1, timeZone), previous, `${timeZone}: до начала не предыдущие сутки`);
    assert.strictEqual(formatDayInZone(period.to, timeZone), target, `${timeZone}: конец не в целевых сутках`);
    assert.strictEqual(formatDayInZone(period.to.getTime() + 1, timeZone), next, `${timeZone}: после конца не следующие сутки`);
  }
});

check('день момента показывается по часам портала, а не по UTC', () => {
  assert.strictEqual(formatDayInZone('2026-08-15T21:30:00.000Z', MOSCOW), '2026-08-16');
  assert.strictEqual(formatDayInZone('2026-08-15T21:30:00.000Z', 'UTC'), '2026-08-15');
  assert.strictEqual(formatDateTimeInZone('2026-08-15T20:30:00.000Z', MOSCOW), '15.08.2026 23:30');
});

check('неизвестный часовой пояс не роняет расчёт, а откатывается к UTC с объяснением', () => {
  const period = resolvePeriod({ type: 'custom', from: '2026-08-15', to: '2026-08-15' }, {
    now: new Date('2026-09-01T00:00:00.000Z'),
    timeZone: 'Марс/Олимп'
  });
  assert.strictEqual(period.timeZone, 'UTC');
  assert.strictEqual(iso(period.from), '2026-08-15T00:00:00.000Z');
  assert.ok(period.notes.some((note) => note.includes('Марс/Олимп')), 'причина отката не объяснена');
});

// ── Типы периодов ────────────────────────────────────────────────────────────

check('по умолчанию открывается текущий календарный квартал портала', () => {
  const period = resolvePeriod({}, { now: new Date('2026-08-15T09:00:00.000Z'), timeZone: MOSCOW });
  assert.strictEqual(period.type, DEFAULT_PERIOD_TYPE);
  assert.strictEqual(period.key, '2026-Q3');
  assert.strictEqual(period.fromDay, '2026-07-01');
  assert.strictEqual(period.naturalToDay, '2026-09-30');
  assert.strictEqual(period.label, 'III квартал 2026');
});

check('текущий период определяется по календарю портала: в 01:00 по Москве 1 января это уже новый год', () => {
  const now = new Date('2025-12-31T22:00:00.000Z');
  const moscow = resolvePeriod({}, { now, timeZone: MOSCOW });
  assert.strictEqual(moscow.key, '2026-Q1');
  assert.strictEqual(moscow.fromDay, '2026-01-01');

  // В UTC тот же момент — ещё прошлый год: именно это расхождение и означает «сутки уехали».
  const utc = resolvePeriod({}, { now, timeZone: 'UTC' });
  assert.strictEqual(utc.key, '2025-Q4');
  assert.strictEqual(periodKeyFromDate('quarter', now, MOSCOW), '2026-Q1');
  assert.strictEqual(periodKeyFromDate('quarter', now, 'UTC'), '2025-Q4');
});

check('год смыкается с соседним без зазора и без нахлёста', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const y2026 = resolvePeriod({ type: 'year', value: '2026' }, { now, timeZone: MOSCOW });
  const y2027 = resolvePeriod({ type: 'year', value: '2027' }, { now, timeZone: MOSCOW });
  assert.strictEqual(iso(y2026.from), '2025-12-31T21:00:00.000Z');
  assert.strictEqual(iso(y2026.to), '2026-12-31T20:59:59.999Z');
  assert.strictEqual(y2027.from.getTime() - y2026.to.getTime(), 1);
  assert.strictEqual(y2026.label, '2026 год');
});

check('месяцы смыкаются без зазора, а февраль високосного года длится 29 дней', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const feb2028 = resolvePeriod({ type: 'month', value: '2028-02' }, { now, timeZone: MOSCOW });
  assert.strictEqual(feb2028.naturalToDay, '2028-02-29');
  assert.strictEqual(inPeriod('2028-02-29T12:00:00.000Z', feb2028), true);
  assert.strictEqual(inPeriod('2028-03-01T00:00:00.000Z', feb2028), false);

  const feb2026 = resolvePeriod({ type: 'month', value: '2026-02' }, { now, timeZone: MOSCOW });
  assert.strictEqual(feb2026.naturalToDay, '2026-02-28');
  const mar2026 = resolvePeriod({ type: 'month', value: '2026-03' }, { now, timeZone: MOSCOW });
  assert.strictEqual(mar2026.from.getTime() - feb2026.to.getTime(), 1);
  assert.strictEqual(feb2026.label, 'Февраль 2026');
});

check('неделя идёт с понедельника по воскресенье и не разрывается на границе года', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const week33 = resolvePeriod({ type: 'week', value: '2026-W33' }, { now, timeZone: MOSCOW });
  assert.strictEqual(week33.fromDay, '2026-08-10');
  assert.strictEqual(week33.naturalToDay, '2026-08-16');
  assert.strictEqual(week33.key, '2026-W33');

  // Неделя, разрезанная 1 января: по ISO она принадлежит году своего четверга.
  const newYearWeek = resolvePeriod({ type: 'week', value: '2026-W53' }, { now, timeZone: MOSCOW });
  assert.strictEqual(newYearWeek.fromDay, '2026-12-28');
  assert.strictEqual(newYearWeek.naturalToDay, '2027-01-03');
  assert.strictEqual(periodKeyFromDate('week', '2027-01-01T09:00:00.000Z', MOSCOW), '2026-W53');
  assert.strictEqual(inPeriod('2027-01-01T09:00:00.000Z', newYearWeek), true);
});

check('квартал охватывает три календарных месяца целиком', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const q4 = resolvePeriod({ type: 'quarter', value: '2026-Q4' }, { now, timeZone: MOSCOW });
  assert.strictEqual(q4.fromDay, '2026-10-01');
  assert.strictEqual(q4.naturalToDay, '2026-12-31');
  assert.strictEqual(iso(q4.to), '2026-12-31T20:59:59.999Z');
  assert.strictEqual(q4.label, 'IV квартал 2026');
});

// ── День ──────────────────────────────────────────────────────────────────────

check('тип периода «день» — ровно одни сутки портала с конкретной датой', () => {
  const now = new Date('2030-01-01T00:00:00.000Z');
  const period = resolvePeriod({ type: 'day', value: '2026-05-07' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.type, 'day');
  assert.strictEqual(period.key, '2026-05-07');
  assert.strictEqual(period.fromDay, '2026-05-07');
  assert.strictEqual(period.naturalToDay, '2026-05-07');
  assert.strictEqual(period.label, '07.05.2026');
  assert.strictEqual(period.to.getTime() - period.from.getTime() + 1, 24 * 3600 * 1000);
});

check('день без значения — сегодняшний день по часам портала', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'day' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.key, '2026-08-15');
  assert.strictEqual(period.clamped, true, 'сегодняшний день ещё не закончился — обязан быть обрезан текущим моментом');
});

check('битое значение дня даёт сегодняшний день, а не ошибку', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'day', value: '2026-02-31' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.key, '2026-08-15');
  assert.ok(period.notes.length > 0, 'откат не объяснён');
});

// ── Произвольный диапазон ────────────────────────────────────────────────────

check('обе даты произвольного диапазона включаются полностью', () => {
  const period = resolvePeriod({ type: 'custom', from: '2026-03-01', to: '2026-03-31' }, {
    now: new Date('2026-06-01T00:00:00.000Z'),
    timeZone: MOSCOW
  });
  assert.strictEqual(iso(period.from), '2026-02-28T21:00:00.000Z');
  assert.strictEqual(iso(period.to), '2026-03-31T20:59:59.999Z');
  // Первая и последняя миллисекунда диапазона принадлежат ему.
  assert.strictEqual(inPeriod(period.from, period), true);
  assert.strictEqual(inPeriod(period.from.getTime() - 1, period), false);
  assert.strictEqual(inPeriod(period.to, period), true);
  assert.strictEqual(inPeriod(period.to.getTime() + 1, period), false);
  assert.strictEqual(period.key, '2026-03-01..2026-03-31');
});

check('диапазон из одного дня — это ровно одни сутки портала', () => {
  const period = day('2026-05-07', MOSCOW);
  assert.strictEqual(period.to.getTime() - period.from.getTime() + 1, 24 * 3600 * 1000);
  assert.strictEqual(period.label, '07.05.2026');
});

check('конец диапазона раньше начала не роняет расчёт: границы переставляются и это объясняется', () => {
  const period = resolvePeriod({ type: 'custom', from: '2026-05-10', to: '2026-05-01' }, {
    now: new Date('2026-06-01T00:00:00.000Z'),
    timeZone: MOSCOW
  });
  assert.strictEqual(period.type, 'custom');
  assert.strictEqual(period.fromDay, '2026-05-01');
  assert.strictEqual(period.naturalToDay, '2026-05-10');
  assert.ok(period.notes.length > 0, 'перестановка границ не объяснена');
});

check('нечитаемые границы диапазона откатываются к кварталу, а не обнуляют экран', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  for (const request of [
    { type: 'custom', from: 'вчера', to: '2026-05-01' },
    { type: 'custom', from: '2026-02-31', to: '2026-05-01' },
    { type: 'custom' }
  ]) {
    const period = resolvePeriod(request, { now, timeZone: MOSCOW });
    assert.strictEqual(period.type, 'quarter', `не откатился к кварталу: ${JSON.stringify(request)}`);
    assert.strictEqual(period.key, '2026-Q3');
    assert.ok(period.notes.length > 0, 'откат не объяснён');
  }
});

// ── Обрезка будущего ─────────────────────────────────────────────────────────

check('конец периода в будущем обрезается текущим моментом', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'quarter', value: '2026-Q3' }, { now, timeZone: MOSCOW });
  assert.strictEqual(iso(period.to), '2026-08-15T09:00:00.000Z');
  assert.strictEqual(period.clamped, true);
  assert.strictEqual(inPeriod(now, period), true, 'текущий момент обязан входить в период');
  assert.strictEqual(inPeriod(now.getTime() + 1, period), false, 'будущее не должно попадать в расчёт');
});

check('обрезанный период сохраняет естественный конец для подписи', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'quarter', value: '2026-Q3' }, { now, timeZone: MOSCOW });
  // Расчёт идёт до «сейчас», а подпись показывает квартал целиком — иначе период
  // выглядит укороченным, будто данных нет.
  assert.strictEqual(iso(period.naturalTo), '2026-09-30T20:59:59.999Z');
  assert.strictEqual(period.naturalToDay, '2026-09-30');
  assert.strictEqual(period.toDay, '2026-08-15');
  assert.strictEqual(period.label, 'III квартал 2026');
});

check('завершённый период не обрезается и не помечается обрезанным', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'quarter', value: '2026-Q1' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.clamped, false);
  assert.strictEqual(period.to.getTime(), period.naturalTo.getTime());
  assert.strictEqual(iso(period.to), '2026-03-31T20:59:59.999Z');
});

check('период целиком в будущем даёт пустой расчёт, а не отрицательный диапазон', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'quarter', value: '2027-Q1' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.empty, true);
  assert.strictEqual(inPeriod(now, period), false);
  assert.strictEqual(inPeriod('2027-02-01T00:00:00.000Z', period), false);
});

// ── Вся история ──────────────────────────────────────────────────────────────

check('«Вся история» не имеет нижней границы, верхняя — текущий момент', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'allHistory' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.from, null);
  assert.strictEqual(period.naturalFrom, null);
  assert.strictEqual(period.fromDay, null);
  assert.strictEqual(iso(period.to), '2026-08-15T09:00:00.000Z');
  assert.strictEqual(period.clamped, false);
  assert.strictEqual(period.empty, false);
  assert.strictEqual(inPeriod('2011-03-04T00:00:00.000Z', period), true, 'старое событие обязано войти в историю');
  assert.strictEqual(inPeriod(now, period), true);
  assert.strictEqual(inPeriod('2026-08-15T09:00:00.001Z', period), false, 'будущее в историю не входит');
});

check('«Вся история» распознаётся в написаниях, приходящих из строки запроса', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  for (const type of ['allHistory', 'all-history', 'ALL_HISTORY', 'all']) {
    const period = resolvePeriod({ periodType: type }, { now, timeZone: MOSCOW });
    assert.strictEqual(period.type, 'allHistory', `не распознан тип «${type}»`);
    assert.strictEqual(period.key, 'all');
  }
});

// ── Устойчивость входа ───────────────────────────────────────────────────────

check('неизвестный тип периода откатывается к кварталу и объясняет причину', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ type: 'декада' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.type, 'quarter');
  assert.strictEqual(period.key, '2026-Q3');
  assert.ok(period.notes.some((note) => note.includes('декада')), 'причина отката не названа');
});

check('битое значение периода даёт текущий период того же типа, а не ошибку', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const month = resolvePeriod({ type: 'month', value: 'вчера' }, { now, timeZone: MOSCOW });
  assert.strictEqual(month.type, 'month');
  assert.strictEqual(month.key, '2026-08');
  assert.ok(month.notes.length > 0);

  const week = resolvePeriod({ type: 'week', value: '2026-W99' }, { now, timeZone: MOSCOW });
  assert.strictEqual(week.type, 'week');
  assert.strictEqual(week.key, '2026-W33');
});

check('параметры периода принимаются в том виде, в каком приходят от сервера', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const period = resolvePeriod({ periodType: 'month', periodValue: '2026-07' }, { now, timeZone: MOSCOW });
  assert.strictEqual(period.key, '2026-07');
  assert.strictEqual(period.fromDay, '2026-07-01');
  assert.strictEqual(period.naturalToDay, '2026-07-31');
});

check('каждый объявленный тип периода действительно поддерживается', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  assert.deepStrictEqual([...PERIOD_TYPES], ['day', 'week', 'month', 'quarter', 'year', 'custom', 'allHistory']);
  for (const type of PERIOD_TYPES) {
    // Произвольный диапазон без дат осмысленно откатывается к кварталу — это отдельная проверка.
    const request = type === 'custom' ? { type, from: '2026-05-01', to: '2026-05-31' } : { type };
    const period = resolvePeriod(request, { now, timeZone: MOSCOW });
    assert.strictEqual(period.type, type, `тип «${type}» объявлен, но не посчитан`);
    assert.ok(period.to instanceof Date, `у типа «${type}» нет верхней границы`);
    assert.ok(!period.notes.some((note) => note.includes('Неизвестный тип')), `тип «${type}» не распознан`);
  }
});

check('момент без даты не попадает ни в один период', () => {
  const period = day('2026-08-15', MOSCOW);
  for (const value of [null, undefined, '', 'позавчера', {}, Number.NaN]) {
    assert.strictEqual(inPeriod(value, period), false, `значение ${JSON.stringify(value)} посчиталось датой`);
  }
});

check('расчёт одного и того же периода не зависит от порядка вызовов', () => {
  const now = new Date('2026-08-15T09:00:00.000Z');
  const first = resolvePeriod({ type: 'quarter', value: '2026-Q3' }, { now, timeZone: MOSCOW });
  resolvePeriod({ type: 'year', value: '2026' }, { now, timeZone: NEW_YORK });
  const second = resolvePeriod({ type: 'quarter', value: '2026-Q3' }, { now, timeZone: MOSCOW });
  assert.deepStrictEqual(
    [iso(first.from), iso(first.to), first.key],
    [iso(second.from), iso(second.to), second.key]
  );
});

check('период нельзя испортить снаружи: результат заморожен', () => {
  const period = day('2026-08-15', MOSCOW);
  assert.throws(() => {
    'use strict';
    period.to = new Date(0);
  });
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
  console.error(`${failed}/${cases.length} проверок периода упало`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed: cases.length }));
