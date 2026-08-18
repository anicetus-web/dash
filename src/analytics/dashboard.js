/**
 * Расчётный модуль. ЕДИНСТВЕННОЕ место, где считаются показатели воронки.
 *
 * Интерфейс, HTTP API и XLSX читают результат отсюда и никогда не повторяют
 * формулы (инвариант 9). Детализация тоже строится на `computeSlice`, поэтому
 * число ступени и список за ним не могут разойтись (инвариант 8).
 */

import {
  COHORT_ENTRY,
  CROSS_FUNNEL_SEQUENCE,
  FUNNELS,
  JUNCTION,
  MAIN_CONVERSION,
  UNITS,
  canonicalStageId,
  funnelStages,
  hasPlaceholderStageIds,
  pendingAuditStageIds
} from '../domain/funnels.js';
import { inPeriod, resolvePeriod } from '../domain/period.js';
import { anyActive, companyPasses, dealPasses, describeFilters, normalizeFilters } from './filters.js';
import { stageSets } from './funnel.js';
import { NOT_SPECIFIED, WARNING_CODES, buildIndex, eventsOf } from './snapshot.js';
import { calculateCalls } from './calls.js';
import { resolveBucketWindows } from './timeBuckets.js';

/** Округление до одного десятичного знака (спека, Конверсии §2). */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Конверсия между двумя количествами.
 * Нулевой знаменатель — не ошибка: возвращается 0% и признак «не от чего считать»,
 * чтобы интерфейс мог отличить настоящий ноль от отсутствия исходных сущностей.
 */
function conversion(numerator, denominator) {
  if (!denominator) return { value: 0, available: false };
  return { value: round1((numerator / denominator) * 100), available: true };
}

/**
 * Первый вход компании на этап набора когорты.
 * Когорта Статики — компании, ВПЕРВЫЕ перешедшие на «Взят в работу» внутри периода.
 */
function firstCohortEntryAt(index, companyId) {
  const target = canonicalStageId(COHORT_ENTRY.stageId);
  for (const event of eventsOf(index, 'company', companyId)) {
    if (event.stageId === target) return event.at;
  }
  return null;
}

/**
 * Отбор сущностей, участвующих в расчёте.
 *
 * Статика: когорта — компании, впервые взятые в работу внутри периода, и все
 * их сделки. Динамика: все сущности, прошедшие фильтры; попадание в результат
 * определяется фактом движения внутри периода, а не датой создания.
 */
function selectEntities(index, mode, period, filters) {
  const companies = [];
  const deals = [];

  for (const company of index.companies.values()) {
    if (!companyPasses(company, filters)) continue;
    if (mode === 'static') {
      const entryAt = firstCohortEntryAt(index, company.id);
      if (entryAt === null || !inPeriod(entryAt, period)) continue;
    }
    companies.push(company);
  }

  const companyIds = new Set(companies.map((company) => company.id));

  for (const deal of index.deals.values()) {
    if (!dealPasses(deal, filters)) continue;
    // Сделка участвует во второй воронке только если её компания в выборке:
    // сквозная воронка строится по связи «компания → потребность → сделка».
    if (!deal.companyId || !companyIds.has(deal.companyId)) continue;
    deals.push(deal);
  }

  return { companies, deals, companyIds };
}

/**
 * Полный расчёт среза. Внутренняя структура: содержит множества сущностей
 * по ступеням, атрибуцию и отобранные сущности.
 *
 * И агрегат, и детализация зовут именно её — это конструктивная гарантия того,
 * что число на экране и список за ним посчитаны одним и тем же отбором.
 */
