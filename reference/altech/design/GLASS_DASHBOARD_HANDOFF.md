# 🧊 ЗАДАЧА ДЛЯ CLAUDE CODE: одеть дашборд продаж в стеклянный дизайн

> **Контекст для агента.** Это инструкция по **рестайлингу существующего рабочего дашборда продаж**
> в визуальный язык **glassmorphism** (ледяной бело-холодный). Логику, данные и расчёты графиков
> **не трогай** — меняй только оформление: подключи токены, заверни виджеты в стеклянные классы,
> перекрась серии графиков под палитру, примени типографику. Ниже — всё необходимое (токены, CSS,
> спецификация компонентов). Визуальный эталон — рядом лежащий `glass-reference.html` (открой в браузере).

---

## 0. Алгоритм внедрения (делай по порядку)

1. **Подключи шрифты** Manrope + Unbounded + JetBrains Mono (см. §1).
2. **Добавь CSS** из §2 (токены) и §3 (классы) в проект — либо как два файла, либо в глобальный стиль.
   Если стек CSS-in-JS / Tailwind — перенеси переменные в тему, классы используй как образец.
3. **Задай фон** корневому контейнеру: `background: var(--bg-page); min-height:100vh;` (см. §4).
4. **Заверни каждую панель** в `class="glass glass-panel"` с шапкой `glass-panel__head` (см. §5).
5. **Перекрась графики** под палитру: текущий период `--accent`, предыдущий `--prev` пунктиром,
   сектора donut — `--cool-1..6` (см. §6).
6. **Применри типографику одного регистра**: заголовки/числа — Unbounded, все лейблы — UPPERCASE
   с трекингом `.045em` (воронка — `.08em`) (см. §7).
7. Свери результат с `glass-reference.html`.

---

## 1. Шрифты

