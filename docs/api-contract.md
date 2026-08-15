# Контракт HTTP API

Шов между расчётным модулем и интерфейсом. Обе стороны строятся против этого документа.

Основание: спека, разделы `API Decisions` и `Testing Decisions`; `reference/DEVELOPER_START.md`.

## Общие правила

**Конверт ответа одинаков у всех маршрутов.**

```jsonc
// успех
{ "success": true, "data": { /* ... */ } }
// ошибка
{ "success": false, "error": { "code": "BAD_STAGE", "message": "Ступень не найдена" } }
```

- Заголовок `Cache-Control: no-store` на всех API-маршрутах.
- HTTP-код отражает суть: `400` — неверный запрос, `404` — маршрут не найден, `413` — тело велико, `500` — сбой.
- Сообщение ошибки предназначено человеку и выводится в интерфейсе как есть. Технических трассировок в нём нет.
- API-ключ Битрикса не появляется ни в одном ответе.
- **Формул в маршрутах нет.** Сервер разбирает запрос, зовёт расчётный модуль и упаковывает результат.

## Параметры среза

Общий набор для всех читающих маршрутов. Передаётся строкой запроса.

| Параметр | Значения | По умолчанию |
|---|---|---|
| `mode` | `static` \| `dynamic` | `static` |
| `periodType` | `week` \| `month` \| `quarter` \| `year` \| `custom` \| `allHistory` | `quarter` |
| `periodValue` | ключ периода: `2026-W33`, `2026-08`, `2026-Q3`, `2026` | текущий квартал |
| `from`, `to` | `YYYY-MM-DD`, только при `periodType=custom` | — |
| `sourceIds` | список через запятую; `__none__` — «Источник не указан» | пусто = все |
| `managerIds` | список через запятую | пусто = все |
| `kevFormats` | список через запятую; `__none__` — «Не указано» | пусто = все |
| `conversionFrom`, `conversionTo` | роли ступеней сквозной последовательности | — |

Правила разбора:

- Пустой список означает «все значения», а не «ничего».
- Несколько значений одного параметра объединяются по ИЛИ, разные параметры — по И.
- `allHistory` допустим только при `mode=static`. При `mode=dynamic` возвращается `400` с кодом `ALL_HISTORY_REQUIRES_STATIC`.
- Неизвестное значение параметра не роняет запрос: применяется значение по умолчанию, в ответ добавляется предупреждение.

## `GET /api/dashboard`

Основной маршрут. Возвращает рассчитанный срез целиком.

```jsonc
{
  "appliedRequest": {
    "mode": "static",
    "period": { "type": "quarter", "key": "2026-Q3", "label": "3 квартал 2026",
                "from": "2026-07-01T00:00:00.000+03:00", "to": "2026-08-15T23:59:59.999+03:00",
                "naturalTo": "2026-09-30T23:59:59.999+03:00", "clamped": true,
                "timeZone": "Europe/Moscow" },
    "filters": { "sourceIds": [], "managerIds": [], "kevFormats": [] },
    "conversion": { "fromRole": "takenToWork", "toRole": "advanceReceived" }
  },

  "freshness": {
    "snapshotAt": "2026-08-15T18:40:00.000Z",
    "lastSuccessAt": "2026-08-15T18:40:00.000Z",
    "syncStatus": "idle",
    "stale": false,
    "source": "demo"
  },

  // Сквозная последовательность ступеней: воронка компаний, стык, воронка сделок.
  // Порядок массива — порядок отображения. Стык встречается ровно один раз.
  "stages": [
    { "position": 0, "role": "newCompany", "name": "Новая компания",
      "funnelId": "companies", "unit": "company",
      "count": 412, "conversionFromPrevious": null, "junction": false },

    { "position": 5, "role": "needIdentified", "name": "Потребности выявлены",
      "funnelId": "companies", "unit": "deal",
      "count": 148,              // потребности (сделки)
      "companyCount": 96,        // породившие их компании — второй счётчик стыка
      "conversionFromPrevious": 61.4,
      "junction": true },

    { "position": 14, "role": "handedToProduction", "name": "Передано в производство",
      "funnelId": "deals", "unit": "deal",
      "count": 11, "conversionFromPrevious": 78.6,
      "junction": false, "operational": true }
  ],

  "primaryConversion": {
    "fromRole": "takenToWork", "fromName": "Взят в работу", "fromUnit": "company", "fromCount": 318,
    "toRole": "advanceReceived", "toName": "Аванс получен", "toUnit": "deal", "toCount": 14,
    "value": 4.4,
    "crossesJunction": true,
    "available": true,
    "note": "Считается от компаний, взятых в работу, к сделкам с полученным авансом."
  },

  "selectedConversion": {
    "fromRole": "...", "toRole": "...",
    "value": 32.5,
    "crossesJunction": true,
    // Заполняется ТОЛЬКО когда диапазон пересекает стык (спека, Конверсии §8):
    // основной показатель — от потребностей, дополнительный — от компаний верхней ступени.
    "secondary": { "value": 21.0, "baseUnit": "company", "baseCount": 318,
                   "note": "Отношение к числу компаний на верхнем этапе" },
    "available": true
  },

  "totals": { "companies": 412, "needs": 148, "deals": 148 },

  "warnings": [
    { "code": "SOURCE_MISSING", "message": "У 14 компаний не заполнен источник — они собраны в категорию «Источник не указан»." }
  ]
}
```

