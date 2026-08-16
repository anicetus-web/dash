/**
 * Проверки XLSX-выгрузки.
 *
 * Ядро проверки — настоящий unzip: файл распаковывается своим же читателем
 * (без внешних библиотек, как и сам генератор), и содержимое частей сверяется
 * с результатом расчётного модуля для того же запроса. Проверка того, что архив
 * «открылся», ничего не доказывает — доказывает только совпадение чисел.
 */

import assert from 'node:assert';
import { inflateRawSync } from 'node:zlib';
import { generateDemoSnapshot } from '../src/demo/generator.js';
import { calculateDashboard } from '../src/analytics/dashboard.js';
import { getFullStageRows, stageReference } from '../src/analytics/details.js';
import { buildDashboardReport } from '../src/export/report.js';
import { escapeXml, zipSync } from '../src/export/xlsx.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const TZ = 'Europe/Moscow';
const REQUEST = { mode: 'static', periodType: 'year', periodValue: '2026' };
const OPTIONS = { now: NOW, timeZone: TZ, portalUrl: 'https://portal.example.bitrix24.ru' };

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log('ok:', name);
  } catch (error) {
    failed += 1;
    console.error('FAIL:', name, '→', error.message);
  }
};

// ── Минимальный читатель ZIP (обратный к src/export/xlsx.js#zipSync) ──────────
// Без внешних библиотек, как и сам генератор: проверка обязана уметь то же,
// что и любой настоящий распаковщик, а не полагаться на доверие к записывающей стороне.

function readZip(buffer) {
  const eocd = buffer.subarray(buffer.length - 22);
  assert.strictEqual(eocd.readUInt32LE(0), 0x06054b50, 'нет сигнатуры конца центрального каталога');
  const totalEntries = eocd.readUInt16LE(10);
  const centralDirOffset = eocd.readUInt32LE(16);

  const entries = {};
  let pointer = centralDirOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    assert.strictEqual(buffer.readUInt32LE(pointer), 0x02014b50, `запись ${i}: нет сигнатуры центрального каталога`);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength;

    assert.strictEqual(buffer.readUInt32LE(localHeaderOffset), 0x04034b50, `${name}: нет сигнатуры локального заголовка`);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.strictEqual(data.length, uncompressedSize, `${name}: длина после распаковки не совпадает с заявленной`);
    entries[name] = data.toString('utf8');
  }
  return entries;
}

/** Текст всех инлайновых строковых ячеек листа — без разбора полного XML. */
function inlineStrings(sheetXmlText) {
  return [...sheetXmlText.matchAll(/<is><t[^>]*>([\s\S]*?)<\/t><\/is>/g)].map((m) => m[1]);
}

/** Числовые значения ячеек с данным индексом стиля (`s="N"`). */
function numbersWithStyle(sheetXmlText, style) {
  const re = new RegExp(`<c r="[A-Z]+\\d+" s="${style}"><v>([^<]+)<\\/v></c>`, 'g');
  return [...sheetXmlText.matchAll(re)].map((m) => Number(m[1]));
}

/**
 * Значения указанной колонки по всем строкам листа. Нужен именно разбор по
 * колонке, а не поиск подстроки по всему листу: значение может законно
 * встретиться в ДРУГОЙ колонке той же строки (например, «Взят в работу»
 * одновременно название ступени и текущий этап сущности, которая сейчас
 * на ней стоит) — плоский поиск такие совпадения задваивает.
 */
function columnValues(sheetXmlText, columnLetter) {
  const cellRe = new RegExp(`<c r="${columnLetter}\\d+"[^>]*><is><t[^>]*>([\\s\\S]*?)<\\/t><\\/is></c>`, 'g');
  return [...sheetXmlText.matchAll(cellRe)].map((m) => m[1]);
}

// ── Сборка книги ────────────────────────────────────────────────────────────

const snapshot = generateDemoSnapshot({ seed: 20260815, now: NOW, timeZone: TZ });
const { buffer, fileName, dashboard, registryRowCount } = buildDashboardReport(snapshot, REQUEST, OPTIONS);
const zip = readZip(buffer);

// ── Структура архива ──────────────────────────────────────────────────────────

check('файл распаковывается как корректный ZIP и содержит обязательные части', () => {
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.ok(part in zip, `в архиве нет части «${part}»`);
  }
});

check('книга объявляет ровно два листа: Сводка и Реестр', () => {
  assert.match(zip['xl/workbook.xml'], /<sheet name="Сводка"/);
  assert.match(zip['xl/workbook.xml'], /<sheet name="Реестр"/);
});

