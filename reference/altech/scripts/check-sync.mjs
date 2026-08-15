import assert from 'node:assert';
import { isDegradedSync, isTimeoutError, isRetryableError } from '../src/sync/fullSync.js';

// [название, факт, ожидание]
const cases = [
  ['таймаут прокси распознаётся по сообщению', isTimeoutError({ message: 'Bitrix24 batch timed out after 15s' }), true],
  ['наш AbortError по коду', isTimeoutError({ code: 'API_TIMEOUT', message: 'Bitrix24 API timed out' }), true],
  ['слово timeout в сообщении', isTimeoutError({ message: 'Gateway timeout' }), true],
  ['не-таймаут не распознаётся', isTimeoutError({ code: 'API_ERROR', message: 'Route not found' }), false],
  ['пустой кэш + ошибки + 0 сделок → деградация (не писать пусто)', isDegradedSync(0, 0, true), true],
  ['пустой кэш + валидный непустой синк без ошибок → ок (наполняем)', isDegradedSync(0, 1200, false), false],
  ['пустой кэш + частичный непустой синк с ошибками → ок (наполняем)', isDegradedSync(0, 1200, true), false],
  ['здоровый кэш + резкая просадка (>40%) с ошибками → деградация', isDegradedSync(2595, 1000, true), true],
  ['здоровый кэш + просадка без ошибок → ок (реальное уменьшение)', isDegradedSync(2595, 1000, false), false],
  ['здоровый кэш + 0 сделок с ошибками → деградация', isDegradedSync(2595, 0, true), true],
  ['здоровый кэш + просадка 8% с ошибками → деградация (частичная потеря)', isDegradedSync(2595, 2400, true), true],
  // C-4: ретраибельность прод-ошибок прокси/сети
  ['таймаут ретраибелен', isRetryableError({ code: 'API_TIMEOUT' }), true],
  ['fetch failed (undici) ретраибелен', isRetryableError({ message: 'fetch failed' }), true],
  ['ECONNRESET по code ретраибелен', isRetryableError({ code: 'ECONNRESET' }), true],
  ['fetch failed с cause.code ретраибелен', isRetryableError({ message: 'fetch failed', cause: { code: 'ECONNRESET' } }), true],
  ['ETIMEDOUT по code ретраибелен', isRetryableError({ code: 'ETIMEDOUT' }), true],
  ['EAI_AGAIN (DNS) ретраибелен', isRetryableError({ code: 'EAI_AGAIN' }), true],
  ['HTTP 502 (API_ERROR + status) ретраибелен', isRetryableError({ code: 'API_ERROR', status: 502, message: 'HTTP 502' }), true],
  ['HTTP 503 ретраибелен', isRetryableError({ code: 'API_ERROR', status: 503, message: 'HTTP 503' }), true],
  ['HTTP 504 ретраибелен', isRetryableError({ code: 'API_ERROR', status: 504, message: 'HTTP 504' }), true],
  ['бизнес-ошибка 404 НЕ ретраибельна', isRetryableError({ code: 'API_ERROR', status: 404, message: 'Route not found' }), false],
  ['валидационная ошибка НЕ ретраибельна', isRetryableError({ code: 'API_ERROR', status: 400, message: 'Bad filter' }), false],
  // H-4: тихая частичная потеря 25-39% при живом кэше = деградация
  ['здоровый кэш + потеря 30% с ошибками → деградация', isDegradedSync(2443, 1710, true), true],
  ['здоровый кэш + потеря 25% с ошибками → деградация', isDegradedSync(2443, 1832, true), true],
  ['здоровый кэш + потеря 38% с ошибками → деградация', isDegradedSync(2443, 1515, true), true],
  ['здоровый кэш + потеря 30% БЕЗ ошибок → ок (реальное уменьшение)', isDegradedSync(2443, 1710, false), false],
  ['классический «241 из 2443» с ошибками → деградация', isDegradedSync(2443, 241, true), true]
];

let failed = 0;
for (const [name, got, want] of cases) {
  try {
    assert.strictEqual(got, want);
    console.log('ok:', name);
  } catch {
    failed += 1;
    console.error('FAIL:', name, '→ got', got, 'want', want);
  }
}
if (failed) {
  console.error(`${failed}/${cases.length} sync checks failed`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, passed: cases.length }));
