// Проверки масштаба графиков динамики (src/analytics/timeBuckets.js).
//
// Масштаб задан заказчиком поштучно на каждый тип периода, и именно здесь
// ошибка не видна ни в одном другом наборе: воронка и конверсии считаются
// верно, а график молча рисует не тот отрезок времени. Каждая проверка —
// утверждение о правиле, а не о вызове функции; «сейчас» всегда передаётся
// параметром, иначе результат зависел бы от дня запуска.
import assert from 'node:assert';
import { resolvePeriod } from '../src/domain/period.js';
import { resolveBucketWindows } from '../src/analytics/timeBuckets.js';

const MOSCOW = 'Europe/Moscow';
const BERLIN = 'Europe/Berlin';

const cases = [];
function check(name, run) {
  cases.push([name, run]);
}

function windows(request, { now, timeZone = MOSCOW }) {
  const period = resolvePeriod(request, { now, timeZone });
  return resolveBucketWindows(period, { now, timeZone });
}

function labels(list) {
  return list.map((bucket) => bucket.label);
}

// Бакеты не должны ни перекрываться, ни выходить за границы периода.
function assertInsidePeriod(list, request, { now, timeZone = MOSCOW }) {
  const period = resolvePeriod(request, { now, timeZone });
  const limit = (period.naturalTo || period.to).getTime();
  for (const bucket of list) {
    assert.ok(bucket.fromMs <= bucket.toMs, `бакет «${bucket.label}» вывернут наизнанку`);
    assert.ok(
      bucket.fromMs <= limit,
      `бакет «${bucket.label}» начинается за концом периода`
    );
  }
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(
      list[i].fromMs > list[i - 1].toMs,
      `бакеты «${list[i - 1].label}» и «${list[i].label}» перекрываются`
    );
  }
}

// ── День: по часам ───────────────────────────────────────────────────────────

check('день рисуется по часам, а не по дням', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const list = windows({ type: 'day', value: '2026-08-10' }, { now });
  assert.strictEqual(list.length, 24, `часов в сутках ${list.length}, а не 24`);
  assert.deepStrictEqual([list[0].label, list[23].label], ['00:00', '23:00']);
  assertInsidePeriod(list, { type: 'day', value: '2026-08-10' }, { now });
});

check('сутки с переводом стрелок дают столько часов, сколько в них есть', () => {
  // Берлин: 25 часов в день осеннего перевода и 23 — весеннего.
  const now = new Date('2026-12-31T00:00:00.000Z');
  const autumn = windows({ type: 'day', value: '2026-10-25' }, { now, timeZone: BERLIN });
  assert.strictEqual(autumn.length, 25, `осенний перевод: часов ${autumn.length}, ожидалось 25`);

  const spring = windows({ type: 'day', value: '2026-03-29' }, { now, timeZone: BERLIN });
  assert.strictEqual(spring.length, 23, `весенний перевод: часов ${spring.length}, ожидалось 23`);
  // Подписи берутся у самой зоны: в 23-часовые сутки часа 02:00 не существует.
  assert.ok(!labels(spring).includes('02:00'), 'подписан несуществующий час 02:00');
  assert.strictEqual(spring[spring.length - 1].label, '23:00');

  // Последний бакет обязан доходить до конца суток портала — иначе час данных теряется.
  const period = resolvePeriod({ type: 'day', value: '2026-10-25' }, { now, timeZone: BERLIN });
  assert.strictEqual(autumn[autumn.length - 1].toMs, period.to.getTime(), 'осенний перевод: потерян последний час');
});

check('один день, выбранный произвольным диапазоном, рисуется так же, как быстрый «День»', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const quick = windows({ type: 'day', value: '2026-08-10' }, { now });
  const manual = windows({ type: 'custom', from: '2026-08-10', to: '2026-08-10' }, { now });
  assert.deepStrictEqual(labels(manual), labels(quick), 'два пути к одному дню дают разные графики');
});

// ── Неделя: последние 7 дней ─────────────────────────────────────────────────

check('неделя рисуется по своим семи дням', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const request = { type: 'custom', from: '2026-08-03', to: '2026-08-09' };
  const list = windows(request, { now });
  assert.strictEqual(list.length, 7, `дней в неделе ${list.length}, а не 7`);
  assert.deepStrictEqual(labels(list), ['03.08', '04.08', '05.08', '06.08', '07.08', '08.08', '09.08']);
  assertInsidePeriod(list, request, { now });
});

check('тип периода «неделя» рисуется по дням, а не двенадцатью неделями', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const list = windows({ type: 'week', value: '2026-W32' }, { now });
  assert.strictEqual(list.length, 7);
  assert.strictEqual(list[0].label, '03.08');
});

