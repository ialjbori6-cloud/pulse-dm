/* PulseDM client — talks to the local engine over REST + SSE. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ICONS = {
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  external: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M21 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 13 4 4L19 7"/>',
  video: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  app: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  archive: '<rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4"/><path d="M8 3v4"/><path d="M3 11h18"/>',
};

const CATEGORY_ICON = {
  video: 'video',
  audio: 'audio',
  document: 'document',
  app: 'app',
  archive: 'archive',
  image: 'image',
  other: 'file',
};

const STATUS_LABEL = {
  starting: 'Connecting',
  downloading: 'Downloading',
  queued: 'Queued',
  paused: 'Paused',
  scheduled: 'Scheduled',
  completed: 'Completed',
  error: 'Failed',
};

const FILTER_TITLES = {
  all: 'All downloads',
  active: 'In progress',
  unfinished: 'Unfinished',
  finished: 'Finished',
  video: 'Video',
  audio: 'Music',
  document: 'Documents',
  app: 'Programs',
  archive: 'Compressed',
  image: 'Images',
  other: 'Other',
};

const CATEGORIES = ['video', 'audio', 'document', 'app', 'archive', 'image', 'other'];

const state = {
  downloads: [],
  stats: { active: 0, queued: 0, paused: 0, completed: 0, error: 0, speed: 0, downloaded: 0 },
  settings: {
    defaultDir: '',
    maxConcurrent: 3,
    defaultConnections: 8,
    speedLimit: 0,
    schedule: { enabled: false, start: '01:00', stop: '07:00' },
    clipboardWatch: true,
  },
  paused: false,
  scheduleBlocked: false,
  filter: 'all',
  search: '',
  drawerId: null,
  samples: [],
  online: false,
  initialized: false,
  lastStatuses: new Map(),
  themeBeforeSettings: null,
  probeToken: 0,
  dropDepth: 0,
  reconnecting: false,
};

const els = {
  list: null,
  empty: null,
  queue: null,
  drawer: null,
  backdrop: null,
  addDialog: null,
  settingsDialog: null,
  toasts: null,
  sparkline: null,
  dropOverlay: null,
};

const rowCache = new Map();
const numberFmt = new Intl.NumberFormat(undefined);

/* ============================================================
   Helpers
   ============================================================ */

function icon(name, size = 18, stroke = 1.8) {
  const body = ICONS[name] || ICONS.file;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** index;
  return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function formatSpeed(bytes) {
  return `${formatBytes(bytes)}/s`;
}

function formatEta(seconds) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}

function timeAgo(timestamp) {
  if (!timestamp) return '—';
  const diff = Math.max(0, Date.now() - timestamp);
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return 'unknown source';
  }
}

function percentOf(item) {
  if (!item.size) return item.status === 'completed' ? 100 : 0;
  return Math.max(0, Math.min(100, (item.received / item.size) * 100));
}

function progressText(item) {
  const pct = Math.floor(percentOf(item));
  if (item.status === 'completed') return '100%';
  if (item.status === 'error') return 'Failed';
  if (item.status === 'queued') return 'Queued';
  if (item.status === 'scheduled') return 'Scheduled';
  if (!item.size) return item.received ? formatBytes(item.received) : '…';
  return `${pct}%`;
}

function subtitleText(item) {
  switch (item.status) {
    case 'completed':
      return `${formatBytes(item.size)} saved ${timeAgo(item.completedAt)}`;
    case 'error':
      return item.error || 'Download failed';
    case 'paused':
      return item.received
        ? `${formatBytes(item.received)} of ${formatBytes(item.size)} · paused`
        : 'Paused';
    case 'scheduled':
      return item.startAt ? `Starts ${new Date(item.startAt).toLocaleString()}` : 'Scheduled';
    case 'queued':
      return 'Waiting for a free slot';
    case 'starting':
      return 'Contacting the server…';
    case 'downloading':
      return item.size
        ? `${formatBytes(item.received)} of ${formatBytes(item.size)}`
        : `${formatBytes(item.received)} received`;
    default:
      return '';
  }
}

function speedText(item) {
  if (item.status === 'downloading') return formatSpeed(item.speed);
  if (item.status === 'starting') return 'Connecting…';
  return '—';
}

function speedSub(item) {
  if (item.status === 'downloading' && item.size && item.speed > 0) {
    return formatEta((item.size - item.received) / item.speed);
  }
  if (item.status === 'completed') return 'Saved';
  if (item.status === 'error') return 'Needs retry';
  if (item.status === 'paused') return 'On hold';
  if (item.status === 'queued') return 'Waiting';
  return '';
}

function statusLabel(item) {
  return STATUS_LABEL[item.status] || item.status;
}

function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(/https?:\/\/[^\s"'<>]+/gi) || [];
  return [...new Set(matches.map((entry) => entry.replace(/[),.;]+$/, '')))];
}

function toLocalInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

/* ============================================================
   Toasts
   ============================================================ */

