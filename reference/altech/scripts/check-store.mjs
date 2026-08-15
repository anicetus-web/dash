import assert from 'node:assert';
import { mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonStore } from '../src/storage/jsonStore.js';

const exists = (p) => access(p).then(() => true, () => false);
const dir = await mkdtemp(join(tmpdir(), 'store-check-'));
const file = join(dir, 'bi-cache.json');

// (а) save пишет валидный JSON и НЕ оставляет .tmp
const s1 = new JsonStore(file);
await s1.save({ deals: [{ id: 1 }], stageEvents: [{ id: 9 }] });
const parsed = JSON.parse(await readFile(file, 'utf8'));
assert.strictEqual(parsed.deals.length, 1);
assert.strictEqual(parsed.stageEvents.length, 1);
assert.strictEqual(await exists(`${file}.tmp`), false, 'tmp не должен оставаться');
console.log('ok: save атомарен, tmp убран');

// (б) битый целевой файл → карантин *.corrupt, load не падает.
// deals заполнятся из seed-бандла (это штатный фолбэк load()), поэтому проверяем
// не пустоту, а сам факт изоляции битого файла и что load() вернул валидный объект.
await writeFile(file, '{ "deals": [ {broken');
const s2 = new JsonStore(file);
const loaded = await s2.load();
assert.ok(Array.isArray(loaded.deals), 'load вернул валидный кэш, не бросил');
assert.strictEqual(await exists(`${file}.corrupt`), true, 'битый файл изолирован');
console.log('ok: битый кэш уведён в .corrupt');

// (в) ENOENT → результат без .corrupt, без throw (deals могут прийти из seed)
const missing = join(dir, 'nope.json');
const s3 = new JsonStore(missing);
const empty = await s3.load();
assert.ok(Array.isArray(empty.deals), 'ENOENT → валидный кэш без throw');
assert.strictEqual(await exists(`${missing}.corrupt`), false, 'ENOENT не карантинится');
console.log('ok: ENOENT — без карантина, без throw');

await rm(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true }));