export function computeSlice(snapshot, request = {}, options = {}) {
  const mode = request.mode === 'dynamic' ? 'dynamic' : 'static';

  // «Вся история» осмысленна только для Статики: для Динамики период обязателен
  // (спека, Режим Динамики §7). Правило живёт здесь, а не только на HTTP-маршруте,
  // иначе любой другой вызывающий — выгрузка, будущая интеграция — мог бы его обойти.
  if (request.periodType === 'allHistory' && mode === 'dynamic') {
    const error = new Error('Режим «Вся история» доступен только для Статики. Для Динамики выберите период.');
    error.code = 'ALL_HISTORY_REQUIRES_STATIC';
    error.status = 400;
    throw error;
  }

  const index = buildIndex(snapshot);
  const timeZone = options.timeZone || index.portalTimezone || undefined;
  const period = resolvePeriod(
    { type: request.periodType, value: request.periodValue, from: request.from, to: request.to },
    { now: options.now, timeZone }
  );
  const filters = normalizeFilters(request);

  const { companies, deals } = selectEntities(index, mode, period, filters);

  const companyResult = stageSets(
    index, FUNNELS.companies, companies, 'company', mode, period, filters.managerIds
  );
  const dealResult = stageSets(
    index, FUNNELS.deals, deals, 'deal', mode, period, filters.managerIds
  );

  return { index, period, mode, filters, companies, deals, companyResult, dealResult };
}

/**
 * Компании, породившие сделки на ступени стыка.
 *
 * Второй счётчик стыка — это «из скольких компаний» пришли потребности,
 * а не «сколько компаний дошло до этапа». Разница видна при активном фильтре КЭВ:
 * приложение А1 требует показывать здесь компании отфильтрованных сделок.
 */
function junctionCompanies(index, junctionDealIds) {
  const owners = new Set();
  for (const dealId of junctionDealIds) {
    const deal = index.deals.get(dealId);
    if (deal?.companyId) owners.add(deal.companyId);
  }
  return owners;
}

/** Количества по сквозной последовательности ступеней. */
function crossFunnelCounts(slice) {
  const { companyResult, dealResult, index } = slice;
  const companySets = companyResult.sets;
  const dealSets = dealResult.sets;
  const junctionDealIds = dealSets[JUNCTION.dealIndex];
  const junctionOwners = junctionCompanies(index, junctionDealIds);

  return CROSS_FUNNEL_SEQUENCE.map((step) => {
    if (step.junction) {
      return {
        step,
        // Единица учёта на стыке — сделка: после стыка считаются сделки.
        count: junctionDealIds.size,
        companyCount: junctionOwners.size,
        // Сами владельцы (не только их число) — buildWarnings сверяет их с
        // companySets[JUNCTION.companyIndex], чтобы поймать обратный случай:
        // у сделки этап стыка есть, а в истории самой компании — нет.
        companyIds: junctionOwners,
        // Число компаний, дошедших до этапа по первой воронке. Может отличаться
        // от `companyCount`, если у компании этап есть, а сделки нет.
        companyStageCount: companySets[JUNCTION.companyIndex].size,
        ids: junctionDealIds,
        unit: UNITS.deal
      };
    }
    if (step.units[0] === UNITS.company) {
      const ids = companySets[step.position];
      return { step, count: ids.size, ids, unit: UNITS.company };
    }
    // Позиция во второй воронке: сквозная позиция минус позиция стыка.
    const dealIndex = step.position - JUNCTION.companyIndex;
    const ids = dealSets[dealIndex];
    return { step, count: ids.size, ids, unit: UNITS.deal };
  });
}

/**
 * Конверсия к предыдущей ступени.
 *
 * На стыке единица учёта меняется, поэтому обе стороны считаются в СВОИХ единицах:
 * стык к предыдущей ступени — по компаниям (компания → компания), а следующая
 * за стыком ступень к стыку — по сделкам (сделка → сделка). Иначе в одной дроби
 * оказались бы компании и сделки, что спека прямо запрещает.
 */
function conversionsFromPrevious(rows) {
  return rows.map((row, position) => {
    if (position === 0) return null;
    const previous = rows[position - 1];

    if (row.step.junction) {
      return conversion(row.companyCount, previous.count).value;
    }
    if (previous.step.junction) {
      return conversion(row.count, previous.count).value;
    }
    return conversion(row.count, previous.count).value;
  });
}

function stageByRoleInSequence(role) {
  return CROSS_FUNNEL_SEQUENCE.find((step) => step.role === role) || null;
}

function countAtPosition(rows, position) {
  const row = rows.find((item) => item.step.position === position);
  if (!row) return { count: 0, companyCount: 0, unit: null };
  return { count: row.count, companyCount: row.companyCount ?? null, unit: row.unit };
}