function toast(title, message = '', kind = 'info', action = null) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = `
    <div class="toast-txt"><strong>${escapeHtml(title)}</strong>${message ? `<span>${escapeHtml(message)}</span>` : ''}</div>
    ${action ? `<button class="btn ghost" type="button">${escapeHtml(action.label)}</button>` : ''}
    <button class="toast-close" type="button" aria-label="Dismiss">${icon('close', 13)}</button>
  `;
  const remove = () => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 220);
  };
  $('.toast-close', node).addEventListener('click', remove);
  if (action) {
    $('.btn', node).addEventListener('click', () => {
      remove();
      action.onClick();
    });
  }
  els.toasts.append(node);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();
  setTimeout(remove, action ? 8000 : 5000);
}

/* ============================================================
   Theme + sparkline
   ============================================================ */

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('pulsedm-theme', next);
  } catch {
    /* ignore */
  }
  $$('.theme-choice').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeChoice === next);
  });
  drawSparkline();
}

function drawSparkline() {
  const canvas = els.sparkline;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 10) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const light = document.documentElement.dataset.theme === 'light';
  ctx.strokeStyle = light ? 'rgba(15,23,42,0.07)' : 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 2; i += 1) {
    const y = (height / 3) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const samples = state.samples.length ? state.samples : [0, 0];
  const max = Math.max(...samples, 1);
  const step = width / Math.max(1, samples.length - 1);
  const points = samples.map((value, index) => ({
    x: index * step,
    y: height - 3 - (value / max) * (height - 10),
  }));

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(255,176,32,0.28)');
  gradient.addColorStop(1, 'rgba(255,176,32,0)');
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (const point of points) ctx.lineTo(point.x, point.y);
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#ffb020';
  ctx.fill();
}

/* ============================================================
   State
   ============================================================ */

function filteredDownloads() {
  let items = state.downloads;
  const filter = state.filter;
  if (filter === 'active') {
    items = items.filter((item) => ['starting', 'downloading'].includes(item.status));
  } else if (filter === 'unfinished') {
    items = items.filter((item) => item.status !== 'completed');
  } else if (filter === 'finished') {
    items = items.filter((item) => item.status === 'completed');
  } else if (CATEGORIES.includes(filter)) {
    items = items.filter((item) => item.category === filter);
  }
  const query = state.search.trim().toLowerCase();
  if (query) {
    items = items.filter(
      (item) =>
        (item.filename || '').toLowerCase().includes(query) ||
        (item.url || '').toLowerCase().includes(query),
    );
  }
  return items;
}

function applyState(next) {
  if (!next || !Array.isArray(next.downloads)) return;
  detectTransitions(next.downloads);
  state.downloads = next.downloads;
  state.stats = next.stats || state.stats;
  if (next.settings) state.settings = next.settings;
  state.paused = !!next.paused;
  state.scheduleBlocked = !!next.scheduleBlocked;
  state.online = true;
  state.samples.push(state.stats.speed || 0);
  if (state.samples.length > 80) state.samples.shift();
  state.initialized = true;
  render();
}

function detectTransitions(downloads) {
  if (!state.initialized) {
    for (const item of downloads) state.lastStatuses.set(item.id, item.status);
    return;
  }
  for (const item of downloads) {
    const previous = state.lastStatuses.get(item.id);
    if (previous && previous !== item.status) {
      if (item.status === 'completed') {
        toast('Download complete', item.filename, 'success');
      } else if (item.status === 'error' && previous !== 'error') {
        toast('Download failed', item.error || item.filename, 'error', {
          label: 'Retry',
          onClick: () => runAction('retry', item.id),
        });
      }
    }
    state.lastStatuses.set(item.id, item.status);
  }
  for (const id of state.lastStatuses.keys()) {
    if (!downloads.some((item) => item.id === id)) state.lastStatuses.delete(id);
  }
}

/* ============================================================
   Rendering
   ============================================================ */

function render() {
  renderNav();
  renderHero();
  renderList();
  renderStatus();
  renderDrawer();
  drawSparkline();
}

function renderNav() {
  const counts = { all: state.downloads.length, active: 0, unfinished: 0, finished: 0 };
  const catCounts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const item of state.downloads) {
    if (item.status !== 'completed') counts.unfinished += 1;
    else counts.finished += 1;
    if (['starting', 'downloading'].includes(item.status)) counts.active += 1;
    if (catCounts[item.category] !== undefined) catCounts[item.category] += 1;
  }
  for (const [key, value] of Object.entries({ ...counts, ...catCounts })) {
    const node = document.querySelector(`[data-count="${key}"]`);
    if (node) node.textContent = value;
  }
  $$('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === state.filter);
  });

  const title = FILTER_TITLES[state.filter] || 'All downloads';
  $('#view-title').textContent = title;
  const items = filteredDownloads();
  const suffix = state.search ? ` matching “${state.search}”` : '';
  $('#view-sub').textContent = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'}${suffix}`
    : `Nothing here${suffix}`;

  $('#folder-path').textContent = state.settings.defaultDir || 'Downloads';
  $('#open-folder').title = `Open ${state.settings.defaultDir || 'download folder'}`;

  const pauseButton = $('#pause-all');
  pauseButton.textContent = state.paused ? 'Resume all' : 'Pause all';
  pauseButton.disabled = !state.downloads.length;
  pauseButton.classList.toggle('active', state.paused);
}

