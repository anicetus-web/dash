// Проверки хранилища снимка: форма, атомарность записи, карантин повреждённого файла.
// Проверяется поведение (что происходит с файлом и с данными), а не факт вызова функций.
import assert from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { EMPTY_CACHE, JsonStore, emptySnapshot } from '../src/storage/jsonStore.js';
import { ROOT_DIR } from '../src/config.js';

let failed = 0;

async function check(name, run) {
  try {
    await run();
    console.log(`ok: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name} → ${error.message}`);
  }
}

const dir = await mkdtemp(join(tmpdir(), 'funnel-store-'));
let counter = 0;
// Каждая проверка работает со своим файлом: одна не должна зависеть от следов другой.
const freshFile = () => join(dir, `snapshot-${(counter += 1)}.json`);
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const tmpLeftovers = async () => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

// Момент времени инъектируется, чтобы ожидания не зависели от текущей секунды.
const NOW = new Date('2026-08-15T12:00:00.000Z');

await check('снимок сохраняется целиком и не оставляет временных файлов', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await store.save({ source: 'demo', companies: [{ id: '1' }], deals: [{ id: '10', companyId: '1' }] }, { now: NOW });
  const saved = await readJson(file);
  assert.strictEqual(saved.companies.length, 1);
  assert.strictEqual(saved.deals[0].companyId, '1');
  assert.strictEqual(saved.updatedAt, NOW.toISOString(), 'момент записи проставляется стором');
  assert.deepStrictEqual(await tmpLeftovers(), [], 'временный файл после записи не остаётся');
});

await check('снимок старой схемы дочитывается дефолтами, а не падает на отсутствующем разделе', async () => {
  const file = freshFile();
  // Файл, записанный до появления сделок, историй и метаданных качества.
  await writeFile(file, JSON.stringify({ companies: [{ id: '1' }] }), 'utf8');
  const snapshot = await new JsonStore(file).load();
  assert.deepStrictEqual(snapshot.deals, [], 'новый раздел появился пустым');
  assert.deepStrictEqual(snapshot.assigneeEvents, []);
  assert.strictEqual(snapshot.sync.status, 'idle', 'вложенный раздел добрал дефолты');
  assert.strictEqual(snapshot.dataQuality.dealsWithoutCompany, 0);
  assert.strictEqual(snapshot.companies.length, 1, 'данные из файла сохранены');
});

await check('частично заполненный вложенный раздел не теряет остальные поля', async () => {
  const file = freshFile();
  await writeFile(file, JSON.stringify({ sync: { status: 'error', lastError: 'таймаут портала' } }), 'utf8');
  const snapshot = await new JsonStore(file).load();
  assert.strictEqual(snapshot.sync.status, 'error');
  assert.strictEqual(snapshot.sync.lastError, 'таймаут портала');
  assert.strictEqual(snapshot.sync.lastSuccessAt, null, 'поле, которого не было в файле, взято из формы снимка');
  assert.deepStrictEqual(snapshot.sync.warnings, []);
});

await check('запись сохраняет все разделы формы, даже если источник прислал только часть', async () => {
  const file = freshFile();
  await new JsonStore(file).save({ companies: [{ id: '1' }] }, { now: NOW });
  const saved = await readJson(file);
  for (const key of Object.keys(EMPTY_CACHE)) {
    assert.ok(key in saved, `раздел ${key} должен присутствовать в файле`);
  }
});

await check('пустые снимки не делят между собой массивы', async () => {
  const first = await new JsonStore(freshFile()).load();
  first.companies.push({ id: 'случайно добавленная компания' });
  const second = await new JsonStore(freshFile()).load();
  assert.deepStrictEqual(second.companies, [], 'второй снимок не должен видеть чужие данные');
  assert.deepStrictEqual(EMPTY_CACHE.companies, [], 'эталон формы остался пустым');
  assert.deepStrictEqual(emptySnapshot().companies, []);
});

await check('сбой записи не разрушает предыдущий успешный снимок', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await store.save({ source: 'demo', companies: [{ id: '1' }] }, { now: NOW });
  // BigInt не сериализуется в JSON — воспроизводим сбой ровно в момент сохранения.
  await assert.rejects(() => store.save({ companies: [{ id: 1n }] }, { now: NOW }), 'неудачная запись обязана сообщить об ошибке');
  const saved = await readJson(file);
  assert.strictEqual(saved.companies[0].id, '1', 'на диске остался прежний снимок');
  assert.deepStrictEqual(await tmpLeftovers(), [], 'мусор от сорвавшейся записи убран');
});

await check('битый снимок уходит в карантин, чтение продолжается с пустого', async () => {
  const file = freshFile();
  const broken = '{ "companies": [ {обрыв';
  await writeFile(file, broken, 'utf8');
  const store = new JsonStore(file);
  const snapshot = await store.load();
  assert.deepStrictEqual(snapshot.companies, [], 'вместо исключения — пустой снимок');
  assert.strictEqual(await readFile(`${file}.corrupt`, 'utf8'), broken, 'битое содержимое сохранено как улика');
});