check('текущая неделя остаётся недельным масштабом, а не превращается в тренд', () => {
  // Среда: четыре дня недели ещё не наступили, период обрезан «сейчас».
  const now = new Date('2026-08-19T12:00:00.000Z');
  const request = { type: 'custom', from: '2026-08-17', to: '2026-08-23' };
  const list = windows(request, { now });
  assert.ok(list.length > 0 && list.length <= 7, `бакетов ${list.length}, ожидались дни недели`);
  assert.strictEqual(list[0].label, '17.08', 'неделя перестала рисоваться по дням');
  for (const bucket of list) {
    assert.ok(bucket.fromMs <= now.getTime(), `бакет «${bucket.label}» лежит в будущем`);
  }
});

check('короткий произвольный диапазон не рисует лишний день за своим концом', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  for (const [from, to, expected] of [
    ['2026-08-03', '2026-08-04', 2],
    ['2026-08-03', '2026-08-05', 3],
    ['2026-08-03', '2026-08-08', 6]
  ]) {
    const request = { type: 'custom', from, to };
    const list = windows(request, { now });
    assert.strictEqual(list.length, expected, `${from}..${to}: бакетов ${list.length}, ожидалось ${expected}`);
    assertInsidePeriod(list, request, { now });
  }
});

// ── Месяц и квартал: последние 12 недель ─────────────────────────────────────

check('месяц и квартал рисуются двенадцатью неделями', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const month = windows({ type: 'month', value: '2026-08' }, { now });
  const quarter = windows({ type: 'quarter', value: '2026-Q3' }, { now });
  assert.strictEqual(month.length, 12, `месяц: бакетов ${month.length}, ожидалось 12`);
  assert.strictEqual(quarter.length, 12, `квартал: бакетов ${quarter.length}, ожидалось 12`);
});

check('недели графика — понедельник–воскресенье и не зависят от дня открытия', () => {
  // Один и тот же месяц, открытый в разные дни недели, обязан дать одни и те же недели.
  const wednesday = windows({ type: 'month', value: '2026-07' }, { now: new Date('2026-08-19T10:00:00.000Z') });
  const saturday = windows({ type: 'month', value: '2026-07' }, { now: new Date('2026-08-22T10:00:00.000Z') });
  assert.deepStrictEqual(labels(wednesday), labels(saturday), 'границы недель поехали от дня открытия');

  // Каждый бакет длится ровно семь суток портала.
  for (const bucket of wednesday) {
    const days = Math.round((bucket.toMs - bucket.fromMs + 1) / (24 * 60 * 60 * 1000));
    assert.strictEqual(days, 7, `бакет «${bucket.label}» длится ${days} суток вместо семи`);
  }
});

// ── Год: по месяцам ──────────────────────────────────────────────────────────

check('год рисуется месяцами ЭТОГО года, а не последними двенадцатью', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const current = windows({ type: 'year', value: '2026' }, { now });
  assert.strictEqual(current[0].label, 'янв 2026', `первый месяц «${current[0].label}», а не январь года`);
  // Будущие месяцы не рисуются: их нечем наполнить.
  assert.strictEqual(current[current.length - 1].label, 'авг 2026');
  for (const bucket of current) {
    assert.ok(bucket.label.endsWith('2026'), `в графике 2026 года затесался «${bucket.label}»`);
  }

  const past = windows({ type: 'year', value: '2025' }, { now });
  assert.strictEqual(past.length, 12, `завершённый год: месяцев ${past.length}, ожидалось 12`);
  assert.deepStrictEqual([past[0].label, past[11].label], ['янв 2025', 'дек 2025']);
});

// ── Общие инварианты ─────────────────────────────────────────────────────────

check('бакеты идут по возрастанию времени и не перекрываются ни на одном типе периода', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  for (const request of [
    { type: 'day', value: '2026-08-10' },
    { type: 'week', value: '2026-W32' },
    { type: 'month', value: '2026-08' },
    { type: 'quarter', value: '2026-Q3' },
    { type: 'year', value: '2026' },
    { type: 'custom', from: '2026-01-01', to: '2026-06-30' }
  ]) {
    const list = windows(request, { now });
    assert.ok(list.length > 0, `тип «${request.type}» не дал ни одного бакета`);
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(
        list[i].fromMs > list[i - 1].toMs,
        `тип «${request.type}»: бакеты «${list[i - 1].label}» и «${list[i].label}» перекрываются`
      );
    }
    for (const bucket of list) {
      assert.ok(bucket.fromMs <= now.getTime(), `тип «${request.type}»: бакет «${bucket.label}» в будущем`);
    }
  }
});

check('период целиком в будущем не даёт ни одного бакета вместо выдуманных нулей', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const list = windows({ type: 'day', value: '2027-01-01' }, { now });
  assert.strictEqual(list.length, 0, 'нарисованы бакеты для дня, который ещё не наступил');
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
  console.error(`${failed}/${cases.length} проверок масштаба графиков упало`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed: cases.length }));
