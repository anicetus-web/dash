// Раннер проверок. Два режима:
//   node scripts/run-checks.mjs           — запускает все scripts/check-*.mjs
//   node scripts/run-checks.mjs --syntax  — синтаксическая проверка всех файлов src/, public/, scripts/
//
// Файлы проверок НЕ перечисляются поимённо: список собирается обходом каталога.
// Так добавление новой проверки не требует правки package.json — а значит, параллельные
// изменения не сталкиваются в одном файле.
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPTS_DIR = join(ROOT_DIR, 'scripts');
const SYNTAX_DIRS = ['src', 'public', 'scripts'];
const SYNTAX_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const CHECK_TIMEOUT_MS = 180000;

// Пути печатаем через '/' независимо от ОС: одинаковый вывод на Windows и Linux.
function show(path) {
  return relative(ROOT_DIR, path).split('\\').join('/');
}

// Обход каталога. Отсутствие каталога — не ошибка: проект собирается по частям,
// и раннер обязан работать, когда половины файлов ещё нет.
async function collectFiles(dir, { extensions = null, prefix = null } = {}) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  const found = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectFiles(full, { extensions, prefix })));
      continue;
    }
    if (!entry.isFile()) continue;
    if (extensions && !extensions.has(extname(entry.name).toLowerCase())) continue;
    if (prefix && !entry.name.startsWith(prefix)) continue;
    found.push(full);
  }
  return found;
}

function runNode(args, { input = null, stdio = 'pipe' } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
      timeout: CHECK_TIMEOUT_MS
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut: false });
    });
    child.on('close', (code, signal) => {
      resolvePromise({
        code: code === null ? 1 : code,
        stdout,
        stderr,
        timedOut: Boolean(signal) && code === null
      });
    });
    if (child.stdin) {
      if (input !== null) child.stdin.end(input);
      else child.stdin.end();
    }
  });
}

// Синтаксическая проверка. Содержимое подаём на stdin с явным --input-type,
// чтобы результат не зависел от того, как конкретная версия Node угадывает ESM в .js.
async function runSyntaxCheck() {
  const files = [];
  for (const dir of SYNTAX_DIRS) {
    files.push(...(await collectFiles(join(ROOT_DIR, dir), { extensions: SYNTAX_EXTENSIONS })));
  }
  if (files.length === 0) {
    console.log('ok: файлов для синтаксической проверки нет');
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    const inputType = extname(file).toLowerCase() === '.cjs' ? 'commonjs' : 'module';
    const { code, stderr } = await runNode(['--check', `--input-type=${inputType}`], {
      input: await readFile(file, 'utf8')
    });
    if (code === 0) {
      console.log(`ok: ${show(file)}`);
      continue;
    }
    failed += 1;
    console.error(`FAIL: ${show(file)} → ${firstMeaningfulLine(stderr)}`);
  }
  console.log(`\nСинтаксис: файлов ${files.length}, с ошибками ${failed}`);
  return failed === 0 ? 0 : 1;
}

// Из вывода node --check берём строку с SyntaxError — остальное это стек внутренностей Node.
function firstMeaningfulLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => /Error/.test(line)) || lines[0] || 'неизвестная ошибка';
}

// Запуск всех проверок. Каждая — отдельный процесс: падение одной не мешает остальным,
// и ни одна не может подпортить состояние соседней через общий модульный кэш.
async function runAllChecks() {
  const files = await collectFiles(SCRIPTS_DIR, { extensions: new Set(['.mjs']), prefix: 'check-' });
  if (files.length === 0) {
    console.log('ok: проверок пока нет — считаю успехом');
    return 0;
  }
  const failures = [];
  for (const file of files) {
    console.log(`\n── ${show(file)} ─────────────────────────────`);
    const { code, timedOut } = await runNode([file], { stdio: 'inherit' });
    if (code === 0) continue;
    failures.push({ file, reason: timedOut ? `превышен лимит ${CHECK_TIMEOUT_MS} мс` : `код выхода ${code}` });
  }
  console.log('\n── Итог ─────────────────────────────');
  for (const file of files) {
    const failure = failures.find((item) => item.file === file);
    if (failure) console.error(`FAIL: ${show(file)} → ${failure.reason}`);
    else console.log(`ok: ${show(file)}`);
  }
  console.log(`Проверок ${files.length}, упало ${failures.length}`);
  return failures.length === 0 ? 0 : 1;
}

const syntaxMode = process.argv.slice(2).includes('--syntax');
const exitCode = syntaxMode ? await runSyntaxCheck() : await runAllChecks();
if (exitCode !== 0) process.exit(exitCode);