function renderHero() {
  const { stats } = state;
  $('#hero-speed').textContent = formatSpeed(stats.speed || 0);
  $('#side-speed').textContent = formatSpeed(stats.speed || 0);
  $('#stat-active').textContent = stats.active || 0;
  $('#stat-queued').textContent = (stats.queued || 0) + (stats.scheduled || 0);
  $('#stat-completed').textContent = stats.completed || 0;
  $('#stat-total').textContent = formatBytes(stats.downloaded || 0);
  $('#side-total').textContent = `${formatBytes(stats.downloaded || 0)} downloaded`;

  const trend = $('#hero-trend');
  trend.className = 'trend';
  if (state.scheduleBlocked) {
    trend.textContent = 'scheduled hold';
    trend.classList.add('hold');
    $('#side-state').textContent = 'Scheduled hold';
  } else if (state.paused) {
    trend.textContent = 'paused';
    trend.classList.add('hold');
    $('#side-state').textContent = 'Queue paused';
  } else if (stats.active > 0) {
    trend.textContent = `${stats.active} active`;
    trend.classList.add('live');
    $('#side-state').textContent = `${stats.active} active`;
  } else {
    trend.textContent = 'idle';
    $('#side-state').textContent = 'Idle';
  }

  const activeItems = state.downloads.filter((item) =>
    ['downloading', 'starting'].includes(item.status),
  );
  let got = 0;
  let total = 0;
  for (const item of activeItems) {
    got += item.received || 0;
    total += item.size || 0;
  }
  const fill = total ? Math.max(2, Math.min(100, (got / total) * 100)) : 0;
  $('#hero-fill').style.width = `${fill}%`;

  const banner = $('#scheduler-banner');
  if (state.scheduleBlocked || state.paused) {
    banner.hidden = false;
    $('#banner-text').textContent = state.scheduleBlocked
      ? `Scheduled window is closed. Downloads resume between ${state.settings.schedule.start} and ${state.settings.schedule.stop}.`
      : 'The queue is paused. Active transfers are on hold.';
    $('#banner-action').textContent = state.scheduleBlocked ? 'Disable schedule' : 'Resume all';
  } else {
    banner.hidden = true;
  }
}

function createRow(item) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.id = item.id;
  row.tabIndex = 0;
  row.innerHTML = `
    <div class="file">
      <div class="file-ico"></div>
      <div class="file-txt">
        <span class="file-name"></span>
        <span class="file-host"></span>
      </div>
    </div>
    <div class="status-cell"><span class="pill"></span></div>
    <div class="size-cell"><span class="size-main"></span><small class="size-sub"></small></div>
    <div class="progress-cell">
      <div class="bar"><div class="bar-fill"></div></div>
      <div class="bar-meta"><span class="pct"></span><span class="bar-sub"></span></div>
    </div>
    <div class="speed-cell"><span class="speed-main"></span><small class="speed-sub"></small></div>
    <div class="tools"></div>
  `;
  row.addEventListener('click', (event) => {
    if (event.target.closest('[data-action]')) return;
    openDrawer(item.id);
  });
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      if (event.target.closest('[data-action]')) return;
      event.preventDefault();
      openDrawer(item.id);
    }
  });
  return row;
}

function toolsMarkup(item) {
  const buttons = [];
  const add = (action, name, label, danger = false) => {
    buttons.push(
      `<button class="tool${danger ? ' danger' : ''}" type="button" data-action="${action}" title="${label}" aria-label="${label}">${icon(name, 15)}</button>`,
    );
  };
  if (['starting', 'downloading', 'queued'].includes(item.status)) {
    add('pause', 'pause', 'Pause');
    add('remove', 'trash', 'Remove', true);
  } else if (['paused', 'scheduled'].includes(item.status)) {
    add('resume', 'play', 'Resume');
    add('remove', 'trash', 'Remove', true);
  } else if (item.status === 'error') {
    add('retry', 'retry', 'Retry');
    add('remove', 'trash', 'Remove', true);
  } else if (item.status === 'completed') {
    add('open', 'external', 'Open file');
    add('reveal', 'folder', 'Show in folder');
    add('remove', 'trash', 'Remove from list', true);
  }
  return buttons.join('');
}

