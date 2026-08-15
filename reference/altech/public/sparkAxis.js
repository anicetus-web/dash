// public/sparkAxis.js — чистые функции оси Y спарклайнов (общие для app.js и scripts/check-sparklines.mjs).

// «Красивый» шаг: 1 / 2 / 2.5 / 5 × 10^n, всегда >= rough.
export function niceStep(rough) {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  if (norm <= 1) return pow;
  if (norm <= 2) return 2 * pow;
  if (norm <= 2.5) return 2.5 * pow;
  if (norm <= 5) return 5 * pow;
  return 10 * pow;
}

// 2–3 круглых деления в пределах [min, max] шкалы спарклайна.
// min/max — те же границы, что использует py() рендерера, поэтому деления ложатся точно на шкалу.
export function sparkYTicks(min, max) {
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const step = niceStep((hi - lo) / 2);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6); // защита от накопления плавающей запятой
  }
  return ticks.slice(0, 3);
}
