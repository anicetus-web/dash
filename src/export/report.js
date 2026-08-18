/**
 * Сборка листов XLSX из результата расчётного модуля.
 *
 * Формул здесь нет (инвариант 9): «Сводка» — это дословная упаковка результата
 * `calculateDashboard`, «Реестр» построчно разворачивает `getFullStageRows`
 * по каждой ступени сквозной последовательности. Числа совпадают с интерфейсом
 * по конструкции — оба места читают один и тот же расчёт для одного и того же запроса.
 */

import { formatDateTimeInZone, wallClockAsUtc } from '../domain/period.js';
import { calculateDashboard, computeSlice } from '../analytics/dashboard.js';
import { getFullStageRows, stageReference } from '../analytics/details.js';
import { buildIndex } from '../analytics/snapshot.js';
import { STYLES, buildWorkbook, dateCell, headerCell, labelCell, numberCell, textCell } from './xlsx.js';

const UNIT_LABEL = Object.freeze({ company: 'Компания', deal: 'Сделка' });

function joinNames(ids, dictionary, emptyLabel) {
  if (!ids || ids.length === 0) return emptyLabel;
  return ids.map((id) => dictionary.get(id) || id).join(', ');
}

function row(...cells) {
  return cells;
}

/**
 * Лист «Сводка»: параметры среза, свежесть данных, ступени, конверсии, предупреждения.
 * Ровно то, что показывает шапка и воронка на экране — переупакованное построчно.
 */
function summarySheet(dashboard, index, options) {
  const period = dashboard.appliedRequest.period;
  const filters = dashboard.appliedRequest.filters;
  const rows = [];

  rows.push(row(headerCell('Сводка среза')));
  rows.push([]);
  rows.push(row(labelCell('Режим'), textCell(dashboard.appliedRequest.mode === 'dynamic' ? 'Динамика' : 'Статика')));
  rows.push(row(labelCell('Период'), textCell(period.label)));
  rows.push(row(
    labelCell('Диапазон расчёта'),
    textCell(period.from ? `${formatDateTimeInZone(period.from, period.timeZone)} — ${formatDateTimeInZone(period.to, period.timeZone)}` : `по ${formatDateTimeInZone(period.to, period.timeZone)}`)
  ));
  if (period.clamped) {
    rows.push(row(labelCell(''), textCell('Период ещё не закончился — расчёт выполнен по текущий момент.')));
  }
  rows.push(row(labelCell('Часовой пояс портала'), textCell(period.timeZone)));
  rows.push(row(labelCell('База'), textCell(joinNames(filters.sourceIds, index.sources, 'Все'))));
  rows.push(row(labelCell('Менеджер'), textCell(joinNames(filters.managerIds, index.managers, 'Все'))));
  rows.push(row(labelCell('Формат КЭВ'), textCell(joinNames(filters.kevFormats, index.kevFormats, 'Все — фильтр относится только ко второй воронке'))));
  rows.push([]);
  // Excel не хранит часовой пояс — сериал строится из UTC-полей Date (xlsx.js).
  // Настоящий UTC-момент напрямую сюда передавать нельзя: рядом с полуночью
  // портала это меняет и сам календарный день, не только время (wallClockAsUtc).
  rows.push(row(labelCell('Дата формирования выгрузки'), dateCell(wallClockAsUtc(options.now || new Date(), period.timeZone), STYLES.dateTime)));
  rows.push(row(
    labelCell('Дата последней синхронизации'),
    dashboard.freshness.lastSuccessAt ? dateCell(wallClockAsUtc(dashboard.freshness.lastSuccessAt, period.timeZone), STYLES.dateTime) : textCell('ещё не выполнялась')
  ));
  rows.push(row(labelCell('Свежесть данных'), textCell(dashboard.freshness.stale ? 'Данные устарели' : 'Актуальны')));
  // Источник данных — обязательная строка выгрузки: файл уходит из приложения
  // и живёт своей жизнью (почта, мессенджер, печать). Без пометки демо-выгрузка
  // выглядит как обычный отчёт по отделу, и её цифры можно принять за реальные.
  rows.push(row(
    labelCell('Источник данных'),
    textCell(dashboard.freshness.source === 'demo'
      ? 'ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ — цифры сгенерированы, портал не подключён'
      : 'Битрикс24 (портал)')
  ));
  rows.push([]);

  rows.push(row(headerCell('Ступень'), headerCell('Воронка'), headerCell('Ед. учёта'), headerCell('Количество'), headerCell('Конверсия к пред.'), headerCell('Доп. счётчик')));
  for (const stage of dashboard.stages) {
    rows.push(row(
      textCell(`${stage.position + 1}. ${stage.name}`),
      textCell(stage.funnelId === 'companies' ? 'Компании' : 'Сделки'),
      textCell(UNIT_LABEL[stage.unit] || stage.unit),
      numberCell(stage.count, STYLES.integer),
      stage.conversionFromPrevious === null ? textCell('—') : numberCell(stage.conversionFromPrevious, STYLES.percent),
      stage.junction ? textCell(`из ${stage.companyCount} компаний`) : textCell('')
    ));
  }
  rows.push([]);

  const primary = dashboard.primaryConversion;
  rows.push(row(headerCell('Главная конверсия'), textCell(`${primary.fromName} → ${primary.toName}`)));
  rows.push(row(
    labelCell(''),
    primary.available ? numberCell(primary.value, STYLES.percent) : textCell('0% — нет исходных сущностей'),
    textCell(`${primary.toCount} из ${primary.fromCount}`)
  ));

  const selected = dashboard.selectedConversion;
  if (selected && !selected.error) {
    rows.push([]);
    rows.push(row(headerCell('Выбранная конверсия'), textCell(`${selected.fromName} → ${selected.toName}`)));
    rows.push(row(
      labelCell(''),
      selected.available ? numberCell(selected.value, STYLES.percent) : textCell('0% — нет исходных сущностей'),
      textCell(selected.note || '')
    ));
    if (selected.secondary) {
      rows.push(row(
        labelCell('Дополнительно'),
        selected.secondary.available ? numberCell(selected.secondary.value, STYLES.percent) : textCell('0%'),
        textCell(selected.secondary.note || '')
      ));
    }
  }
  rows.push([]);

  rows.push(row(headerCell('Компаний в срезе'), headerCell('Потребностей'), headerCell('Сделок')));
  rows.push(row(
    numberCell(dashboard.totals.companies, STYLES.integer),
    numberCell(dashboard.totals.needs, STYLES.integer),
    numberCell(dashboard.totals.deals, STYLES.integer)
  ));

  if (dashboard.warnings.length > 0) {
    rows.push([]);
    rows.push(row(headerCell('Предупреждения о качестве данных')));
    for (const warning of dashboard.warnings) rows.push(row(textCell(warning.message, STYLES.wrap)));
  }

  return {
    name: 'Сводка',
    rows,
    columns: [{ width: 30 }, { width: 34 }, { width: 20 }, { width: 16 }, { width: 18 }, { width: 30 }]
  };
}