function updateRow(row, item) {
  const context = item.status;
  if (row.dataset.context !== context) {
    row.dataset.context = context;
    $('.tools', row).innerHTML = toolsMarkup(item);
  }
  row.className = [
    'row',
    context,
    item.status === 'downloading' && !item.size ? 'indeterminate' : '',
    state.drawerId === item.id ? 'is-open' : '',
  ]
    .filter(Boolean)
    .join(' ');
  row.dataset.id = item.id;

  const iconWrap = $('.file-ico', row);
  if (iconWrap.dataset.category !== item.category) {
    iconWrap.dataset.category = item.category;
    iconWrap.className = `file-ico ${item.category}`;
    iconWrap.innerHTML = icon(CATEGORY_ICON[item.category] || 'file', 19);
  }

  const name = item.filename || hostOf(item.url);
  $('.file-name', row).textContent = name;
  $('.file-name', row).title = name;

  const host = $('.file-host', row);
  const parts = item.resumable && item.connections > 1 ? item.connections : 1;
  host.innerHTML = `<span>${escapeHtml(hostOf(item.finalUrl || item.url))}</span><span class="tag">${parts}×</span>`;

  const pill = $('.pill', row);
  pill.className = `pill ${item.status}`;
  pill.textContent = statusLabel(item);
  pill.title = item.error || '';

  $('.size-main', row).textContent = item.size ? formatBytes(item.size) : '—';
  $('.size-sub', row).textContent = item.size ? `${numberFmt.format(item.size)} B` : 'unknown size';

  const pct = percentOf(item);
  $('.bar-fill', row).style.width = `${item.status === 'completed' ? 100 : pct}%`;
  $('.pct', row).textContent = progressText(item);
  $('.bar-sub', row).textContent = subtitleText(item);

  $('.speed-main', row).textContent = speedText(item);
  $('.speed-sub', row).textContent = speedSub(item);
}

function renderList() {
  const items = filteredDownloads();
  const queue = els.queue;
  const head = $('.queue-head');
  const hasItems = items.length > 0;
  els.empty.hidden = hasItems;
  els.list.hidden = !hasItems;
  head.hidden = !hasItems;
  queue.classList.toggle('has-items', hasItems);

  if (!hasItems) {
    const hasAny = state.downloads.length > 0;
    $('h3', els.empty).textContent = hasAny ? 'No downloads match this view' : 'Nothing in the queue';
    $('p', els.empty).textContent = hasAny
      ? 'Try another category or clear the search field.'
      : 'Drop a link anywhere on this page, or paste one and PulseDM will split it into parallel connections.';
    $('#empty-add').hidden = hasAny;
    for (const row of rowCache.values()) row.remove();
    rowCache.clear();
    return;
  }

  const seen = new Set();
  items.forEach((item, index) => {
    seen.add(item.id);
    let row = rowCache.get(item.id);
    if (!row) {
      row = createRow(item);
      rowCache.set(item.id, row);
    }
    updateRow(row, item);
    const reference = els.list.children[index] || null;
    if (reference !== row) els.list.insertBefore(row, reference);
  });
  for (const [id, row] of rowCache) {
    if (!seen.has(id)) {
      row.remove();
      rowCache.delete(id);
    }
  }
}

function renderStatus() {
  const dot = $('#conn-dot');
  dot.classList.toggle('online', state.online);
  const left = $('#status-left');
  if (!state.online) {
    left.textContent = 'Reconnecting to the local engine…';
  } else if (state.downloads.length === 0) {
    left.textContent = 'Engine ready — drop a link to begin';
  } else if (state.paused) {
    left.textContent = 'Queue paused by you';
  } else if (state.scheduleBlocked) {
    left.textContent = 'Scheduler is holding the queue';
  } else if (state.stats.active) {
    left.textContent = `${state.stats.active} downloading at ${formatSpeed(state.stats.speed)}`;
  } else {
    left.textContent = 'Idle — no active transfers';
  }
  const mid = $('#status-mid');
  mid.textContent = `${state.stats.queued || 0} queued · ${state.stats.paused || 0} paused · ${state.stats.completed || 0} finished`;
}

/* ============================================================
   Drawer
   ============================================================ */

function openDrawer(id) {
  const item = state.downloads.find((entry) => entry.id === id);
  if (!item) return;
  state.drawerId = id;
  els.drawer.hidden = false;
  els.backdrop.hidden = false;
  els.drawer.dataset.id = id;
  renderDrawer();
  requestAnimationFrame(() => els.drawer.classList.add('open'));
  $$('.row').forEach((row) => row.classList.toggle('is-open', row.dataset.id === id));
}

function closeDrawer() {
  state.drawerId = null;
  els.drawer.classList.remove('open');
  els.backdrop.hidden = true;
  $$('.row.is-open').forEach((row) => row.classList.remove('is-open'));
  setTimeout(() => {
    if (state.drawerId === null) {
      els.drawer.hidden = true;
      els.drawer.innerHTML = '';
      els.drawer.removeAttribute('data-id');
    }
  }, 240);
}

function drawerActions(item) {
  const buttons = [];
  const add = (action, name, label) => {
    buttons.push(
      `<button class="btn ghost" type="button" data-action="${action}">${icon(name, 15)} ${label}</button>`,
    );
  };
  if (['downloading', 'starting', 'queued'].includes(item.status)) {
    buttons.push(
      `<button class="btn primary" type="button" data-action="pause">${icon('pause', 15)} Pause</button>`,
    );
  }
  if (['paused', 'error', 'scheduled'].includes(item.status)) {
    buttons.push(
      `<button class="btn primary" type="button" data-action="resume">${icon(item.status === 'error' ? 'retry' : 'play', 15)} ${item.status === 'error' ? 'Retry' : 'Resume'}</button>`,
    );
  }
  if (item.status === 'completed') {
    buttons.push(
      `<button class="btn primary" type="button" data-action="open">${icon('external', 15)} Open file</button>`,
    );
  }
  add('reveal', 'folder', 'Show in folder');
  if (item.status === 'completed') add('delete-file', 'trash', 'Delete file');
  else add('remove', 'trash', 'Remove');
  return buttons.join('');
}

