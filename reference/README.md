# 3ДБИЛД — пакет для передачи разработчику

Этот каталог содержит утверждённую спецификацию MVP и отобранный технический референс из рабочего дашборда Altech Systems.

## С чего начать

1. Прочитать [`specification/MVP_SPEC.md`](specification/MVP_SPEC.md). Это источник истины по объёму и бизнес-правилам.
2. Прочитать [`CODE_REUSE_MAP.md`](CODE_REUSE_MAP.md). Там указано, что можно адаптировать, что использовать только как образец и что намеренно исключено.
3. Прочитать [`DEVELOPER_START.md`](DEVELOPER_START.md). Там зафиксированы рекомендуемый шов расчётного модуля, порядок реализации и проверки.
4. До реализации интеграции закрыть вопросы из [`REQUIRED_INPUTS.md`](REQUIRED_INPUTS.md).
5. Для визуального направления открыть [`reference/altech/design/glass-reference.html`](reference/altech/design/glass-reference.html) и сверить его с рабочим интерфейсом из `reference/altech/public/`.

## Состав

```text
developer-handoff-3dbuild/
├── README.md
├── CODE_REUSE_MAP.md
├── DEVELOPER_START.md
├── REQUIRED_INPUTS.md
├── SOURCE_PROVENANCE.md
├── specification/
│   └── MVP_SPEC.md
└── reference/altech/
    ├── README.md
    ├── package.json
    ├── .env.example
    ├── server.original.js
    ├── public/
    ├── src/
    ├── scripts/
    └── design/
```

## Важное ограничение

Код Altech не является заготовкой, которую можно целиком переименовать в 3ДБИЛД. В Altech аналитическая единица — сделка одной воронки. В 3ДБИЛД расчёт проходит через компании и сделки, имеет два режима, отдельную атрибуцию менеджеров и особые правила откатов. Поэтому старый код приложен как проверенный технический и интерфейсный референс, а новый расчётный модуль должен быть реализован по спецификации.

В комплекте нет `.env`, API-ключей, логов, кэшей, CRM-выгрузок, контактных данных и модулей ИИ-аналитика.