/**
 * Сквозная конверсия между двумя произвольными ступенями (спека, Конверсии §5–8).
 *
 * Внутри одной воронки считается в её единице учёта. Если диапазон пересекает стык,
 * основной показатель считается от потребностей к нижней ступени, а отношение
 * к компаниям верхней ступени выводится дополнительным показателем — смешивать
 * компании и сделки в одной формуле нельзя.
 */
function buildConversion(rows, fromRole, toRole) {
  const fromStep = stageByRoleInSequence(fromRole);
  const toStep = stageByRoleInSequence(toRole);
  if (!fromStep || !toStep) return null;
  if (toStep.position < fromStep.position) {
    return { error: 'BAD_CONVERSION_RANGE', message: 'Конечный этап раньше начального.' };
  }

  const fromRow = countAtPosition(rows, fromStep.position);
  const toRow = countAtPosition(rows, toStep.position);

  const fromIsCompany = fromStep.units[0] === UNITS.company && !fromStep.junction;
  // Стык несёт ОБА юнита сразу (units: [company, deal]) — сам по себе он не говорит,
  // в чьей единице учёта читать конверсию, если выбран КОНЕЧНОЙ точкой диапазона.
  // «Квалификация пройдена → Потребность выявлена» — законный вопрос без пересечения
  // единицы учёта («сколько из этих компаний дошли до выявленной потребности»),
  // и должен читаться в единице учёта НАЧАЛЬНОЙ точки (компании), а не всегда как
  // сделки: иначе toRow совпадает с самим junctionRow, primary делит число само
  // на себя и всегда даёт тавтологичные 100%, а дополнительный показатель превышает
  // 100% (делит счётчик сделок на счётчик компаний). Пересечение — только когда
  // стык СТРОГО МЕЖДУ выбранными точками, а не совпадает с одной из них.
  const toIsCompany = toStep.junction ? fromIsCompany : toStep.units[0] === UNITS.company;
  const crossesJunction = fromIsCompany && !toIsCompany;

  // На стыке toRow.count — счётчик сделок (единица учёта ПОСЛЕ стыка); если весь
  // диапазон остаётся в компаниях, нужен именно companyCount стыка, не count.
  const toValue = toStep.junction && toIsCompany ? (toRow.companyCount ?? toRow.count) : toRow.count;

  const base = {
    fromRole, fromName: fromStep.name, fromCount: fromRow.count,
    toRole, toName: toStep.name, toCount: toValue,
    crossesJunction
  };

  if (!crossesJunction) {
    const unit = fromIsCompany ? UNITS.company : UNITS.deal;
    const result = conversion(toValue, fromRow.count);
    return { ...base, fromUnit: unit, toUnit: unit, ...result };
  }

  // Диапазон пересекает стык: основной показатель — от потребностей.
  const junctionRow = rows.find((row) => row.step.junction);
  const needsCount = junctionRow ? junctionRow.count : 0;
  const primary = conversion(toValue, needsCount);
  const secondary = conversion(toValue, fromRow.count);

  return {
    ...base,
    fromUnit: UNITS.company,
    toUnit: UNITS.deal,
    ...primary,
    note: `Основной показатель — от потребностей (${needsCount}) к ступени «${toStep.name}».`,
    secondary: {
      value: secondary.value,
      available: secondary.available,
      baseUnit: UNITS.company,
      baseCount: fromRow.count,
      note: `Отношение к числу компаний на ступени «${fromStep.name}».`
    }
  };
}

/**
 * Предупреждения о качестве данных и состоянии конфигурации.
 *
 * Часть из них (несовпадение источника, пропущенные поля, история ответственных,
 * неподтверждённые ID стадий) осмысленна только для реального портала — это либо
 * оценка настройки Битрикс24 клиента, либо статус аудита ПЕРЕД подключением к нему.
 * На демо-снимке (dataSource='demo') это шум: сгенерированные пробелы существуют
 * специально ради проверки этих самых веток кода, а не как сигнал зрителю демо
 * «что-то не так с реальными данными» — реальных данных там ещё нет.
 */
