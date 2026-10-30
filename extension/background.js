const API = 'http://127.0.0.1:8787';

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title,
      message,
    });
  } catch {
    /* notifications are best-effort */
  }
}

async function sendToPulseDM(url) {
  const response = await fetch(`${API}/api/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `PulseDM returned ${response.status}`);
  return data.added?.[0] || null;
}

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(['capture']);
  if (stored.capture === undefined) {
    await chrome.storage.local.set({ capture: false });
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pulsedm-link',
      title: 'Download with PulseDM',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'pulsedm-media',
      title: 'Download media with PulseDM',
      contexts: ['video', 'audio', 'image'],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) {
    notify('Unsupported link', 'PulseDM can download http and https links only.');
    return;
  }
  try {
    const added = await sendToPulseDM(url);
    notify('Added to PulseDM', added?.filename || url);
  } catch (error) {
    notify('PulseDM is not running', 'Start the PulseDM app, then try again.');
  }
});

// Optional takeover of regular browser downloads.
chrome.downloads.onCreated.addListener(async (item) => {
  try {
    const { capture } = await chrome.storage.local.get(['capture']);
    if (!capture) return;
    if (!item.url || !/^https?:/i.test(item.url)) return;
    if (item.byExtensionId) return;
    const added = await sendToPulseDM(item.url);
    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    notify('Browser download sent to PulseDM', added?.filename || item.url);
  } catch {
    // If PulseDM is offline, leave the browser download untouched.
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'pulsedm:add') {
    sendToPulseDM(message.url)
      .then((added) => sendResponse({ ok: true, added }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  return false;
});