function renderDrawer() {
  if (!state.drawerId) return;
  const item = state.downloads.find((entry) => entry.id === state.drawerId);
  if (!item) {
    closeDrawer();
    return;
  }
  const scrollNode = $('.drawer-scroll', els.drawer);
  const scrollTop = scrollNode?.scrollTop || 0;
  const pct = percentOf(item);
  const segments = item.segments || [];
  const cells = Array.from({ length: Math.max(16, segments.length) }, (_, index) => {
    const value = segments[index] || 0;
    const cls = value >= 0.999 ? 'done' : value > 0 ? 'partial' : '';
    return `<span class="chunk ${cls}" title="${Math.round(value * 100)}%"></span>`;
  }).join('');

  const eta =
    item.status === 'downloading' && item.speed > 0 && item.size
      ? formatEta((item.size - item.received) / item.speed)
      : '—';

  const meta = [
    ['Status', statusLabel(item)],
    ['Size', item.size ? `${formatBytes(item.size)} (${numberFmt.format(item.size)} bytes)` : 'Unknown'],
    ['Downloaded', formatBytes(item.received)],
    ['Speed', item.status === 'downloading' ? formatSpeed(item.speed) : '—'],
    ['Time left', eta],
    ['Connections', item.resumable ? `${item.connections} parallel · resumable` : 'Single stream'],
    ['Category', item.category],
    ['Started', formatDate(item.startedAt)],
    ['Finished', item.status === 'completed' ? formatDate(item.completedAt) : '—'],
  ];
  if (item.error) meta.push(['Error', item.error]);

  els.drawer.innerHTML = `
    <div class="drawer-head">
      <div class="file-ico ${item.category}">${icon(CATEGORY_ICON[item.category] || 'file', 22)}</div>
      <div class="drawer-title">
        <h3 title="${escapeHtml(item.filename)}">${escapeHtml(item.filename || 'Resolving…')}</h3>
        <span class="pill ${item.status}">${statusLabel(item)}</span>
      </div>
      <button class="icon-btn" type="button" data-action="close-drawer" aria-label="Close details">${icon('close', 16)}</button>
    </div>
    <div class="drawer-scroll">
      <div class="drawer-progress">
        <div class="bar"><div class="bar-fill" style="width:${item.status === 'completed' ? 100 : pct}%"></div></div>
        <div class="drawer-progress-meta">
          <strong>${progressText(item)}</strong>
          <span>${formatBytes(item.received)} of ${item.size ? formatBytes(item.size) : 'unknown'}</span>
        </div>
      </div>
      <div class="drawer-actions">${drawerActions(item)}</div>
      <section class="drawer-section">
        <h4>Connection map</h4>
        <div class="chunk-grid">${cells}</div>
        <div class="chunk-legend"><span>${item.chunkCount || 0} parts</span><span>${item.resumable ? 'Range requests enabled' : 'Sequential stream'}</span></div>
      </section>
      <section class="drawer-section">
        <h4>Details</h4>
        <div class="meta-list">
          ${meta
            .map(
              ([label, value]) =>
                `<div class="meta-row"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`,
            )
            .join('')}
          <div class="meta-row"><span>Save to</span><strong class="mono">${escapeHtml(item.dir)}</strong></div>
          <div class="meta-row"><span>Source</span><strong class="mono">${escapeHtml(item.finalUrl || item.url)}</strong></div>
        </div>
      </section>
    </div>
  `;
  if (scrollNode) {
    const next = $('.drawer-scroll', els.drawer);
    if (next) next.scrollTop = scrollTop;
  }
}

/* ============================================================
   Actions
   ============================================================ */

async function runAction(action, id) {
  const item = state.downloads.find((entry) => entry.id === id);
  try {
    if (action === 'close-drawer') return closeDrawer();
    if (action === 'pause') {
      await api(`/downloads/${id}/pause`, { method: 'POST' });
      return;
    }
    if (action === 'resume' || action === 'retry') {
      await api(`/downloads/${id}/resume`, { method: 'POST' });
      return;
    }
    if (action === 'open') {
      await api(`/downloads/${id}/open`, { method: 'POST' });
      return;
    }
    if (action === 'reveal') {
      await api(`/downloads/${id}/reveal`, { method: 'POST' });
      return;
    }
    if (action === 'remove' || action === 'delete-file') {
      const deleteFile = action === 'delete-file';
      if (action === 'remove' && item && item.status !== 'completed') {
        if (!confirm(`Remove “${item.filename || 'this download'}” and delete its partial data?`)) return;
      }
      if (deleteFile) {
        if (!confirm(`Permanently delete “${item.filename || 'this file'}” from disk?`)) return;
      }
      await api(`/downloads/${id}?deleteFile=${deleteFile ? '1' : '0'}`, { method: 'DELETE' });
      if (state.drawerId === id) closeDrawer();
      toast(deleteFile ? 'File deleted' : 'Removed from list', item?.filename || '', 'info');
    }
  } catch (error) {
    toast('Action failed', error.message, 'error');
  }
}