function buildWarnings(slice, rows, options = {}) {
  const { index, companies, deals, companyResult, dealResult, filters, period } = slice;
  const isDemo = options.dataSource === 'demo';
  const warnings = [];

  if (index.counts.companies === 0 && index.counts.deals === 0) {
    warnings.push({
      code: WARNING_CODES.snapshotEmpty,
      message: 'Локальный снимок пуст: синхронизация ещё не выполнялась.'
    });
  }

  // Демо-снимок обязан объявлять себя ВСЕГДА. Остальные предупреждения о качестве
  // на демо намеренно подавлены (см. isDemo ниже) — без этого одного сообщения
  // демонстрационный дашборд визуально неотличим от боевого, и сгенерированные
  // цифры можно принять за реальные показатели отдела.
  if (isDemo) {
    warnings.push({
      code: WARNING_CODES.demoData,
      message: 'Демонстрационные данные: цифры сгенерированы, портал Битрикс24 не подключён.'
    });
  }

  if (!isDemo) {
    const noSource = companies.filter((company) => company.sourceId === NOT_SPECIFIED).length;
    if (noSource > 0 && !filters.sourceIds) {
      warnings.push({
        code: WARNING_CODES.sourceMissing,
        message: `У ${noSource} компаний не заполнен источник — они собраны в категорию «Источник не указан».`
      });
    }

    const noKev = deals.filter((deal) => deal.kevFormatId === NOT_SPECIFIED).length;
    if (noKev > 0 && !filters.kevFormats) {
      warnings.push({
        code: WARNING_CODES.kevMissing,
        message: `У ${noKev} сделок не заполнен формат КЭВ — они показаны как «Не указано».`
      });
    }

    if (index.counts.dealsWithoutCompany > 0) {
      warnings.push({
        code: WARNING_CODES.dealWithoutCompany,
        message: `${index.counts.dealsWithoutCompany} сделок не связаны с компанией и в сквозную воронку не попали.`
      });
    }

    // Настройка портала: источник должен переноситься в дочернюю сделку автоматизацией.
    // Расхождение означает, что срез по базе считает не то, что ожидает пользователь.
    if (index.counts.dealsWithForeignSource > 0) {
      warnings.push({
        code: WARNING_CODES.sourceNotInherited,
        message: `У ${index.counts.dealsWithForeignSource} сделок источник отличается от источника их компании. Проверьте автоматизацию переноса источника в Битрикс24 — иначе срез по базе будет неполным.`
      });
    }

    // Атрибуция по истории ответственных недоступна: фильтр по менеджеру
    // покажет текущего владельца, а не исполнителя этапа.
    if (!index.hasAssigneeHistory && (companies.length > 0 || deals.length > 0)) {
      warnings.push({
        code: WARNING_CODES.assigneeHistoryMissing,
        message: 'История ответственных недоступна — этапы отнесены текущему ответственному. При передачах между менеджерами статистика будет неточной.'
      });
    } else if (companyResult.inexact + dealResult.inexact > 0) {
      warnings.push({
        code: WARNING_CODES.assigneeHistoryMissing,
        message: `Для части этапов история ответственных неполна (${companyResult.inexact + dealResult.inexact} случаев) — по ним взят текущий ответственный.`
      });
    }
  }

  // Компании с выявленной потребностью, но без сделки: расхождение двух счётчиков стыка.
  // Не сработает при активном фильтре КЭВ — тот сужает только сделки (приложение А1),
  // поэтому companyStageCount (по компаниям) и companyCount (по отфильтрованным сделкам)
  // расходятся асимметрично по замыслу, а не из-за реальной пропущенной сделки.
  const junctionRow = rows.find((row) => row.step.junction);
  if (!isDemo && junctionRow && junctionRow.companyStageCount > junctionRow.companyCount && !filters.kevFormats) {
    const gap = junctionRow.companyStageCount - junctionRow.companyCount;
    warnings.push({
      code: WARNING_CODES.dealWithoutCompany,
      message: `У ${gap} компаний этап «${JUNCTION.name}» пройден, но связанной сделки нет — в нижнюю воронку они не попали.`
    });
  }

  // Обратный случай: у сделки этап стыка есть (владение сделки видно из её
  // companyId), а в истории самой компании этот этап не зафиксирован. companyCount
  // стыка приходит из связи «сделка → компания», а не из истории компании — эти
  // два источника обычно совпадают, но не обязаны, и конверсия к стыку может быть
  // завышена без этого предупреждения.
  if (!isDemo && junctionRow && junctionRow.companyIds) {
    const companySets = companyResult.sets;
    const unmatched = [...junctionRow.companyIds].filter((id) => !companySets[JUNCTION.companyIndex].has(id));
    if (unmatched.length > 0) {
      warnings.push({
        code: WARNING_CODES.dealAheadOfCompanyStage,
        message: `У ${unmatched.length} компаний есть сделка на этапе «${JUNCTION.name}», но в истории самой компании этот этап не зафиксирован — конверсия к этой ступени может быть завышена.`
      });
    }
  }

  if (!isDemo && hasPlaceholderStageIds()) {
    warnings.push({
      code: WARNING_CODES.placeholderStages,
      message: `Технические ID стадий не подтверждены аудитом портала (${pendingAuditStageIds().length} шт.) — расчёт идёт на временной конфигурации.`
    });
  }

  // Ноль звонков на реальном портале означает не «звонков не было», а «раздел
  // снимка не наполняется»: телефония Битрикс24 в синхронизацию ещё не заведена
  // (fetchBitrixSnapshot не возвращает calls). Без этой оговорки пустая карточка
  // читается как измерение, а не как отсутствие источника.
  if (!isDemo && (!Array.isArray(index.calls) || index.calls.length === 0)) {
    warnings.push({
      code: WARNING_CODES.callsUnavailable,
      message: 'Звонки из портала не синхронизируются — карточка «Звонки» показывает нули, это отсутствие данных, а не отсутствие звонков.'
    });
  }

  for (const note of period.notes || []) warnings.push({ code: 'PERIOD_NOTE', message: note });

  return warnings;
}