В `<head>`:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Unbounded:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```
- **Unbounded** — заголовки и крупные числа (техно-инновационный геометрик).
- **Manrope** — весь текст. Обе с полной кириллицей.

---

## 2. Дизайн-токены (`design-tokens.css`) — подключать ПЕРВЫМ

```css
:root {
  /* Акцент и холодная палитра */
  --accent:        #b8d0ff;   /* основной ледяной голубой */
  --accent-soft:   #cfe0ff;
  --accent-deep:   #9fc7ff;
  --prev:          #9fb6dd;   /* «предыдущий период» — приглушённый сталь */
  --cool-1:        #d8e6ff;   /* палитра для секторов donut */
  --cool-2:        #9fc0ff;
  --cool-3:        #7f9fe8;
  --cool-4:        #b3a8e8;
  --cool-5:        #86b8d0;
  --cool-6:        #6f86c0;

  /* Статусы */
  --pos:           #5fe0a0;   /* рост */
  --neg:           #ff8a8a;   /* падение */

  /* Текст (тёмная тема) */
  --txt:           #eef3fb;
  --txt-2:         rgba(226,236,250,0.62);
  --txt-3:         rgba(226,236,250,0.40);

  /* Стекло */
  --glass-blur:    30px;                        /* сила размытия backdrop */
  --glass-alpha:   0.10;                         /* плотность заливки 0.02–0.22 */
  --glass-bg:      rgba(255,255,255, var(--glass-alpha));
  --glass-brd:     rgba(255,255,255,0.14);
  --glass-hi:      rgba(255,255,255,0.20);
  --field-bg:      rgba(8,14,28,0.45);
  --seg-bg:        rgba(255,255,255,0.06);

  /* Типографика */
  --font:          'Manrope', system-ui, -apple-system, sans-serif;
  --font-display:  'Unbounded', 'Manrope', system-ui, sans-serif;
  --font-mono:     'JetBrains Mono', ui-monospace, monospace;

  /* Радиусы */
  --r-card:        22px;
  --r-ctrl:        12px;
  --r-pill:        999px;

  /* Тени */
  --shadow-card:
    inset 0 1px 0 rgba(255,255,255,0.32),
    inset 0 0 0 1px rgba(255,255,255,0.04),
    inset 0 -26px 50px -34px rgba(255,255,255,0.16),
    0 26px 64px -28px rgba(0,0,0,0.66);
  --shadow-card-hover:
    inset 0 1px 0 rgba(255,255,255,0.38),
    inset 0 -26px 50px -34px rgba(184,208,255,0.20),
    0 30px 72px -26px rgba(0,0,0,0.7),
    0 0 0 1px rgba(184,208,255,0.12);

  /* Фон страницы (тёмный градиент «полночь») */
  --bg-page: radial-gradient(130% 120% at 12% 0%, #16233f 0%, #0e1730 36%, #0a1020 70%, #070a15 100%);
}

/* Светлая тема: класс .light на корневой контейнер */
.light {
  --txt:    #131a2b;
  --txt-2:  rgba(19,26,43,0.62);
  --txt-3:  rgba(19,26,43,0.42);
  --glass-bg:  rgba(255,255,255, calc(var(--glass-alpha) * 3.6 + 0.3));
  --glass-brd: rgba(255,255,255,0.7);
  --glass-hi:  rgba(255,255,255,0.9);
  --field-bg:  rgba(255,255,255,0.7);
  --seg-bg:    rgba(19,26,43,0.05);
  --bg-page:   radial-gradient(130% 120% at 12% 0%, #dce8ff 0%, #c6d6f0 44%, #b2c6e6 100%);
}
```

---

## 3. UI-классы (`glass-ui.css`) — подключать ВТОРЫМ

```css
/* Базовый текст/фон страницы */
body, .glass-root {
  font-family: var(--font); color: var(--txt);
  -webkit-font-smoothing: antialiased; background: var(--bg-page);
}

/* СТЕКЛЯННАЯ КАРТОЧКА — главный примитив */
.glass {
  position: relative;
  background:
    radial-gradient(135% 90% at 0% 0%, rgba(255,255,255,0.13), rgba(255,255,255,0) 44%),
    radial-gradient(120% 130% at 100% 0%, rgba(184,208,255,0.12), rgba(255,255,255,0) 42%),
    var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(165%) brightness(1.05);
  backdrop-filter: blur(var(--glass-blur)) saturate(165%) brightness(1.05);
  border: 1px solid var(--glass-brd);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-card);
}

.glass-panel { padding: 22px 24px; transition: border-color .28s ease, box-shadow .28s ease; }
.glass-panel:hover { border-color: rgba(255,255,255,0.26); box-shadow: var(--shadow-card-hover); }

.glass-panel__head { display:flex; align-items:flex-start; justify-content:space-between; gap:14px; margin-bottom:18px; }
.glass-panel__title {
  font-family: var(--font-display); font-size:17px; font-weight:800;
  text-transform:uppercase; letter-spacing:.045em; color:var(--accent);
  position:relative; padding-bottom:10px;
}
.glass-panel__title::after { content:""; position:absolute; left:0; bottom:0; width:54px; height:3px; border-radius:3px; background:var(--accent); opacity:.9; }
.glass-panel__note { font-size:12.5px; color:var(--txt-2); text-transform:uppercase; letter-spacing:.045em; }

/* ТИПОГРАФИКА: один регистр */
.glass-display { font-family: var(--font-display); letter-spacing:-0.01em; }
.glass-eyebrow { font-family: var(--font-display); text-transform:uppercase; letter-spacing:.14em; font-weight:800; font-size:12px; color:var(--accent); }
.glass-label   { text-transform:uppercase; letter-spacing:.045em; color:var(--txt-2); }
.glass-kpi__value { font-family: var(--font-display); font-size: clamp(28px,3vw,40px); font-weight:800; letter-spacing:-0.02em; line-height:1.05; }

/* СЕГМЕНТЫ / ПЕРИОДЫ */
.glass-seg { display:inline-flex; gap:3px; padding:4px; border-radius:13px; background:var(--seg-bg); border:1px solid var(--glass-brd); }
.glass-seg__btn { border:0; background:transparent; color:var(--txt-2); font:inherit; font-size:13px; font-weight:600; padding:6px 16px; border-radius:9px; cursor:pointer; transition:.18s; text-transform:uppercase; letter-spacing:.045em; }
.glass-seg__btn.is-on { background:rgba(255,255,255,0.16); color:var(--txt); box-shadow:0 2px 8px -2px rgba(0,0,0,0.3); }

/* СЕЛЕКТ */
.glass-select { appearance:none; height:42px; padding:0 34px 0 14px; border:1px solid var(--glass-brd); border-radius:var(--r-ctrl); background:var(--field-bg); color:var(--txt); font:inherit; font-size:13.5px; font-weight:500; cursor:pointer; outline:none; text-transform:uppercase; letter-spacing:.045em; }

/* CTA-КНОПКА */
.glass-btn { border:0; border-radius:var(--r-ctrl); color:#06121e; font:inherit; font-weight:800; font-size:14px; padding:12px 22px; cursor:pointer; background:var(--accent); box-shadow:0 10px 24px -8px var(--accent); transition:.2s; text-transform:uppercase; letter-spacing:.045em; }
.glass-btn:hover { filter:brightness(1.06); }

/* ВОРОНКА (горизонтальные пропорциональные бары) */
.glass-funnel { display:flex; flex-direction:column; gap:11px; }
.glass-funnel__row { display:grid; grid-template-columns:1.5fr 2fr 50px 58px; align-items:center; gap:14px; transition:transform .15s; }
.glass-funnel__row:hover { transform:translateX(2px); }
.glass-funnel__name { font-size:13.5px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.glass-funnel__track { height:30px; border-radius:9px; background:var(--seg-bg); border:1px solid var(--glass-brd); overflow:hidden; }
.glass-funnel__fill {
  height:100%; border-radius:8px;
  background:linear-gradient(90deg, color-mix(in srgb, var(--accent) 80%, transparent), color-mix(in srgb, var(--accent) 40%, transparent));
  box-shadow:inset 0 1px 0 rgba(255,255,255,0.5);
  transition:width .55s cubic-bezier(.3,.8,.3,1), background .2s, box-shadow .2s;
}
.glass-funnel__row:hover .glass-funnel__fill { background:linear-gradient(90deg, var(--accent), #fff); box-shadow:0 0 18px -2px var(--accent); }
.glass-funnel__count { font-family:var(--font-display); font-size:14.5px; font-weight:800; text-align:right; }
.glass-funnel__conv { font-size:14px; font-weight:700; color:var(--accent); text-align:right; }

/* DONUT (легенда + центр; SVG рисует ваша либа, цвета — из палитры) */
.glass-donut { display:flex; align-items:center; gap:clamp(16px,2.5vw,30px); flex-wrap:wrap; }
.glass-donut__center { display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
.glass-donut__center b { font-family:var(--font-display); font-size:32px; font-weight:800; letter-spacing:-0.02em; line-height:1; }
.glass-donut__center span { font-size:11.5px; color:var(--txt-2); text-transform:uppercase; letter-spacing:.045em; margin-top:3px; }
.glass-donut__legend { flex:1; min-width:250px; display:flex; flex-direction:column; gap:3px; }
.glass-donut__leg { display:grid; grid-template-columns:auto 1fr auto auto; align-items:center; gap:11px; padding:8px 10px; border-radius:10px; cursor:pointer; transition:background .15s; }
.glass-donut__leg:hover { background:var(--seg-bg); }
.glass-donut__leg i { width:11px; height:11px; border-radius:4px; flex-shrink:0; }

/* РАДИАЛЬНАЯ ШКАЛА (центр) */
.glass-dial { position:relative; }
.glass-dial__center { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; gap:2px; pointer-events:none; }
.glass-dial__center b { font-family:var(--font-display); font-size:76px; font-weight:800; color:#f4f8ff; letter-spacing:-0.04em; line-height:1; text-shadow:0 4px 26px rgba(184,208,255,0.45); }

/* ДЕЛЬТА (рост/падение) */
.glass-delta { display:inline-flex; align-items:center; gap:3px; font-size:12px; font-weight:600; padding:3px 8px; border-radius:var(--r-pill); }
.glass-delta.is-up   { color:var(--pos); background:rgba(95,224,160,0.12); }
.glass-delta.is-down { color:var(--neg); background:rgba(255,138,138,0.12); }

/* Полоса прогресса (источники/отказы, если не donut) */
.glass-track { height:10px; border-radius:var(--r-pill); background:var(--seg-bg); overflow:hidden; }
.glass-track > i { display:block; height:100%; border-radius:var(--r-pill); transition:width .5s ease; }
```

---

## 4. Фон страницы
Обязателен тёмный градиент под стеклом — иначе `backdrop-filter` нечего размывать:
```css
.dashboard-root { background: var(--bg-page); min-height: 100vh; }
```

---

## 5. Разметка панели (образец)
```html
<section class="glass glass-panel">
  <div class="glass-panel__head">
    <h2 class="glass-panel__title">Воронка продаж</h2>
    <span class="glass-panel__note">от визита до оплаты</span>
  </div>
  <!-- существующий график/таблица здесь -->
</section>
```

## 5a. Воронка (HTML на каждую строку)
```html
<div class="glass-funnel">
  <div class="glass-funnel__row">
    <div class="glass-funnel__name">1. Взят в работу</div>
    <div class="glass-funnel__track"><div class="glass-funnel__fill" style="width:100%"></div></div>
    <div class="glass-funnel__count">221</div>
    <div class="glass-funnel__conv">100%</div>
  </div>
  <!-- … width = value / max * 100% … -->
</div>
```

## 5b. Donut (легенда)
```html
<div class="glass-donut">
  <div class="glass-donut__chart"><!-- SVG-кольцо вашей либы, цвета var(--cool-1..6) --></div>
  <div class="glass-donut__center"><b>17</b><span>договоров</span></div>
  <div class="glass-donut__legend">
    <div class="glass-donut__leg"><i style="background:var(--cool-1)"></i><span>Холодный звонок</span><span>7 · 6,4 млн ₽</span><span style="color:var(--accent)">38,9%</span></div>
    <!-- … -->
  </div>
</div>
```

---

## 6. Перекраска графиков (любая либа: Recharts / Chart.js / ECharts / D3)
| Элемент | Цвет | Примечание |
|--------|------|-----------|
| Текущий период / основная серия | `--accent` `#b8d0ff` | сплошная линия 2.6–2.8px |
| Предыдущий период | `--prev` `#9fb6dd` | **пунктир** `strokeDasharray:"6 7"` |
| Сектора donut | `--cool-1..6` | по порядку |
| Заливка area | градиент `--accent` 0.26 → 0 | вертикальный |
| Линии сетки | `rgba(255,255,255,0.07)` | |
| Подписи осей | `--txt-3` | 11px |
| Бары (если bar-chart) | `rgba(255,255,255,0.92)`, ховер → `--accent` | скруглённые `border-radius:999px` |

---

## 7. Правило типографики (одного регистра)
- **Заголовки панелей, eyebrow, крупные числа** → `font-family: var(--font-display)` (Unbounded), 800.
- **Все лейблы/подписи/названия этапов** → `text-transform: uppercase; letter-spacing: .045em`.
- **Воронка** — усиленный трекинг `.08em`.
- Числа — `font-variant-numeric: tabular-nums` для ровных колонок.

---

## 8. Сетка и адаптив
- Десктоп `> 1180px`: 2-колоночные ряды (план 1.25fr / KPI 2fr; воронка 1fr / выручка 1.18fr).
- `≤ 1180px`: все ряды в 1 колонку.
- `≤ 720px`: сайдбар фиксирован слева оверлеем.
- Сайдбар настроек сворачивается кнопкой ‹/› (268px ↔ 78px), `transition: width .32s cubic-bezier(.4,.1,.2,1)`.

---

## 9. Если дашборд на BI-платформе (Power BI / DataLens / Metabase / Grafana)
Полный `backdrop-filter` там недоступен. Перенеси: **палитру серий, фон, шрифты (если можно кастомные),
правило регистра и стиль подписей**. Эффект стекла замени на полупрозрачные карточки
`rgba(255,255,255,0.08)` + мягкая тень — ближайшее, что поддерживают BI-темы.

---

## 10. Чек-лист приёмки
- [ ] Фон страницы — тёмный градиент `--bg-page`, сквозь стекло видно размытие.
- [ ] Все панели в `.glass .glass-panel`, у заголовков акцентная линия снизу.
- [ ] Заголовки/числа — Unbounded; все лейблы — UPPERCASE с трекингом.
- [ ] Воронка — горизонтальные бары с подсветкой и % конверсии.
- [ ] Источники — donut с холодной палитрой и интерактивной легендой.
- [ ] Графики: текущий `--accent` сплошной, предыдущий `--prev` пунктир.
- [ ] Результат визуально совпадает с `glass-reference.html`.
```