async function togglePauseAll() {
  try {
    await api(state.paused ? '/resume-all' : '/pause-all', { method: 'POST' });
  } catch (error) {
    toast('Queue error', error.message, 'error');
  }
}

async function clearCompleted() {
  const finished = state.downloads.filter((item) => item.status === 'completed');
  if (!finished.length) {
    toast('Nothing to clear', 'There are no completed downloads yet.', 'info');
    return;
  }
  if (!confirm(`Remove ${finished.length} completed download${finished.length === 1 ? '' : 's'} from the list? Files stay on disk.`)) {
    return;
  }
  try {
    await api('/clear-completed', { method: 'POST' });
    toast('List cleared', 'Downloaded files were left on disk.', 'success');
  } catch (error) {
    toast('Could not clear list', error.message, 'error');
  }
}

/* ============================================================
   Add dialog
   ============================================================ */

function fillConnectionSelect(select, selected) {
  select.innerHTML = Array.from({ length: 16 }, (_, index) => {
    const value = index + 1;
    return `<option value="${value}"${value === selected ? ' selected' : ''}>${value} ${value === 1 ? 'connection' : 'connections'}</option>`;
  }).join('');
}

function openAdd(prefill = '') {
  const dialog = els.addDialog;
  const form = $('#add-form');
  form.reset();
  $('#add-error').hidden = true;
  $('#probe-info').hidden = true;
  $('#add-schedule').checked = false;
  $('#add-start-at').hidden = true;
  $('#add-url').value = prefill;
  $('#add-name').value = '';
  $('#add-dir').value = state.settings.defaultDir || '';
  fillConnectionSelect($('#add-connections'), state.settings.defaultConnections || 8);
  const start = new Date(Date.now() + 60 * 60 * 1000);
  start.setSeconds(0, 0);
  $('#add-start-at').value = toLocalInput(start);
  $('#add-start-at').min = toLocalInput(new Date());
  dialog.showModal();
  setTimeout(() => $('#add-url').focus(), 40);
  if (prefill) probeCurrentUrl();
}

let probeTimer = null;

async function probeCurrentUrl() {
  const url = $('#add-url').value.trim();
  const info = $('#probe-info');
  if (!/^https?:\/\//i.test(url)) {
    info.hidden = true;
    return;
  }
  const token = ++state.probeToken;
  $('#probe-name').textContent = 'Checking link…';
  $('#probe-meta').textContent = 'Reading headers and file size';
  const badge = $('#probe-badge');
  badge.textContent = 'Checking';
  badge.className = 'badge single';
  info.hidden = false;
  try {
    const meta = await api('/probe', { method: 'POST', body: JSON.stringify({ url }) });
    if (token !== state.probeToken) return;
    $('#probe-name').textContent = meta.filename;
    $('#probe-meta').textContent = `${meta.size ? formatBytes(meta.size) : 'Unknown size'} · ${meta.contentType || 'unknown type'}`;
    badge.textContent = meta.resumable ? 'Multi-connection' : 'Single stream';
    badge.className = `badge${meta.resumable ? '' : ' single'}`;
    if (!$('#add-name').value.trim()) $('#add-name').value = meta.filename;
  } catch (error) {
    if (token !== state.probeToken) return;
    info.hidden = false;
    $('#probe-name').textContent = 'Could not inspect link';
    $('#probe-meta').textContent = error.message;
    badge.textContent = 'No headers';
    badge.className = 'badge error';
  }
}