/**
 * Пояснения к прочтению цифр. Это не проблемы данных, а особенности расчёта,
 * которые иначе выглядят как ошибка дашборда.
 */
function buildNotices(slice, rows, conversions, extraRatios = []) {
  const notices = [];
  const overHundred = conversions.some((value) => value !== null && value > 100)
    || extraRatios.some((value) => value !== null && value !== undefined && value > 100);

  // В Динамике множества на соседних ступенях РАЗНЫЕ: одна сущность могла пройти
  // нижний этап, не проходя верхний в этом же периоде. Поэтому отношение соседних
  // ступеней законно превышает 100% и конверсией воронки не является.
  if (slice.mode === 'dynamic' && overHundred) {
    notices.push({
      code: 'DYNAMIC_RATIO_OVER_100',
      message: 'В Динамике соседние ступени считаются по разным наборам сущностей, поэтому отношение между ними может превышать 100%. Это не ошибка: показатель отражает объём движения за период, а не долю дошедших.'
    });
  }

  // Статика с активным фильтром менеджера: фильтр применяется к ФАКТИЧЕСКОМУ
  // исполнителю каждой отдельной ступени (инвариант 7), поэтому при передаче
  // сущности между менеджерами она может выпасть из среза на ранней ступени и
  // остаться на поздней — соседние ступени перестают быть вложенными множествами,
  // и отношение между ними может законно превысить 100%.
  if (slice.mode === 'static' && slice.filters.managerIds && overHundred) {
    notices.push({
      code: 'MANAGER_FILTER_RATIO_OVER_100',
      message: 'При фильтре по менеджеру этапы одной сущности могут быть выполнены разными сотрудниками (передача между менеджерами). Из-за этого отношение соседних ступеней может превышать 100% — это не ошибка данных.'
    });
  }

  // Статика по незакрытому периоду: когорта набрана недавно и физически
  // не успела дойти до нижних ступеней. Пустой низ воронки здесь — правда.
  if (slice.mode === 'static' && slice.period.clamped) {
    const junction = rows.find((row) => row.step.junction);
    const last = rows.at(-1);
    if (junction && junction.count > 0 && last && last.count === 0) {
      notices.push({
        code: 'YOUNG_COHORT',
        message: 'Период ещё не закончился: компании этой когорты взяты в работу недавно и до нижних ступеней дойти не успели. Чтобы увидеть завершённый цикл, выберите прошедший период или «Вся история».'
      });
    }
  }

  return notices;
}

