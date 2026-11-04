const authView = document.querySelector('#auth-view');
const dashboardView = document.querySelector('#dashboard-view');
const authForm = document.querySelector('#auth-form');
const authMessage = document.querySelector('#auth-message');
const uploadForm = document.querySelector('#upload-form');
const uploadMessage = document.querySelector('#upload-message');
const scanList = document.querySelector('#scan-list');
const scanMessage = document.querySelector('#scan-message');
const fileInput = document.querySelector('#file-input');
const fileLabel = document.querySelector('#file-label');
const uploadSubmit = document.querySelector('#upload-submit');
const passwordInput = document.querySelector('#password');
const passwordHint = document.querySelector('#password-hint');

let authMode = 'login';
let refreshTimer;

document.querySelector('#login-mode').addEventListener('click', () => setAuthMode('login'));
document.querySelector('#register-mode').addEventListener('click', () => setAuthMode('register'));
document.querySelector('#refresh-button').addEventListener('click', () => loadScans());
document.querySelector('#logout-button').addEventListener('click', logout);

authForm.addEventListener('submit', submitAuthForm);
uploadForm.addEventListener('submit', uploadFile);
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileLabel.textContent = file ? file.name : 'Choose a file to scan';
  uploadSubmit.disabled = !file;
  uploadMessage.textContent = '';
  uploadMessage.classList.remove('success');
});

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.querySelector('#auth-title').textContent = registering
    ? 'Create your account'
    : 'Welcome back';
  document.querySelector('#auth-description').textContent = registering
    ? 'Set up a private space for your file scans.'
    : 'Sign in to continue to your scans.';
  document.querySelector('#auth-submit').innerHTML = registering
    ? 'Create account <span aria-hidden="true">→</span>'
    : 'Sign in <span aria-hidden="true">→</span>';
  document.querySelector('#login-mode').classList.toggle('active', !registering);
  document.querySelector('#register-mode').classList.toggle('active', registering);
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  passwordInput.minLength = registering ? 12 : 1;
  passwordHint.hidden = !registering;
  authMessage.textContent = '';
  authMessage.classList.remove('success');
}

async function submitAuthForm(event) {
  event.preventDefault();
  setMessage(authMessage, '', false);
  const submit = document.querySelector('#auth-submit');
  submit.disabled = true;
  submit.textContent = authMode === 'register' ? 'Creating account…' : 'Signing in…';

  try {
    const response = await fetch(`/auth/${authMode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value,
        password: passwordInput.value,
      }),
    });
    const body = await readResponse(response);
    if (!response.ok) throw new Error(body.error || 'Could not sign in. Try again.');
    authForm.reset();
    await showDashboard(body.email);
  } catch (error) {
    setMessage(authMessage, error.message, false);
  } finally {
    submit.disabled = false;
    submit.innerHTML =
      authMode === 'register'
        ? 'Create account <span aria-hidden="true">→</span>'
        : 'Sign in <span aria-hidden="true">→</span>';
  }
}

async function showDashboard(email) {
  authView.hidden = true;
  dashboardView.hidden = false;
  document.querySelector('#account-email').textContent = email;
  await loadScans();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(loadScans, 4000);
}

async function logout() {
  await fetch('/auth/logout', { method: 'POST' });
  clearInterval(refreshTimer);
  dashboardView.hidden = true;
  authView.hidden = false;
  authForm.reset();
  setAuthMode('login');
  setMessage(authMessage, 'You are signed out.', true);
}

async function uploadFile(event) {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    setMessage(uploadMessage, 'Choose a file smaller than 10 MB.', false);
    return;
  }

  uploadSubmit.disabled = true;
  uploadSubmit.textContent = 'Uploading…';
  setMessage(uploadMessage, '', false);
  const form = new FormData();
  form.append('file', file);

  try {
    const response = await fetch('/scans', { method: 'POST', body: form });
    const body = await readResponse(response);
    if (response.status === 401) return showAuth();
    if (!response.ok) throw new Error(body.error || 'Upload failed. Try again.');
    setMessage(uploadMessage, 'Scan queued. Results will appear below.', true);
    uploadForm.reset();
    fileLabel.textContent = 'Choose a file to scan';
    await loadScans();
  } catch (error) {
    setMessage(uploadMessage, error.message, false);
  } finally {
    uploadSubmit.disabled = !fileInput.files[0];
    uploadSubmit.innerHTML = 'Start scan <span aria-hidden="true">→</span>';
  }
}

async function loadScans() {
  try {
    const response = await fetch('/scans');
    if (response.status === 401) return showAuth();
    const body = await readResponse(response);
    if (!response.ok) throw new Error(body.error || 'Could not load scans.');
    renderScans(body);
  } catch (error) {
    setMessage(scanMessage, error.message, false);
  }
}

function renderScans(scans) {
  scanList.replaceChildren();
  setMessage(scanMessage, '', false);
  if (scans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No scans yet. Choose a file above to start your first scan.';
    scanList.append(empty);
    return;
  }

  for (const scan of scans) {
    const row = document.createElement('article');
    row.className = 'scan-row';

    const filename = document.createElement('div');
    filename.className = 'scan-file';
    filename.textContent = scan.originalFilename;

    const hash = document.createElement('div');
    hash.className = 'scan-hash';
    hash.textContent = scan.sha256
      ? `${scan.sha256.slice(0, 10)}…${scan.sha256.slice(-6)}`
      : 'Hash pending';

    const status = document.createElement('span');
    status.className = `scan-status ${scan.status.toLowerCase()}`;
    status.textContent = scan.status;

    const time = document.createElement('time');
    time.className = 'scan-time';
    time.dateTime = scan.updatedAt;
    time.textContent = formatTime(scan.updatedAt);

    row.append(filename, hash, status, time);
    const reason = scan.result?.reasons;
    if (Array.isArray(reason) && reason.length > 0) {
      const details = document.createElement('div');
      details.className = 'scan-reason';
      details.textContent = `Finding: ${reason.join(', ')}`;
      row.append(details);
    }
    scanList.append(row);
  }
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently updated';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

async function readResponse(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function setMessage(element, message, success) {
  element.textContent = message;
  element.classList.toggle('success', success && Boolean(message));
}

function showAuth() {
  clearInterval(refreshTimer);
  dashboardView.hidden = true;
  authView.hidden = false;
}

async function initialize() {
  try {
    const response = await fetch('/auth/me');
    if (!response.ok) throw new Error('No active session');
    const user = await response.json();
    await showDashboard(user.email);
  } catch {
    authView.hidden = false;
    dashboardView.hidden = true;
  }
}

initialize();
