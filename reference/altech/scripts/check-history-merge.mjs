import { mergeStageEvents } from '../src/sync/fullSync.js';

// Прежние события: у сделки 142772 — «Договор подписан» (её перезапрос истории УПАДЁТ),
// у сделки 500 — старое событие (её перезапрос УСПЕШЕН и вернёт новое), у сделки 999 — выбыла из набора.
const previousEvents = [
  { id: 'e1', dealId: '142772', stageId: 'C78:UC_50O081', createdAt: '2026-05-10T00:00:00Z' },
  { id: 'e2', dealId: '500', stageId: 'C78:PREPARATION', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'e3', dealId: '999', stageId: 'C78:PREPARATION', createdAt: '2025-01-01T00:00:00Z' }
];
// Новые строки пришли только по успешной сделке 500.
const newRows = [
  { id: 'e2b', dealId: '500', stageId: 'C78:UC_50O081', createdAt: '2026-05-20T00:00:00Z' }
];
const currentDealIds = new Set(['142772', '500']); // 999 выбыла
const succeeded = new Set(['500']);                 // 142772 — перезапрос упал

const merged = mergeStageEvents(previousEvents, newRows, currentDealIds, succeeded);
const ids = merged.map((e) => e.id).sort();

const cases = [
  ['142772 (упавший перезапрос) СОХРАНИЛА событие «Договор подписан»', merged.some((e) => e.dealId === '142772' && e.stageId === 'C78:UC_50O081'), true],
  ['500 (успех) — старое событие заменено новым', merged.some((e) => e.id === 'e2b') && !merged.some((e) => e.id === 'e2'), true],
  ['999 (выбыла из набора) — события отброшены', merged.some((e) => e.dealId === '999'), false],
  ['итоговый состав событий', JSON.stringify(ids), JSON.stringify(['e1', 'e2b'])]
];

let passed = 0;
for (const [name, got, want] of cases) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'ok' : 'FAIL'}: ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
  if (ok) passed += 1;
}
console.log(JSON.stringify({ ok: passed === cases.length, passed }));
process.exit(passed === cases.length ? 0 : 1);
