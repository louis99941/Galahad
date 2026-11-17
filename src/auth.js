const $ = (id) => document.getElementById(id);
const loginPanel = $('loginPanel');
const loginForm = $('loginForm');
const loginStatus = $('loginStatus');
const appShell = $('appShell');
const logoutButton = $('logoutButton');

function showLogin(message = '') {
  appShell.classList.add('hidden');
  loginPanel.classList.remove('hidden');
  loginStatus.textContent = message;
  $('authUsername').focus();
}

function showApp() {
  loginPanel.classList.add('hidden');
  appShell.classList.remove('hidden');
}

async function checkSession() {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('無法確認登入狀態');
    const data = await response.json();
    if (data.authenticated) showApp();
    else showLogin();
  } catch {
    showLogin('無法連線至登入服務，請重新整理頁面。');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = loginForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  loginStatus.textContent = '正在驗證…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: $('authUsername').value,
        password: $('authPassword').value
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '登入失敗，請檢查帳號密碼。');
    $('authPassword').value = '';
    showApp();
  } catch (error) {
    loginStatus.textContent = error.message || '登入失敗，請稍後再試。';
  } finally {
    submit.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } finally {
    window.location.reload();
  }
});

checkSession();