/**
 * Число уникальных сущностей, встретившихся хотя бы на одной ступени воронки.
 *
 * `slice.companies`/`slice.deals` — кандидатский пул ДО фильтра по менеджеру
 * (тот применяется только внутри stageSets(), к каждой занятости отдельно,
 * потому что менеджер атрибутируется на момент конкретного события —
 * инвариант 7). Досчитывать «в срезе» по пулу означало бы игнорировать
 * фильтр по менеджеру там, где сама воронка его уже учла: пользователь
 * увидел бы «Компаний: 46» рядом с воронкой, где реально видно 9.
 */
function uniqueEntitiesAcrossStages(sets) {
  const ids = new Set();
  for (const set of sets) for (const id of set) ids.add(id);
  return ids.size;
}

/** Свежесть данных для шапки интерфейса. */
function buildFreshness(index, options) {
  const sync = index.sync || {};
  const now = options.now ? options.now.getTime() : Date.now();
  const lastSuccess = sync.lastSuccessAt ? Date.parse(sync.lastSuccessAt) : null;
  // Снимок считается устаревшим, если последняя удачная синхронизация была
  // давно: примерно шесть интервалов автообновления.
  const staleAfterMs = options.staleAfterMs ?? 60 * 60 * 1000;
  return {
    snapshotAt: index.updatedAt,
    lastSuccessAt: sync.lastSuccessAt ?? null,
    syncStatus: sync.status ?? 'idle',
    lastError: sync.lastError ?? null,
    stale: lastSuccess === null ? index.counts.companies > 0 : now - lastSuccess > staleAfterMs,
    source: index.source ?? null
  };
}

/**
 * Рассчитанный дашборд.
 *
 * @param {object} snapshot нормализованный снимок
 * @param {object} request  режим, период, фильтры, выбранная конверсия
 * @param {object} options  {now, timeZone} — инъекция для детерминированных проверок
 */
export function calculateDashboard(snapshot, request = {}, options = {}) {
  // «Сейчас» разрешается ОДИН раз на весь расчёт и передаётся вниз: иначе
  // агрегат, динамика и звонки берут по своему new Date(), и на пересечении
  // часа график конверсий и график звонков могли бы получить разное число
  // бакетов — одна карточка на экране показывала бы на точку больше другой.
  const calcOptions = { ...options, now: options.now instanceof Date ? options.now : new Date() };
  const slice = computeSlice(snapshot, request, calcOptions);
  const rows = crossFunnelCounts(slice);
  const conversions = conversionsFromPrevious(rows);

  const stages = rows.map((row, position) => {
    const stage = {
      position: row.step.position,
      role: row.step.role,
      name: row.step.junction ? JUNCTION.pluralName : row.step.name,
      funnelId: row.step.junction ? FUNNELS.deals.id : (row.unit === UNITS.company ? FUNNELS.companies.id : FUNNELS.deals.id),
      unit: row.unit,
      count: row.count,
      conversionFromPrevious: conversions[position],
      junction: row.step.junction === true
    };
    if (row.step.junction) stage.companyCount = row.companyCount;
    const definition = row.step.junction
      ? null
      : funnelStages(stage.funnelId).find((item) => item.role === row.step.role);
    if (definition?.operational) stage.operational = true;
    if (definition?.commercialResult) stage.commercialResult = true;
    return stage;
  });

  const primaryConversion = buildConversion(rows, MAIN_CONVERSION.from.role, MAIN_CONVERSION.to.role);

  let selectedConversion = null;
  if (request.conversionFrom && request.conversionTo) {
    selectedConversion = buildConversion(rows, request.conversionFrom, request.conversionTo);
  }

  const junctionRow = rows.find((row) => row.step.junction);

  return {
    appliedRequest: {
      mode: slice.mode,
      period: {
        type: slice.period.type,
        key: slice.period.key,
        label: slice.period.label,
        from: slice.period.from ? slice.period.from.toISOString() : null,
        to: slice.period.to.toISOString(),
        naturalTo: slice.period.naturalTo.toISOString(),
        clamped: slice.period.clamped,
        timeZone: slice.period.timeZone,
        // Календарные дни границ (уже посчитаны resolvePeriod по часам портала) — интерфейсу
        // они нужны, чтобы поле «указать даты вручную» показывало РЕАЛЬНО применённый диапазон,
        // а не заглушку: from/to выше это ISO-моменты, а не то, что можно положить в <input type="date">.
        fromDay: slice.period.fromDay,
        toDay: slice.period.toDay
      },
      filters: describeFilters(slice.filters),
      conversion: request.conversionFrom && request.conversionTo
        ? { fromRole: request.conversionFrom, toRole: request.conversionTo }
        : null
    },
    freshness: buildFreshness(slice.index, calcOptions),
    stages,
    primaryConversion,
    selectedConversion,
    dynamics: computeDynamicsSeries(slice, request, calcOptions),
    calls: calculateCalls(snapshot, request, calcOptions),
    totals: {
      companies: uniqueEntitiesAcrossStages(slice.companyResult.sets),
      needs: junctionRow ? junctionRow.count : 0,
      deals: uniqueEntitiesAcrossStages(slice.dealResult.sets)
    },
    filtersActive: anyActive(slice.filters),
    warnings: buildWarnings(slice, rows, calcOptions),
    notices: buildNotices(slice, rows, conversions, [primaryConversion?.value, selectedConversion?.value])
  };
}