/**
 * Лист «Реестр»: одна строка — одно прохождение сущностью одной ступени.
 * Обезличен по требованию спеки: телефонов, email и комментариев здесь нет.
 */
function registrySheet(snapshot, request, options, timeZone) {
  // Один срез на ВСЕ ступени вместо одного на каждую (~16): getFullStageRows
  // раньше пересчитывал воронку с нуля на каждой итерации цикла ниже — тот же
  // snapshot/request/options, ~16 полных пересчётов вместо одного общего.
  const slice = computeSlice(snapshot, request, options);
  const header = row(
    headerCell('ID'), headerCell('Тип'), headerCell('Ступень'), headerCell('Название'),
    headerCell('Компания'), headerCell('База'), headerCell('Менеджер'), headerCell('Формат КЭВ'),
    headerCell('Текущий этап'), headerCell('Отказ'), headerCell('Дата перехода'), headerCell('Ссылка')
  );

  const rows = [header];
  let totalRows = 0;

  for (const stage of stageReference()) {
    const details = getFullStageRows(snapshot, { ...request, stageRole: stage.role }, options, slice);
    totalRows += details.count;
    for (const entry of details.rows) {
      rows.push(row(
        textCell(entry.id),
        textCell(UNIT_LABEL[entry.entityType] || entry.entityType),
        textCell(stage.name),
        textCell(entry.title),
        textCell(entry.companyTitle || ''),
        textCell(entry.sourceName),
        textCell(entry.managerName),
        textCell(entry.kevFormatName || ''),
        textCell(entry.currentStageName),
        textCell(entry.isLost ? 'Да' : ''),
        entry.stageAt ? dateCell(wallClockAsUtc(entry.stageAt, timeZone), STYLES.date) : textCell(''),
        textCell(entry.url || '')
      ));
    }
  }

  return {
    name: 'Реестр',
    rows,
    freezeHeader: true,
    autoFilter: rows.length > 1 ? `A1:L${rows.length}` : null,
    columns: [
      { width: 10 }, { width: 10 }, { width: 26 }, { width: 34 }, { width: 28 },
      { width: 22 }, { width: 20 }, { width: 20 }, { width: 22 }, { width: 8 },
      { width: 16 }, { width: 40 }
    ],
    totalRows
  };
}

/**
 * Книга XLSX для текущего среза.
 *
 * @param {object} snapshot нормализованный снимок
 * @param {object} request  тот же срез, что у дашборда (mode/period/filters/conversion)
 * @param {object} options  {now, timeZone, portalUrl}
 * @returns {{buffer: Buffer, fileName: string}}
 */
export function buildDashboardReport(snapshot, request = {}, options = {}) {
  const dashboard = calculateDashboard(snapshot, request, options);
  const index = buildIndex(snapshot);

  const summary = summarySheet(dashboard, index, options);
  const registry = registrySheet(snapshot, request, options, dashboard.appliedRequest.period.timeZone);

  const buffer = buildWorkbook([summary, registry], { modified: options.now });

  const stamp = (options.now || new Date()).toISOString().slice(0, 10);
  const fileName = `voronka-${dashboard.appliedRequest.period.key}-${dashboard.appliedRequest.mode}-${stamp}.xlsx`;

  return { buffer, fileName, dashboard, registryRowCount: registry.totalRows };
}