await check('следующее сохранение не затирает улику повреждённого снимка', async () => {
  const file = freshFile();
  const broken = '{ "companies": [ {обрыв';
  await writeFile(file, broken, 'utf8');
  const store = new JsonStore(file);
  await store.load();
  await store.save({ companies: [{ id: '2' }] }, { now: NOW });
  const saved = await readJson(file);
  assert.strictEqual(saved.companies[0].id, '2', 'новый снимок записан');
  assert.strictEqual(await readFile(`${file}.corrupt`, 'utf8'), broken, 'улика не тронута');
});

await check('повторное повреждение не стирает первую улику', async () => {
  const file = freshFile();
  await writeFile(file, 'первый обрыв {', 'utf8');
  await new JsonStore(file).load();
  await writeFile(file, 'второй обрыв {', 'utf8');
  await new JsonStore(file).load();
  assert.strictEqual(await readFile(`${file}.corrupt`, 'utf8'), 'первый обрыв {');
  assert.strictEqual(await readFile(`${file}.corrupt.2`, 'utf8'), 'второй обрыв {');
});

await check('отсутствие файла — штатная ситуация, а не ошибка', async () => {
  const file = join(dir, 'никогда-не-создавался.json');
  const snapshot = await new JsonStore(file).load();
  assert.strictEqual(snapshot.version, EMPTY_CACHE.version);
  assert.deepStrictEqual(snapshot.companies, []);
  const quarantined = (await readdir(dir)).some((name) => name.startsWith('никогда-не-создавался.json.corrupt'));
  assert.strictEqual(quarantined, false, 'отсутствие файла не карантинится');
});

await check('абсолютный путь к снимку не вкладывается в каталог проекта', async () => {
  const absolute = join(dir, 'внешний-том.json');
  assert.ok(isAbsolute(absolute));
  assert.strictEqual(new JsonStore(absolute).file, absolute, 'абсолютный путь используется как есть');
  const relative = new JsonStore('data/snapshot.json').file;
  assert.strictEqual(relative, join(ROOT_DIR, 'data/snapshot.json'), 'относительный путь — от корня проекта');
});

await check('частичное обновление снимка не стирает остальные разделы', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await store.save({ source: 'demo', companies: [{ id: '1' }], managers: [{ id: '7', name: 'Пётр' }] }, { now: NOW });
  await store.replaceSnapshot({ deals: [{ id: '10', companyId: '1' }] }, { now: NOW });
  const saved = await readJson(file);
  assert.strictEqual(saved.companies.length, 1, 'компании остались от прошлого снимка');
  assert.strictEqual(saved.managers[0].name, 'Пётр', 'справочник остался');
  assert.strictEqual(saved.deals.length, 1, 'новый раздел записан');
});

await check('обновление статуса синхронизации не трогает данные снимка', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await store.save(
    { companies: [{ id: '1' }], sync: { status: 'success', lastSuccessAt: '2026-08-15T10:00:00.000Z' } },
    { now: NOW }
  );
  await store.updateSync({ status: 'error', lastError: 'портал недоступен' }, { now: NOW });
  const saved = await readJson(file);
  assert.strictEqual(saved.companies.length, 1, 'данные последнего успешного снимка на месте');
  assert.strictEqual(saved.sync.status, 'error');
  assert.strictEqual(saved.sync.lastError, 'портал недоступен');
  assert.strictEqual(saved.sync.lastSuccessAt, '2026-08-15T10:00:00.000Z', 'дата успеха не сбрасывается ошибкой');
});

await check('две одновременные записи оставляют целый файл без временных остатков', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await Promise.all([
    store.save({ companies: [{ id: '1' }] }, { now: NOW }),
    store.save({ companies: [{ id: '1' }, { id: '2' }] }, { now: NOW })
  ]);
  const saved = await readJson(file);
  assert.ok(Array.isArray(saved.companies), 'файл читается целиком, а не обрывком');
  assert.deepStrictEqual(await tmpLeftovers(), []);
});

await check('снимок в памяти обновляется только после успешной записи на диск', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  await store.save({ companies: [{ id: '1' }] }, { now: NOW });
  await assert.rejects(() => store.save({ companies: [{ id: 2n }] }, { now: NOW }));
  const snapshot = await store.getSnapshot();
  assert.strictEqual(snapshot.companies[0].id, '1', 'в памяти остался снимок, который реально лежит на диске');
});

await check('сведения о файле снимка отличают существующий файл от отсутствующего', async () => {
  const file = freshFile();
  const store = new JsonStore(file);
  assert.strictEqual((await store.snapshotInfo()).exists, false);
  await store.save({ companies: [{ id: '1' }] }, { now: NOW });
  const info = await store.snapshotInfo();
  assert.strictEqual(info.exists, true);
  assert.ok(info.sizeBytes > 0, 'размер файла известен без чтения содержимого');
});

await rm(dir, { recursive: true, force: true });

if (failed) {
  console.error(`\nПроверок хранилища упало: ${failed}`);
  process.exit(1);
}
console.log('\nПроверки хранилища пройдены');