function bindAddDialog() {
  const dialog = els.addDialog;
  const urlInput = $('#add-url');
  urlInput.addEventListener('input', () => {
    clearTimeout(probeTimer);
    const value = urlInput.value.trim();
    if (!/^https?:\/\//i.test(value)) return;
    probeTimer = setTimeout(probeCurrentUrl, 700);
  });
  urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      const value = urlInput.value.trim();
      if (/^https?:\/\//i.test(value)) probeCurrentUrl();
    }, 60);
  });
  $('#fetch-info').addEventListener('click', probeCurrentUrl);

  $('#browse-dir').addEventListener('click', async () => {
    try {
      const result = await api('/pick-folder', { method: 'POST' });
      if (result.path) $('#add-dir').value = result.path;
      else if (result.supported === false) toast('Folder picker unavailable', 'Type the path manually.', 'info');
    } catch (error) {
      toast('Could not open folder picker', error.message, 'error');
    }
  });

  $('#add-schedule').addEventListener('change', (event) => {
    const input = $('#add-start-at');
    input.hidden = !event.target.checked;
    if (event.target.checked) input.focus();
  });

  $('#add-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorNode = $('#add-error');
    errorNode.hidden = true;
    const url = urlInput.value.trim();
    if (!/^https?:\/\/\S+/i.test(url)) {
      errorNode.textContent = 'Enter a valid http or https link.';
      errorNode.hidden = false;
      urlInput.focus();
      return;
    }
    const startCheckbox = $('#add-schedule');
    let startAt = 0;
    if (startCheckbox.checked) {
      const value = $('#add-start-at').value;
      if (!value) {
        errorNode.textContent = 'Choose a start time.';
        errorNode.hidden = false;
        return;
      }
      startAt = new Date(value).getTime();
      if (startAt <= Date.now()) {
        errorNode.textContent = 'The start time must be in the future.';
        errorNode.hidden = false;
        return;
      }
    }
    const submit = $('#add-submit');
    submit.disabled = true;
    try {
      const result = await api('/downloads', {
        method: 'POST',
        body: JSON.stringify({
          url,
          filename: $('#add-name').value.trim(),
          dir: $('#add-dir').value.trim(),
          connections: Number($('#add-connections').value),
          startAt,
        }),
      });
      dialog.close();
      const added = result.added?.[0];
      toast(
        startAt ? 'Scheduled' : 'Download added',
        added?.filename || added?.url || url,
        'success',
      );
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

/* ============================================================
   Settings dialog
   ============================================================ */

function openSettings() {
  const settings = state.settings;
  state.themeBeforeSettings = document.documentElement.dataset.theme;
  $('#set-dir').value = settings.defaultDir || '';
  $('#set-concurrent').innerHTML = Array.from(
    { length: 8 },
    (_, index) => `<option value="${index + 1}"${index + 1 === settings.maxConcurrent ? ' selected' : ''}>${index + 1} at a time</option>`,
  ).join('');
  fillConnectionSelect($('#set-connections'), settings.defaultConnections);
  const limitSelect = $('#set-limit');
  const limit = Number(settings.speedLimit) || 0;
  if (![...limitSelect.options].some((option) => Number(option.value) === limit)) {
    const option = document.createElement('option');
    option.value = String(limit);
    option.textContent = `${formatBytes(limit)}/s`;
    limitSelect.append(option);
  }
  limitSelect.value = String(limit);
  $('#set-schedule').checked = !!settings.schedule.enabled;
  $('#set-start').value = settings.schedule.start;
  $('#set-stop').value = settings.schedule.stop;
  $('#set-clipboard').checked = !!settings.clipboardWatch;
  $('#set-start').disabled = !settings.schedule.enabled;
  $('#set-stop').disabled = !settings.schedule.enabled;
  $('#engine-note').textContent = state.online ? 'Engine online' : 'Engine offline';
  $$('.theme-choice').forEach((button) => {
    button.classList.toggle('active', button.dataset.themeChoice === document.documentElement.dataset.theme);
  });
  els.settingsDialog.showModal();
}

function bindSettingsDialog() {
  $('#set-schedule').addEventListener('change', (event) => {
    $('#set-start').disabled = !event.target.checked;
    $('#set-stop').disabled = !event.target.checked;
  });
  $('#set-browse').addEventListener('click', async () => {
    try {
      const result = await api('/pick-folder', { method: 'POST' });
      if (result.path) $('#set-dir').value = result.path;
      else if (result.supported === false) toast('Folder picker unavailable', 'Type the path manually.', 'info');
    } catch (error) {
      toast('Could not open folder picker', error.message, 'error');
    }
  });
  $$('.theme-choice').forEach((button) => {
    button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
  });
  els.settingsDialog.addEventListener('close', () => {
    if (els.settingsDialog.returnValue === '' || els.settingsDialog.returnValue === 'cancel') {
      if (state.themeBeforeSettings) applyTheme(state.themeBeforeSettings);
      state.themeBeforeSettings = null;
    }
  });
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const settings = await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          defaultDir: $('#set-dir').value.trim(),
          maxConcurrent: Number($('#set-concurrent').value),
          defaultConnections: Number($('#set-connections').value),
          speedLimit: Number($('#set-limit').value),
          schedule: {
            enabled: $('#set-schedule').checked,
            start: $('#set-start').value,
            stop: $('#set-stop').value,
          },
          clipboardWatch: $('#set-clipboard').checked,
        }),
      });
      state.settings = settings;
      state.themeBeforeSettings = null;
      els.settingsDialog.close();
      toast('Settings saved', 'The engine picked up your changes.', 'success');
    } catch (error) {
      toast('Could not save settings', error.message, 'error');
    }
  });
}

/* ============================================================
   Add downloads (drag & drop / paste / extension)
   ============================================================ */