Правила заполнения:

- `conversionFromPrevious` у первой ступени — `null`, а не `100`. Сто процентов первой ступени — решение отображения, и принимает его интерфейс.
- `unit` у стыка — `deal`: после стыка считаются сделки. Компании стыка живут в `companyCount`.
- `available: false` означает «нет исходных сущностей»; `value` при этом `0`. Интерфейс обязан различать «ноль процентов» и «не от чего считать».
- `secondary` отсутствует, если диапазон конверсии не пересекает стык.

## `GET /api/reference`

Справочники для фильтров. Не зависит от среза.

```jsonc
{
  "managers": [ { "id": "7", "name": "Ирина Соколова" } ],
  "sources":  [ { "id": "expo", "name": "Отраслевые выставки" },
                { "id": "__none__", "name": "Источник не указан" } ],
  "kevFormats": [ { "id": "online", "name": "Онлайн-встреча" },
                  { "id": "__none__", "name": "Не указано" } ],
  "stages": [ { "position": 0, "role": "newCompany", "name": "Новая компания",
                "funnelId": "companies", "unit": "company", "junction": false } ],
  "portalTimezone": "Europe/Moscow",
  "periodTypes": ["week", "month", "quarter", "year", "custom", "allHistory"]
}
```

`__none__` всегда последним в своём списке.
`stages` — сквозная последовательность, из неё интерфейс строит селекторы конверсии.

## `GET /api/details`

Детализация ступени. Параметры среза те же плюс:

| Параметр | Значение |
|---|---|
| `stageRole` | роль ступени из сквозной последовательности |
| `page` | номер страницы, с 1 |
| `pageSize` | размер страницы, по умолчанию 100, максимум 500 |

```jsonc
{
  "stage": { "position": 7, "role": "proposalSent", "name": "КП отправлено", "unit": "deal" },
  "count": 148,          // ВСЕГО уникальных сущностей — считается ДО постраничной обрезки
  "page": 1, "pageSize": 100, "pageCount": 2,
  "rows": [
    { "entityType": "deal", "id": "10432", "title": "Ангар 24×60, Пермь",
      "companyId": "884", "companyTitle": "ПСК Меридиан",
      "sourceId": "expo", "sourceName": "Отраслевые выставки",
      "managerId": "7", "managerName": "Ирина Соколова",
      "kevFormatId": "online", "kevFormatName": "Онлайн-встреча",
      "currentStageName": "КП защищено",
      "stageDates": [ { "role": "needIdentified", "name": "Потребность выявлена", "at": "2026-05-12T09:20:00.000Z" } ],
      "url": "https://portal.bitrix24.ru/crm/deal/details/10432/" }
  ]
}
```

**Главный инвариант:** `count` обязан совпадать с `count` той же ступени в `/api/dashboard`
при тех же параметрах среза. Достигается тем, что детализация вызывает ту же функцию отбора,
что и агрегат, а не повторяет условия.

Для компании поля `companyId`, `companyTitle`, `kevFormatId`, `kevFormatName` отсутствуют.
Контактных данных — телефонов, email, комментариев — в строках нет никогда.

## `GET /api/sync-status`

```jsonc
{
  "status": "idle",              // idle | running | success | error
  "lastStartedAt": "...", "lastSuccessAt": "...", "lastError": null,
  "snapshotAt": "...", "stale": false, "source": "demo",
  "counts": { "companies": 412, "deals": 604, "companyStageEvents": 1840, "dealStageEvents": 2210 },
  "dataQuality": { "companiesWithoutSource": 14, "dealsWithoutKev": 31, "assigneeHistoryAvailable": true },
  "warnings": []
}
```

## `POST /api/sync`

Ручной запуск. Тела нет.

Одновременно выполняется не более одной синхронизации: второй запрос **присоединяется к текущей**
и получает её результат, а не отклоняется и не запускает вторую.

Ответ — та же форма, что у `/api/sync-status`, после завершения.

## `GET /api/export.xlsx`

Параметры среза те же. Возвращает бинарный XLSX, не конверт.

```
Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
Content-Disposition: attachment; filename="voronka-2026-Q3-static.xlsx"
```

Листы «Сводка» и «Реестр». Числа обязаны совпадать с `/api/dashboard` и `/api/details`
при тех же параметрах — файл строится поверх результата того же расчётного модуля.

## `GET /health` и `GET /ready`

`/health` — liveness, всегда `200 {"ok":true}`, снимок не читает.
`/ready` — readiness, `503` при неготовности. Оба **без конверта**: их читают платформенные проверки.

## Коды ошибок

| Код | Когда |
|---|---|
| `ALL_HISTORY_REQUIRES_STATIC` | `allHistory` запрошен в режиме Динамики |
| `BAD_STAGE` | Неизвестная роль ступени в детализации |
| `BAD_CONVERSION_RANGE` | Конечная ступень конверсии раньше начальной |
| `BAD_REQUEST` | Тело запроса не разбирается |
| `PAYLOAD_TOO_LARGE` | Тело превышает лимит |
| `SNAPSHOT_EMPTY` | Снимок пуст: синхронизация ещё не выполнялась |
| `SYNC_FAILED` | Синхронизация завершилась ошибкой |
