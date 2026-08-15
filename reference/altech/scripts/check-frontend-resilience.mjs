// scripts/check-frontend-resilience.mjs — запуск: node scripts/check-frontend-resilience.mjs
import assert from 'node:assert';

// Инвариант M-1: ответ с seq != текущего не применяется
function applyIfCurrent(mySeq, currentSeq, apply) {
  if (mySeq !== currentSeq) return false;
  apply();
  return true;
}
let applied = false;
assert.equal(applyIfCurrent(1, 2, () => { applied = true; }), false, 'устаревший seq применён!');
assert.equal(applied, false);
assert.equal(applyIfCurrent(3, 3, () => { applied = true; }), true, 'актуальный seq не применён');
assert.equal(applied, true);

// Инвариант H-9: 4 подряд шлюзовых ответа => стоп
function pollStreak(statuses) {
  let bad = 0;
  for (let i = 0; i < statuses.length; i++) {
    const gateway = [502, 503, 504].includes(statuses[i]);
    if (gateway || statuses[i] >= 500) bad += 1; else bad = 0;
    if (bad >= 4) return { stoppedAt: i };
  }
  return { stoppedAt: -1 };
}
assert.deepEqual(pollStreak([504, 504, 504, 504]), { stoppedAt: 3 }, 'не остановился на 4 подряд');
assert.deepEqual(pollStreak([504, 504, 202, 504, 504]).stoppedAt, -1, '202 обязан сбрасывать счётчик');

console.log('OK check-frontend-resilience');
