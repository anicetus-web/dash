// Проверки автосоздания первого администратора из окружения (ensureBootstrapAdmin).
//
// Каждый сценарий получает свой временный файл и передаёт login/password/name
// параметрами вызова, а не через process.env: ensureBootstrapAdmin читает
// config.bootstrapAdmin* только как ДЕФОЛТ (для настоящего вызова при старте
// сервера) — тестам не нужно переключать окружение между вызовами в одном процессе.
import assert from 'node:assert';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBootstrapAdmin, UserStore } from '../src/auth/userStore.js';
import { hashPassword } from '../src/auth/passwords.js';

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

async function freshStore() {
  const workDir = await mkdtemp(join(tmpdir(), 'funnel-auth-'));
  return new UserStore(join(workDir, 'users.json'));
}

await check('без логина и пароля ничего не создаётся', async () => {
  const store = await freshStore();
  const result = await ensureBootstrapAdmin(store, {});
  assert.strictEqual(result, null);
  assert.strictEqual(await store.needsSetup(), true);
});

await check('корректные логин и пароль создают администратора', async () => {
  const store = await freshStore();
  const created = await ensureBootstrapAdmin(store, {
    login: 'admin',
    password: 'Qwe202678f',
    name: 'Тестовый админ'
  });
  assert.ok(created, 'ensureBootstrapAdmin должен вернуть созданного пользователя');
  assert.strictEqual(created.login, 'admin');
  assert.strictEqual(created.role, 'admin');
  assert.strictEqual(await store.needsSetup(), false);

  const stored = await store.findByLogin('admin');
  assert.ok(stored, 'пользователь должен быть сохранён в хранилище');
  assert.ok(stored.passwordHash, 'пароль должен быть захеширован, а не сохранён в открытом виде');
  assert.notStrictEqual(stored.passwordHash, 'Qwe202678f');
});

await check('повторный вызов не создаёт второго администратора и не трогает первого', async () => {
  const store = await freshStore();
  const options = { login: 'admin', password: 'Qwe202678f' };
  const first = await ensureBootstrapAdmin(store, options);
  assert.ok(first);
  const second = await ensureBootstrapAdmin(store, options);
  assert.strictEqual(second, null, 'администратор уже есть — повторный вызов должен быть no-op');

  const all = await store.listUsers();
  assert.strictEqual(all.length, 1, 'должен остаться ровно один пользователь');
});

await check('невалидный логин пропускает автосоздание, а не роняет старт', async () => {
  const store = await freshStore();
  const result = await ensureBootstrapAdmin(store, {
    login: 'ю', // короче 3 символов и не латиница — обе причины сразу
    password: 'Qwe202678f'
  });
  assert.strictEqual(result, null);
  assert.strictEqual(await store.needsSetup(), true, 'экран первого запуска должен остаться доступен');
});

await check('слишком короткий пароль пропускает автосоздание, а не роняет старт', async () => {
  const store = await freshStore();
  const result = await ensureBootstrapAdmin(store, { login: 'admin', password: 'коротко' });
  assert.strictEqual(result, null);
  assert.strictEqual(await store.needsSetup(), true);
});

await check('живого администратора автосоздание не перезаписывает', async () => {
  const store = await freshStore();
  await store.addUser({
    login: 'existing-admin',
    name: 'Уже есть',
    passwordHash: await hashPassword('уже-есть-пароль-1'),
    role: 'admin'
  });
  const result = await ensureBootstrapAdmin(store, { login: 'someone-else', password: 'Qwe202678f' });
  assert.strictEqual(result, null, 'администратор уже есть — переменные окружения не должны заводить второго');
  const all = await store.listUsers();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].login, 'existing-admin');
});

console.log(failed === 0 ? '\nПроверки автосоздания администратора пройдены' : `\nПровалено проверок: ${failed}`);
if (failed > 0) process.exit(1);