/**
 * Срез внутри одного бакета графика динамики. Те же `selectEntities`/`stageSets`,
 * что и `computeSlice` — единственная разница в границах периода (окно бакета вместо
 * всего запрошенного периода). Индекс, режим и фильтры уже разрешены снаружи один раз,
 * пересчитывать их на каждый бакет незачем — они не зависят от узости окна.
 */
function sliceForWindow(index, mode, filters, fromMs, toMs) {
  const period = Object.freeze({ from: new Date(fromMs), to: new Date(toMs) });
  const { companies, deals } = selectEntities(index, mode, period, filters);
  const companyResult = stageSets(index, FUNNELS.companies, companies, 'company', mode, period, filters.managerIds);
  const dealResult = stageSets(index, FUNNELS.deals, deals, 'deal', mode, period, filters.managerIds);
  return { companyResult, dealResult };
}

/**
 * Динамика двух конверсий (главной и сквозной) — НАРАСТАЮЩИМ ИТОГОМ.
 *
 * Точка графика — конверсия, посчитанная от начала окна тренда по конец этого
 * бакета, а не внутри одного бакета отдельно. Причина в самой природе
 * показателя: цикл сделки длиннее недели, и когорта, взятая в работу на этой
 * неделе, к её концу физически не успевает дойти до «Аванс получен». Побакетный
 * расчёт давал технически верный, но бесполезный график — ноль в каждой точке.
 * Нарастающий итог показывает то, ради чего график и нужен: как когорта
 * дозревает со временем (0 → 0 → 2% → 4%).
 *
 * Своей формулы конверсии здесь нет (инвариант 9): `crossFunnelCounts` и
 * `buildConversion` вызываются те же, что и для агрегата, просто на срезе
 * «от начала тренда до конца бакета».
 *
 * @param {object} slice уже посчитанный `computeSlice` для всего периода —
 *        нужен только ради index/mode/filters/period, поэтому передаётся
 *        снаружи, а не считается второй раз (расчёт стоит десятки миллисекунд).
 */
export function computeDynamicsSeries(slice, request = {}, options = {}) {
  const { index, mode, filters, period } = slice;
  const windows = resolveBucketWindows(period, { now: options.now, timeZone: period.timeZone });
  if (windows.length === 0) return { periodType: period.type, buckets: [], cumulative: true };

  const trendStartMs = windows[0].fromMs;

  const buckets = windows.map(({ label, fromMs, toMs }) => {
    const windowSlice = sliceForWindow(index, mode, filters, trendStartMs, toMs);
    const rows = crossFunnelCounts({ ...windowSlice, index });
    const primary = buildConversion(rows, MAIN_CONVERSION.from.role, MAIN_CONVERSION.to.role);
    const selected = request.conversionFrom && request.conversionTo
      ? buildConversion(rows, request.conversionFrom, request.conversionTo)
      : null;
    return {
      label,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      primaryValue: primary && primary.available ? primary.value : null,
      selectedValue: selected && selected.available ? selected.value : null
    };
  });

  return { periodType: period.type, buckets, cumulative: true };
}

export { crossFunnelCounts, buildConversion };
