/**
 * Экран входа. Он же — экран первого запуска.
 *
 * Одна страница на два состояния сознательно: пока администратора нет,
 * приложением всё равно пользоваться нельзя, и отдельный экран установки
 * означал бы второй адрес, который потом надо не забыть закрыть. Здесь
 * закрывать нечего: сервер сам перестаёт принимать создание администратора,
 * как только он появился (`/api/auth/setup` отвечает 409).
 */

const els = {
  form: document.querySelector('#loginForm'),
  login: document.querySelector('#login'),
  name: document.querySelector('#name'),
  nameField: document.querySelector('#nameField'),
  password: document.querySelector('#password'),
  passwordHint: document.querySelector('#passwordHint'),
  error: document.querySelector('#loginError'),
  submit: document.querySelector('#submitButton'),
  title: document.querySelector('#loginTitle'),
  lead: document.querySelector('#loginLead')
};

let mode = 'login';

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = !message;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Пустой или неразобранный ответ — ниже превратится во внятное сообщение.
  }
  if (!response.ok || !payload?.success) {
    const message = payload?.error?.message
      || (response.status === 429
        ? 'Слишком много попыток входа. Подождите немного.'
        : 'Не удалось связаться с сервером. Попробуйте ещё раз.');
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

function applySetupMode() {
  mode = 'setup';
  els.title.textContent = 'Первый запуск';
  els.lead.textContent = 'Администраторов ещё нет. Создайте первого — под ним вы будете добавлять сотрудников.';
  els.nameField.hidden = false;
  els.passwordHint.hidden = false;
  els.password.autocomplete = 'new-password';
  els.submit.textContent = 'Создать администратора';
}

async function boot() {
  try {
    const state = await (await fetch('/api/auth/me')).json();
    // Уже вошли — на странице входа делать нечего.
    if (state?.data?.user) {
      location.replace('/');
      return;
    }
    if (state?.data?.needsSetup) applySetupMode();
  } catch {
    showError('Сервер не отвечает. Обновите страницу.');
  }
  els.login.focus();
}

els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  els.submit.disabled = true;
  els.submit.classList.add('is-busy');

  const login = els.login.value.trim();
  const password = els.password.value;

  try {
    if (mode === 'setup') {
      await api('/api/auth/setup', { login, password, name: els.name.value.trim() });
    } else {
      await api('/api/auth/login', { login, password });
    }
    // Полная перезагрузка, а не история: после входа приложение должно
    // подняться с чистого состояния и заново прочитать, кто вошёл.
    location.replace('/');
  } catch (error) {
    showError(error.message);
    els.password.value = '';
    els.password.focus();
  } finally {
    els.submit.disabled = false;
    els.submit.classList.remove('is-busy');
  }
});

boot();