check('имя файла отражает срез и дату', () => {
  assert.match(fileName, /^voronka-2026-static-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

check('каждый лист — разбираемый XML с декларацией и корневым узлом', () => {
  for (const name of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
    assert.match(zip[name], /^<\?xml version="1\.0"/);
    assert.match(zip[name], /<worksheet[^>]*>[\s\S]*<\/worksheet>$/);
  }
});

// ── Экранирование ──────────────────────────────────────────────────────────────

check('спецсимволы в тексте экранируются, а не ломают XML', () => {
  const sample = 'ООО «Ромашка & Ко» <опасно> "кавычки"';
  const escaped = escapeXml(sample);
  assert.ok(!escaped.includes('&<') && !/[^&]<опасно/.test(escaped), 'угловые скобки не экранированы');
  assert.match(escaped, /&amp;/);
  assert.match(escaped, /&lt;опасно&gt;/);
  assert.match(escaped, /&quot;кавычки&quot;/);
  // Тот же текст, пропущенный через полную сборку книги — с юникодной сущностью
  // и переводом строки, встречающимися в реальных названиях компаний.
  const withEntity = zipSync([{ name: 'x.xml', data: `<v>${escapeXml('А&Б\nВ')}</v>` }]);
  assert.ok(withEntity.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'архив с экранированным текстом не собрался');
});

check('название компании с амперсандом не ломает лист реестра', () => {
  assert.ok(!/[^d]&(?!amp;|lt;|gt;|quot;|apos;|#)/.test(zip['xl/worksheets/sheet2.xml']), 'найден неэкранированный «&» в реестре');
});

// ── Числа и даты как значения, а не текст ────────────────────────────────────

check('числа ступеней записаны как числа, а не как текст', () => {
  const integers = numbersWithStyle(zip['xl/worksheets/sheet1.xml'], 7); // STYLES.integer
  assert.ok(integers.length > 0, 'в «Сводке» не найдено ни одной числовой ячейки счётчика');
  const stageCounts = dashboard.stages.map((s) => s.count).sort((a, b) => a - b);
  const found = integers.filter((n) => stageCounts.includes(n)).sort((a, b) => a - b);
  assert.ok(found.length >= dashboard.stages.length, 'не все количества ступеней нашлись как числовые ячейки');
});

check('даты в «Сводке» записаны как число (сериал Excel), а не как текст', () => {
  const dates = numbersWithStyle(zip['xl/worksheets/sheet1.xml'], 5); // STYLES.dateTime
  assert.ok(dates.length >= 1, 'дата формирования выгрузки не найдена как числовая ячейка');
  // Сериал Excel для 2026 года — трёхзначное число выше 46000; текстовая дата
  // в кавычках сюда никогда бы не попала — этот тест ловит именно подмену типа.
  assert.ok(dates.every((n) => n > 46000 && n < 47000), 'значение не похоже на сериал Excel для 2026 года');
});

check('дата в «Сводке» показывает календарный день ПОРТАЛА, а не UTC-день (момент около полуночи по Москве)', () => {
  // Excel не хранит часовой пояс — сериал строится из голого момента. Момент ниже
  // ДО полуночи по UTC, но уже ПОСЛЕ полуночи по Москве (UTC+3) — ровно та зона,
  // где старый баг (сериал строился из сырого UTC-момента) молча показывал бы
  // предыдущий календарный день.
  const midnightNow = new Date('2026-08-15T21:30:00.000Z'); // Москва: 2026-08-16 00:30
  const report = buildDashboardReport(snapshot, REQUEST, { ...OPTIONS, now: midnightNow });
  const sheet = readZip(report.buffer)['xl/worksheets/sheet1.xml'];
  const dates = numbersWithStyle(sheet, 5); // STYLES.dateTime
  assert.ok(dates.length >= 1, 'дата формирования выгрузки не найдена');

  const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
  const decoded = new Date(Math.round(EXCEL_EPOCH_MS + dates[0] * 24 * 60 * 60 * 1000));
  assert.strictEqual(decoded.getUTCFullYear(), 2026);
  assert.strictEqual(decoded.getUTCMonth(), 7, 'месяц (0-индекс) не совпал — ожидался август');
  assert.strictEqual(decoded.getUTCDate(), 16, 'выгрузка должна показать 16 августа по Москве, а не 15-е по UTC');
});

// ── ГЛАВНАЯ ПРОВЕРКА: числа совпадают с расчётным модулем для того же запроса ──

check('числа «Сводки» совпадают с calculateDashboard для того же запроса', () => {
  const fresh = calculateDashboard(snapshot, REQUEST, OPTIONS);
  const sheet1 = zip['xl/worksheets/sheet1.xml'];

  const integerCells = numbersWithStyle(sheet1, 7);
  for (const stage of fresh.stages) {
    assert.ok(integerCells.includes(stage.count), `количество ступени «${stage.name}» (${stage.count}) не найдено в «Сводке»`);
  }

  const percentCells = numbersWithStyle(sheet1, 6); // STYLES.percent — литеральный формат, значения БЕЗ деления на 100
  assert.ok(
    percentCells.some((value) => Math.abs(value - fresh.primaryConversion.value) < 0.05),
    `главная конверсия ${fresh.primaryConversion.value}% не найдена в «Сводке» — проверь, что значение не поделено на 100 лишний раз`
  );

  const strings = inlineStrings(sheet1);
  assert.ok(strings.includes(fresh.appliedRequest.period.label), 'подпись периода в «Сводке» не совпадает с расчётом');
});

// ── Согласованность «Реестра» с детализацией ─────────────────────────────────

check('строк «Реестра» ровно столько, сколько сумма количеств по всем ступеням', () => {
  const expected = dashboard.stages.reduce((sum, stage) => sum + stage.count, 0);
  assert.strictEqual(registryRowCount, expected);
});

check('каждая ступень представлена в «Реестре» тем же числом строк, что и детализация без обрезки', () => {
  // Колонка C — «Ступень» (заголовки: A ID, B Тип, C Ступень, D Название, ...).
  const stageColumn = columnValues(zip['xl/worksheets/sheet2.xml'], 'C');
  const counts = new Map();
  for (const name of stageColumn) counts.set(name, (counts.get(name) || 0) + 1);

  for (const stage of stageReference()) {
    const full = getFullStageRows(snapshot, { ...REQUEST, stageRole: stage.role }, OPTIONS);
    const found = counts.get(full.stage.name) || 0;
    assert.strictEqual(found, full.count, `ступень «${full.stage.name}»: в колонке «Ступень» реестра ${found} строк, ожидалось ${full.count}`);
  }
});

check('«Реестр» не пуст на непустом снимке', () => {
  assert.ok(registryRowCount > 0);
});

// ── Контактные данные отсутствуют ────────────────────────────────────────────

check('в выгрузке нет телефонов, email и комментариев', () => {
  // «Защита по телефону» — легитимное значение справочника форматов КЭВ (спека),
  // не контактные данные. Чёрный список по подстроке «телефон» ловил бы этот
  // бизнес-термин как ложное срабатывание — ищем признаки самих контактов:
  // заголовки соответствующих колонок и похожие на номер телефона цифровые цепочки.
  const header = inlineStrings(zip['xl/worksheets/sheet1.xml']).concat(inlineStrings(zip['xl/worksheets/sheet2.xml']));
  for (const forbidden of ['Телефон', 'Email', 'E-mail', 'Комментарий', 'Комментарии']) {
    assert.ok(!header.includes(forbidden), `в выгрузке есть колонка «${forbidden}»`);
  }
  const haystack = zip['xl/worksheets/sheet1.xml'] + zip['xl/worksheets/sheet2.xml'];
  assert.ok(!haystack.includes('@'), 'в выгрузке найден символ «@» — похоже на email');
  assert.ok(
    !/(?:\+7|\b8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}\b/.test(haystack),
    'в выгрузке найдена последовательность цифр, похожая на номер телефона'
  );
});

// ── Соответствие текущему срезу и режиму ─────────────────────────────────────

check('выгрузка в режиме Динамики отражает динамические числа, а не статические', () => {
  const dynamicRequest = { mode: 'dynamic', periodType: 'year', periodValue: '2026' };
  const dynamicReport = buildDashboardReport(snapshot, dynamicRequest, OPTIONS);
  const dynamicDashboard = calculateDashboard(snapshot, dynamicRequest, OPTIONS);

  assert.strictEqual(dynamicReport.dashboard.appliedRequest.mode, 'dynamic');
  assert.strictEqual(dynamicReport.registryRowCount, dynamicDashboard.stages.reduce((sum, stage) => sum + stage.count, 0));

  // Статика и Динамика — разные расчёты (спека, Режим Статики vs Режим Динамики):
  // числа обязаны отличаться хотя бы на одной ступени, иначе выгрузка молча
  // проигнорировала параметр mode и всегда строится по одному и тому же режиму.
  const differs = dynamicDashboard.stages.some((stage, i) => stage.count !== dashboard.stages[i].count);
  assert.ok(differs, 'Статика и Динамика дали идентичные числа — mode не влияет на выгрузку');
});

check('фильтр сужает выгрузку так же, как API', () => {
  const kevId = [...snapshot.kevFormats][0]?.id;
  assert.ok(kevId, 'в демо-снимке нет форматов КЭВ для проверки фильтра');
  const filtered = { ...REQUEST, kevFormats: kevId };
  const filteredDashboard = calculateDashboard(snapshot, filtered, OPTIONS);
  const filteredReport = buildDashboardReport(snapshot, filtered, OPTIONS);
  const expected = filteredDashboard.stages.reduce((sum, stage) => sum + stage.count, 0);
  assert.strictEqual(filteredReport.registryRowCount, expected);
});

if (failed > 0) {
  console.error(`\n${failed} проверок XLSX-выгрузки упало`);
  process.exit(1);
}
console.log('\nПроверки XLSX-выгрузки пройдены');
