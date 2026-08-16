/**
 * Проверка: `[hidden]` должен побеждать любое правило `display` в CSS.
 *
 * Дважды на этом попадались вживую: пустой бейдж-кружок висел во всех
 * фильтрах в состоянии «Все», и поля «свой период» показывались одновременно
 * с выбранным кварталом, съедая высоту боковой панели. Оба раза причина
 * одна — правило вида `.класс { display: flex }` перебивало `display: none`
 * атрибута `hidden` (у него нулевая специфичность в таблице стилей браузера).
 *
 * Правило `[hidden] { display: none !important; }` в glass-ui.css закрывает
 * весь класс ошибок разом. Эта проверка следит, чтобы оно не потерялось при
 * будущей правке файла, и чтобы рядом не завёлся более специфичный
 * перебивающий селектор (`!important` побеждает по важности, а не по
 * специфичности — второй `!important` с большей специфичностью всё равно
 * победил бы, поэтому проверяется и это).
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const rawCss = readFileSync(fileURLToPath(new URL('../public/glass-ui.css', import.meta.url)), 'utf8');
// Комментарии вырезаны ДО разбора: иначе текст комментария (например, само
// это объяснение) может случайно совпасть с шаблоном правила ниже.
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

check('правило [hidden] с !important объявлено', () => {
  assert.match(css, /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/,
    '[hidden] { display: none !important } не найдено в glass-ui.css');
});

check('ни один другой селектор не переопределяет display с !important', () => {
  // Любое другое правило с `!important` на `display` било бы по важности
  // наравне с [hidden] и решался бы порядок по специфичности — то самое,
  // чего это правило избегает нарочно.
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const offenders = rules
    .filter(([, selector]) => selector.trim() !== '[hidden]')
    .filter(([, , body]) => /display\s*:[^;]*!important/.test(body))
    .map(([, selector]) => selector.trim());
  assert.strictEqual(offenders.length, 0, `есть ещё display!important: ${offenders.join(', ')}`);
});

console.log(failed === 0 ? '\nПроверка [hidden] пройдена' : `\n${failed} проверок упало`);
process.exit(failed === 0 ? 0 : 1);
