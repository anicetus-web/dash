# Issue tracker: Local Markdown

Issues и спеки для этого репозитория живут как markdown-файлы в `.scratch/`.

## Conventions

- Одна фича — один каталог: `.scratch/<feature-slug>/`
- Спека: `.scratch/<feature-slug>/spec.md`
- Тикеты — один файл на тикет: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, нумерация с `01`, никогда не один общий файл
- Состояние триажа — строка `Status:` вверху файла (роли см. `triage-labels.md`)
- Комментарии и история дописываются в конец файла под заголовком `## Comments`

## Текущая фича

`.scratch/funnel-dashboard/` — сквозной дашборд воронки продаж 3ДБИЛД.
Источник истины по объёму: `.scratch/funnel-dashboard/spec.md`.

## When a skill says "publish to the issue tracker"

Создать новый файл в `.scratch/<feature-slug>/` (создав каталог при необходимости).

## When a skill says "fetch the relevant ticket"

Прочитать файл по указанному пути. Путь или номер тикета обычно передаётся напрямую.
