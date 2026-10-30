const API = 'http://127.0.0.1:8787';

const urlInput = document.getElementById('url');
const sendButton = document.getElementById('send');
const pasteButton = document.getElementById('paste');
const statusNode = document.getElementById('status');
const statusText = document.getElementById('status-text');
const message = document.getElementById('message');
const capture = document.getElementById('capture');

const ONLINE = { text: 'Online', cls: 'online' };
const OFFLINE = { text: 'Offline', cls: '' };

function setStatus(online) {
  const state = online ? ONLINE : OFFLINE;
  statusNode.className = `status ${state.cls}`;
  statusText.textContent = state.text;
  sendButton.disabled = !online || !urlInput.value.trim();
}

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `message ${kind}`;
}

async function ping() {
  try {
    const response = await fetch(`${API}/api/health`, { cache: 'no-store' });
    const data = await response.json();
    setStatus(response.ok && data.ok);
    return response.ok;
  } catch {
    setStatus(false);
    return false;
  }
}

async function send() {
  const url = urlInput.value.trim();
  if (!/^https?:\/\//i.test(url)) {
    setMessage('Enter a valid http or https link.', 'error');
    return;
  }
  sendButton.disabled = true;
  setMessage('Sending…');
  try {
    const response = await fetch(`${API}/api/downloads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    setMessage(`Added: ${data.added?.[0]?.filename || url}`, 'ok');
    urlInput.value = '';
  } catch (error) {
    setMessage(error.message, 'error');
    setStatus(false);
  } finally {
    sendButton.disabled = false;
  }
}

urlInput.addEventListener('input', () => {
  sendButton.disabled = !statusNode.classList.contains('online') || !urlInput.value.trim();
});
urlInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') send();
});

sendButton.addEventListener('click', send);

pasteButton.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    sendButton.disabled = !statusNode.classList.contains('online');
    urlInput.focus();
    setMessage('');
  } catch {
    setMessage('Clipboard permission was denied. Paste with Ctrl+V instead.', 'error');
  }
});

capture.addEventListener('change', async () => {
  await chrome.storage.local.set({ capture: capture.checked });
  setMessage(
    capture.checked
      ? 'New browser downloads will be routed to PulseDM.'
      : 'Browser downloads will stay in Chrome.',
  );
});

(async () => {
  const online = await ping();
  setStatus(online);
  if (!online) {
    setMessage('Start PulseDM first, then reopen this panel.', 'error');
  }
  try {
    const stored = await chrome.storage.local.get(['capture']);
    capture.checked = !!stored.capture;
  } catch {
    /* ignore */
  }
})();