async function addUrls(urls, prefill = false) {
  const list = [...new Set(urls.filter((url) => /^https?:\/\//i.test(url)))];
  if (!list.length) return;
  if (prefill || list.length === 1) {
    openAdd(list[0]);
    return;
  }
  try {
    const result = await api('/downloads', {
      method: 'POST',
      body: JSON.stringify({ urls: list }),
    });
    toast(
      `${result.added?.length || 0} download${result.added?.length === 1 ? '' : 's'} added`,
      result.failed?.length ? `${result.failed.length} link(s) could not be added` : 'PulseDM is starting the queue.',
      result.failed?.length ? 'info' : 'success',
    );
  } catch (error) {
    toast('Could not add downloads', error.message, 'error');
  }
}

function bindDropZone() {
  window.addEventListener('dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('text/uri-list') && ![...(event.dataTransfer?.types || [])].includes('text/plain')) return;
    event.preventDefault();
    state.dropDepth += 1;
    els.dropOverlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (els.dropOverlay.hidden) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (els.dropOverlay.hidden) return;
    state.dropDepth = Math.max(0, state.dropDepth - 1);
    if (state.dropDepth === 0) els.dropOverlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (els.dropOverlay.hidden) return;
    event.preventDefault();
    state.dropDepth = 0;
    els.dropOverlay.hidden = true;
    const urls = extractUrls(event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain'));
    if (urls.length) addUrls(urls);
    else toast('No links found', 'Drop an http or https link to download it.', 'info');
  });

  document.addEventListener('paste', (event) => {
    if (!state.settings.clipboardWatch) return;
    if (event.target.closest('input, textarea, [contenteditable="true"]')) return;
    if (document.querySelector('dialog[open]')) return;
    const urls = extractUrls(event.clipboardData?.getData('text'));
    if (!urls.length) return;
    toast('Link detected', urls[0], 'info', {
      label: 'Download',
      onClick: () => addUrls(urls),
    });
  });

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!document.querySelector('dialog[open]')) openAdd();
    }
    if (event.key === 'Escape') {
      if (!els.drawer.hidden) closeDrawer();
      $('#sidebar').classList.remove('open');
    }
  });
}

/* ============================================================
   Wiring
   ============================================================ */

function bindUi() {
  $$('[data-icon]').forEach((node) => {
    const name = node.dataset.icon;
    node.innerHTML = icon(name);
    node.removeAttribute('data-icon');
  });

  $('#add-btn').addEventListener('click', () => openAdd());
  $('#empty-add').addEventListener('click', () => openAdd());
  $('#settings-btn').addEventListener('click', openSettings);
  $('#pause-all').addEventListener('click', togglePauseAll);
  $('#clear-completed').addEventListener('click', clearCompleted);
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  $('#search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderNav();
    renderList();
  });

  $$('.nav-item').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      renderNav();
      renderList();
      $('#sidebar').classList.remove('open');
    });
  });

  $('#open-folder').addEventListener('click', async () => {
    try {
      await api('/open-folder', {
        method: 'POST',
        body: JSON.stringify({ dir: state.settings.defaultDir }),
      });
    } catch (error) {
      toast('Could not open folder', error.message, 'error');
    }
  });

  $('#banner-action').addEventListener('click', async () => {
    if (state.scheduleBlocked) {
      try {
        const settings = await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({ ...state.settings, schedule: { ...state.settings.schedule, enabled: false } }),
        });
        state.settings = settings;
        toast('Scheduler disabled', 'The queue can run at any time now.', 'success');
      } catch (error) {
        toast('Could not update scheduler', error.message, 'error');
      }
    } else {
      togglePauseAll();
    }
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog')?.close('cancel'));
  });

  els.backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    if (action === 'close-drawer') {
      closeDrawer();
      return;
    }
    const holder = button.closest('[data-id]');
    const id = holder?.dataset.id || state.drawerId;
    if (id) runAction(action, id);
  });

  // Close a native dialog when clicking its backdrop.
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!inside) dialog.close('cancel');
    });
  }

  bindAddDialog();
  bindSettingsDialog();
  bindDropZone();
  window.addEventListener('resize', drawSparkline);
}

/* ============================================================
   Live connection
   ============================================================ */

function setOnline(online) {
  state.online = online;
  renderStatus();
  const dot = $('#conn-dot');
  dot.classList.toggle('online', online);
}

function connectEvents() {
  if (state.reconnecting) return;
  const source = new EventSource('/api/events');
  let opened = false;
  source.addEventListener('open', () => {
    opened = true;
    setOnline(true);
  });
  source.addEventListener('state', (event) => {
    try {
      applyState(JSON.parse(event.data));
      setOnline(true);
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener('error', () => {
    setOnline(false);
    source.close();
    if (state.reconnecting) return;
    state.reconnecting = true;
    setTimeout(() => {
      state.reconnecting = false;
      connectEvents();
    }, opened ? 1500 : 3000);
  });
}

async function boot() {
  els.list = $('#list');
  els.empty = $('#empty');
  els.queue = $('.queue');
  els.drawer = $('#drawer');
  els.backdrop = $('#drawer-backdrop');
  els.addDialog = $('#add-dialog');
  els.settingsDialog = $('#settings-dialog');
  els.toasts = $('#toasts');
  els.sparkline = $('#sparkline');
  els.dropOverlay = $('#drop-overlay');

  let savedTheme = 'dark';
  try {
    savedTheme = localStorage.getItem('pulsedm-theme') || 'dark';
  } catch {
    /* ignore */
  }
  applyTheme(savedTheme);
  bindUi();

  try {
    const initial = await api('/state');
    applyState(initial);
    setOnline(true);
  } catch {
    setOnline(false);
    toast('Engine offline', 'Start PulseDM with “npm start” and reload.', 'error');
  }

  connectEvents();
  render();

  if (window.matchMedia('(max-width: 760px)').matches) {
    $('#empty-add').textContent = 'New download';
  }
}

boot();
