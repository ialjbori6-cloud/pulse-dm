import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  categorize,
  sanitizeFilename,
  filenameFromUrl,
  parseContentDisposition,
  uniquePath,
  normalizeUrl,
  timeInWindow,
} from './utils.js';
import {
  isVideoUrl,
  probeVideo,
  ensureYtdlp,
  ensureFfmpeg,
  findFfmpeg,
  installNote,
  friendlyVideoError,
  killTree,
  buildDownloadArgs,
} from './video.js';

const TICK_MS = 1000;
const SAVE_INTERVAL = 4000;
const PROBE_TIMEOUT = 20000;
const MAX_RETRIES = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PulseDM/1.0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function validTime(value, fallback) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')) ? value : fallback;
}

export function defaultSettings(home = os.homedir()) {
  return {
    defaultDir: path.join(home, 'Downloads', 'PulseDM'),
    maxConcurrent: 3,
    defaultConnections: 8,
    speedLimit: 0,
    schedule: { enabled: false, start: '01:00', stop: '07:00' },
    clipboardWatch: true,
  };
}

class RateLimiter {
  #rate = 0;
  #tokens = 0;
  #last = Date.now();
  #waiters = [];
  #timer = null;

  setRate(bytesPerSecond) {
    this.#rate = Math.max(0, Number(bytesPerSecond) || 0);
    this.#last = Date.now();
    this.#tokens = Math.min(this.#capacity(), this.#tokens);
    this.#wake();
  }

  #capacity() {
    return Math.max(this.#rate, 256 * 1024);
  }

  #refill() {
    const now = Date.now();
    if (!this.#rate) return;
    this.#tokens = Math.min(this.#capacity(), this.#tokens + ((now - this.#last) / 1000) * this.#rate);
    this.#last = now;
  }

  async consume(bytes) {
    if (!this.#rate) return;
    const need = Math.min(bytes, this.#capacity());
    this.#refill();
    if (this.#tokens >= need) {
      this.#tokens -= need;
      return;
    }
    await new Promise((resolve) => {
      this.#waiters.push({ need, resolve });
      this.#wake();
    });
  }

  #wake() {
    if (this.#timer || !this.#waiters.length || !this.#rate) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#refill();
      while (this.#waiters.length && this.#tokens >= this.#waiters[0].need) {
        const waiter = this.#waiters.shift();
        this.#tokens -= waiter.need;
        waiter.resolve();
      }
      this.#wake();
    }, 40);
  }
}

function writeAsync(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

function endAsync(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

function publicItem(item) {
  const segments = [];
  if (item.chunks && item.chunks.length) {
    const cells = Math.min(48, item.chunks.length);
    for (let i = 0; i < cells; i += 1) {
      const from = Math.floor((i * item.chunks.length) / cells);
      const to = Math.max(from + 1, Math.floor(((i + 1) * item.chunks.length) / cells));
      let got = 0;
      let total = 0;
      for (let j = from; j < to; j += 1) {
        const chunk = item.chunks[j];
        const len = chunk.end - chunk.start + 1;
        total += len;
        got += chunk.done ? len : Math.min(len, chunk.received);
      }
      segments.push(total ? got / total : 0);
    }
  }
  return {
    id: item.id,
    url: item.url,
    finalUrl: item.finalUrl || item.url,
    filename: item.filename,
    dir: item.dir,
    savePath: item.savePath || null,
    size: item.size || 0,
    received: item.received || 0,
    status: item.status,
    resumable: !!item.resumable,
    connections: item.connections,
    category: item.category,
    contentType: item.contentType || '',
    kind: item.kind || 'file',
    note: item.note || '',
    height: item.height || 0,
    duration: item.duration || 0,
    formatLabel: item.formatLabel || '',
    createdAt: item.createdAt,
    startedAt: item.startedAt || 0,
    completedAt: item.completedAt || 0,
    startAt: item.startAt || 0,
    error: item.error || '',
    speed: Math.round(item.speed || 0),
    segments,
    chunkCount: item.chunks ? item.chunks.length : 0,
    autoPaused: !!item.autoPaused,
  };
}

export class DownloadManager extends EventEmitter {
  constructor({ dataDir, home }) {
    super();
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'state.json');
    this.settings = defaultSettings(home);
    this.items = [];
    this.paused = false;
    this.scheduleBlocked = false;
    this.globalSpeed = 0;
    this.limiter = new RateLimiter();
    this._timer = null;
    this._lastSave = 0;
    this._saving = null;
    this._saveQueued = false;
    this._probeCache = new Map();
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.#load();
    this.limiter.setRate(this.settings.speedLimit);
    this._timer = setInterval(() => this.tick(), TICK_MS);
    if (this._timer.unref) this._timer.unref();
    this.pump();
    return this;
  }

  async #load() {
    try {
      const raw = await fs.readFile(this.dbFile, 'utf8');
      const data = JSON.parse(raw);
      if (data.settings) {
        this.settings = {
          ...this.settings,
          ...data.settings,
          schedule: { ...this.settings.schedule, ...(data.settings.schedule || {}) },
        };
      }
      if (Array.isArray(data.downloads)) {
        this.items = data.downloads.map((saved) => {
          const item = { ...saved };
          if (item.status === 'downloading' || item.status === 'starting') item.status = 'paused';
          if (item.status === 'scheduled') item.status = 'queued';
          item.speed = 0;
          item.chunks = Array.isArray(item.chunks)
            ? item.chunks.map((chunk) => ({ ...chunk, busy: false }))
            : [];
          if (!item.kind) item.kind = 'file';
          item.note = '';
          if (!item.dir) item.dir = this.settings.defaultDir;
          if (!item.category) item.category = categorize(item.filename);
          return item;
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[PulseDM] Could not read state:', error.message);
    }
    this.settings.defaultDir = path.resolve(this.settings.defaultDir);
    await fs.mkdir(this.settings.defaultDir, { recursive: true }).catch(() => {});
  }

  #serializeItem(item) {
    return {
      id: item.id,
      url: item.url,
      finalUrl: item.finalUrl || '',
      filename: item.filename,
      nameLocked: !!item.nameLocked,
      dir: item.dir,
      savePath: item.savePath || '',
      partPath: item.partPath || '',
      size: item.size || 0,
      received: item.received || 0,
      status: item.status,
      resumable: !!item.resumable,
      connections: item.connections,
      chunks: item.chunks || [],
      category: item.category,
      contentType: item.contentType || '',
      kind: item.kind || 'file',
      height: item.height || 0,
      duration: item.duration || 0,
      formatLabel: item.formatLabel || '',
      videoSelector: item.videoSelector || '',
      videoExt: item.videoExt || '',
      videoStem: item.videoStem || '',
      createdAt: item.createdAt,
      startedAt: item.startedAt || 0,
      completedAt: item.completedAt || 0,
      startAt: item.startAt || 0,
      error: item.error || '',
      probed: !!item.probed,
      autoPaused: !!item.autoPaused,
    };
  }

  async saveNow() {
    if (this._saving) {
      this._saveQueued = true;
      return this._saving;
    }
    const payload = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      settings: this.settings,
      downloads: this.items.map((item) => this.#serializeItem(item)),
    });
    this._saving = (async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.dbFile}.tmp`;
      await fs.writeFile(tmp, payload);
      await fs.rename(tmp, this.dbFile);
    })()
      .catch((error) => console.error('[PulseDM] Save failed:', error.message))
      .finally(() => {
        this._lastSave = Date.now();
        this._saving = null;
        if (this._saveQueued) {
          this._saveQueued = false;
          this.saveNow();
        }
      });
    return this._saving;
  }

  get(id) {
    return this.items.find((item) => item.id === id);
  }

  list() {
    return this.items.map(publicItem);
  }

  getStats() {
    const stats = {
      active: 0,
      queued: 0,
      paused: 0,
      completed: 0,
      error: 0,
      scheduled: 0,
      speed: 0,
      downloaded: 0,
      completedBytes: 0,
    };
    for (const item of this.items) {
      if (item.status === 'downloading' || item.status === 'starting') stats.active += 1;
      else if (item.status === 'queued') stats.queued += 1;
      else if (item.status === 'scheduled') stats.scheduled += 1;
      else if (item.status === 'paused') stats.paused += 1;
      else if (item.status === 'completed') {
        stats.completed += 1;
        stats.completedBytes += item.size || 0;
      } else if (item.status === 'error') stats.error += 1;
      stats.downloaded += item.received || 0;
    }
    stats.speed = Math.round(this.globalSpeed);
    return stats;
  }

  getState() {
    return {
      downloads: this.list(),
      stats: this.getStats(),
      settings: this.settings,
      paused: this.paused,
      scheduleBlocked: this.scheduleBlocked,
      now: Date.now(),
    };
  }

  async updateSettings(patch = {}) {
    const next = { ...this.settings, ...patch };
    next.defaultDir = path.resolve(String(next.defaultDir || this.settings.defaultDir));
    next.maxConcurrent = clamp(Number(next.maxConcurrent) || 3, 1, 10);
    next.defaultConnections = clamp(Number(next.defaultConnections) || 8, 1, 16);
    next.speedLimit = clamp(Number(next.speedLimit) || 0, 0, 512 * 1024 * 1024);
    next.schedule = {
      enabled: !!(patch.schedule?.enabled ?? this.settings.schedule.enabled),
      start: validTime(patch.schedule?.start ?? this.settings.schedule.start, '01:00'),
      stop: validTime(patch.schedule?.stop ?? this.settings.schedule.stop, '07:00'),
    };
    next.clipboardWatch = !!(patch.clipboardWatch ?? this.settings.clipboardWatch);
    this.settings = next;
    await fs.mkdir(next.defaultDir, { recursive: true }).catch(() => {});
    this.limiter.setRate(next.speedLimit);
    this.emit('change');
    this.pump();
    this.saveNow();
    return this.settings;
  }

  async probe(rawUrl, outerSignal) {
    const url = normalizeUrl(rawUrl);
    if (isVideoUrl(url)) {
      const cached = this._probeCache.get(url);
      if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.meta;
      const ffmpeg = await findFfmpeg();
      const meta = await probeVideo(url, {
        canMerge: !!ffmpeg || process.platform === 'win32',
        signal: outerSignal,
      });
      this._probeCache.set(url, { at: Date.now(), meta });
      if (this._probeCache.size > 40) {
        const oldest = [...this._probeCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) this._probeCache.delete(oldest[0]);
      }
      return meta;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', abort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
    try {
      const response = await fetch(url, {
        headers: {
          Range: 'bytes=0-0',
          'Accept-Encoding': 'identity',
          'User-Agent': USER_AGENT,
        },
        redirect: 'follow',
        signal: controller.signal,
      });
      const headers = response.headers;
      const contentRange = headers.get('content-range') || '';
      let size = 0;
      let resumable = false;
      if (response.status === 206 && contentRange) {
        const match = /\/(\d+)\s*$/.exec(contentRange);
        if (match) size = Number(match[1]);
        resumable = size > 0;
      } else if (response.ok) {
        size = Number(headers.get('content-length') || 0) || 0;
        resumable = /bytes/i.test(headers.get('accept-ranges') || '');
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      const disposition = headers.get('content-disposition') || '';
      const fromHeader = disposition ? parseContentDisposition(disposition) : '';
      const fromUrl = filenameFromUrl(response.url || url);
      const filename = sanitizeFilename(fromHeader || fromUrl || 'download');
      const contentType = (headers.get('content-type') || '').split(';')[0].trim();
      return {
        url: response.url || url,
        size,
        resumable: resumable && size > 0,
        filename,
        contentType,
      };
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', abort);
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
  }

  async add({ url, filename, dir, connections, startAt } = {}) {
    const normalized = normalizeUrl(url);
    const saveDir = path.resolve(String(dir || this.settings.defaultDir));
    await fs.mkdir(saveDir, { recursive: true }).catch(() => {});
    const kind = isVideoUrl(normalized) ? 'video' : 'file';
    let meta = null;
    if (kind === 'video') {
      try {
        meta = await this.probe(normalized);
      } catch {
        // Added anyway: the row shows the real error once it starts.
        meta = null;
      }
    }
    const provided = filename ? sanitizeFilename(filename) : '';
    const guessed = kind === 'video' ? '' : filenameFromUrl(normalized);
    const wanted = provided || meta?.filename || guessed;
    const item = {
      id: randomUUID(),
      url: normalized,
      finalUrl: '',
      filename: wanted,
      nameLocked: !!provided,
      dir: saveDir,
      savePath: '',
      partPath: '',
      size: meta?.size || 0,
      received: 0,
      status: 'queued',
      resumable: kind === 'file',
      connections: clamp(Number(connections) || this.settings.defaultConnections, 1, 16),
      chunks: [],
      category: kind === 'video' ? 'video' : categorize(wanted || normalized),
      contentType: meta?.contentType || '',
      kind,
      note: '',
      height: meta?.height || 0,
      duration: meta?.duration || 0,
      formatLabel: meta?.formatLabel || '',
      videoSelector: meta?.formatSelector || '',
      videoExt: meta?.ext || '',
      videoStem: '',
      createdAt: Date.now(),
      startedAt: 0,
      completedAt: 0,
      startAt: Number(startAt) || 0,
      error: '',
      speed: 0,
      probed: !!meta,
      autoPaused: false,
    };
    if (item.startAt && item.startAt > Date.now() + 1000) item.status = 'scheduled';
    this.items.unshift(item);
    this.emit('change');
    this.saveNow();
    if (item.status === 'queued') this.pump();
    return publicItem(item);
  }

  pump() {
    if (this.paused || this.scheduleBlocked) return;
    const active = this.items.filter(
      (item) => item.status === 'downloading' || item.status === 'starting',
    ).length;
    let slots = this.settings.maxConcurrent - active;
    if (slots <= 0) return;
    for (const item of this.items) {
      if (slots <= 0) break;
      if (item.status === 'queued') {
        slots -= 1;
        this.start(item);
      }
    }
  }

  start(item) {
    if (!item || item._running) return;
    if (item.status !== 'queued') return;
    item._running = true;
    item._lastBytes = item.received || 0;
    item._lastTime = Date.now();
    item._partReady = false;
    item._fatalError = null;
    item.error = '';
    item.status = 'starting';
    const controller = new AbortController();
    item._abort = controller;
    this.emit('change');
    item._done = this.#run(item, controller)
      .catch((error) => {
        console.error('[PulseDM] Download crashed:', error);
        item.status = 'error';
        item.error = error?.message || String(error);
      })
      .finally(() => {
        item._running = false;
        item._abort = null;
        item.speed = 0;
        this.emit('change');
        this.saveNow();
        this.pump();
      });
  }

  async #run(item, controller) {
    const signal = controller.signal;
    try {
      if ((item.kind || 'file') === 'video') {
        await this.#runVideo(item, controller);
        return;
      }
      if (!item.probed || !item.savePath) {
        const meta = await this.probe(item.url, signal);
        if (signal.aborted) return;
        item.probed = true;
        item.finalUrl = meta.url;
        item.size = meta.size;
        item.resumable = meta.resumable;
        item.contentType = meta.contentType;
        const metaName = sanitizeFilename(meta.filename || filenameFromUrl(meta.url) || 'download');
        if (!item.nameLocked) item.filename = metaName;
        item.filename = sanitizeFilename(item.filename);
        item.category = categorize(item.filename);
        await fs.mkdir(item.dir, { recursive: true });
        if (!item.savePath) {
          item.savePath = await uniquePath(path.join(item.dir, item.filename));
          item.partPath = `${item.savePath}.pulsesave`;
        }
        if (item.resumable && !item.chunks.length) this.#buildChunks(item);
        if (!item.resumable) {
          item.chunks = [];
        }
        this.emit('change');
      }
      if (signal.aborted) return;
      item.status = 'downloading';
      if (!item.startedAt) item.startedAt = Date.now();
      item._lastBytes = item.received || 0;
      item._lastTime = Date.now();
      this.emit('change');
      if (item.resumable) await this.#runResumable(item, controller);
      else await this.#runStream(item, controller);
      if (signal.aborted) return;
      await this.#finalize(item);
    } catch (error) {
      if (item._fatalError) {
        item.status = 'error';
        item.error = item._fatalError.message || String(item._fatalError);
        item._fatalError = null;
        return;
      }
      if (signal.aborted || item.status === 'paused') {
        if (item.status !== 'paused' && item.status !== 'completed' && item.status !== 'error') {
          item.status = 'paused';
        }
        return;
      }
      if (!item.filename) {
        item.filename = sanitizeFilename(filenameFromUrl(item.url) || 'download');
        item.category = categorize(item.filename);
      }
      item.status = 'error';
      item.error = error?.message || String(error);
    }
  }

  #buildChunks(item) {
    const workers = clamp(item.connections || 8, 1, 16);
    const chunkSize = clamp(
      Math.ceil(item.size / (workers * 16)),
      256 * 1024,
      16 * 1024 * 1024,
    );
    item.chunks = [];
    for (let start = 0; start < item.size; start += chunkSize) {
      item.chunks.push({
        start,
        end: Math.min(item.size, start + chunkSize) - 1,
        received: 0,
        done: false,
        busy: false,
      });
    }
    item.received = 0;
  }

  async #preparePart(item) {
    if (item._partReady) return;
    await fs.mkdir(item.dir, { recursive: true });
    let stat = null;
    try {
      stat = await fs.stat(item.partPath);
    } catch {
      stat = null;
    }
    if (!stat) {
      const handle = await fs.open(item.partPath, 'w');
      await handle.truncate(item.size);
      await handle.close();
      item.received = 0;
      for (const chunk of item.chunks) {
        chunk.received = 0;
        chunk.done = false;
      }
    } else if (stat.size !== item.size) {
      const handle = await fs.open(item.partPath, 'r+');
      await handle.truncate(item.size);
      await handle.close();
      if (stat.size < item.size) {
        item.received = 0;
        for (const chunk of item.chunks) {
          chunk.received = 0;
          chunk.done = false;
        }
      }
    }
    item._partReady = true;
  }

  async #runResumable(item, controller) {
    await this.#preparePart(item);
    const remaining = item.chunks.filter((chunk) => !chunk.done);
    if (!remaining.length) return;
    const workers = Math.min(item.connections, remaining.length);
    try {
      await Promise.all(
        Array.from({ length: workers }, () => this.#worker(item, controller)),
      );
    } catch (error) {
      item._fatalError = error;
      controller.abort();
      throw error;
    }
    if (controller.signal.aborted) return;
    const unfinished = item.chunks.filter((chunk) => !chunk.done);
    if (unfinished.length) throw new Error(`${unfinished.length} parts could not be downloaded`);
  }

  async #worker(item, controller) {
    while (!controller.signal.aborted) {
      const chunk = item.chunks.find((entry) => !entry.done && !entry.busy);
      if (!chunk) return;
      chunk.busy = true;
      try {
        await this.#fetchChunk(item, chunk, controller);
      } finally {
        chunk.busy = false;
      }
    }
  }

  async #fetchChunk(item, chunk, controller) {
    let attempt = 0;
    for (;;) {
      if (controller.signal.aborted) return;
      try {
        await this.#pullChunk(item, chunk, controller);
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        attempt += 1;
        if (attempt > MAX_RETRIES) throw error;
        await sleep(350 * attempt);
      }
    }
  }

  async #pullChunk(item, chunk, controller) {
    const start = chunk.start + chunk.received;
    const total = chunk.end - chunk.start + 1;
    if (start > chunk.end) {
      chunk.done = true;
      return;
    }
    const response = await fetch(item.finalUrl || item.url, {
      headers: {
        Range: `bytes=${start}-${chunk.end}`,
        'Accept-Encoding': 'identity',
        'User-Agent': USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (response.status !== 206) {
      throw new Error(`Server returned HTTP ${response.status} for a range request`);
    }
    if (!response.body) throw new Error('Empty response body');
    const stream = createWriteStream(item.partPath, { flags: 'r+', start });
    try {
      const body = Readable.fromWeb(response.body);
      for await (const buffer of body) {
        if (controller.signal.aborted) throw new Error('Aborted');
        await this.limiter.consume(buffer.length);
        if (controller.signal.aborted) throw new Error('Aborted');
        await writeAsync(stream, buffer);
        chunk.received += buffer.length;
        item.received += buffer.length;
        if (chunk.received >= total) break;
      }
    } finally {
      await endAsync(stream).catch(() => {});
    }
    if (chunk.received < total) {
      throw new Error('The connection closed before the part was complete');
    }
    chunk.done = true;
  }

  async #runStream(item, controller) {
    await fs.mkdir(item.dir, { recursive: true });
    item.received = 0;
    item.chunks = [];
    item._partReady = false;
    const stream = createWriteStream(item.partPath, { flags: 'w' });
    let response;
    try {
      response = await fetch(item.finalUrl || item.url, {
        headers: { 'Accept-Encoding': 'identity', 'User-Agent': USER_AGENT },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!response.body) throw new Error('Empty response body');
      if (!item.size) {
        const length = Number(response.headers.get('content-length') || 0);
        if (length) item.size = length;
      }
      const body = Readable.fromWeb(response.body);
      for await (const buffer of body) {
        if (controller.signal.aborted) throw new Error('Aborted');
        await this.limiter.consume(buffer.length);
        if (controller.signal.aborted) throw new Error('Aborted');
        await writeAsync(stream, buffer);
        item.received += buffer.length;
      }
    } finally {
      await endAsync(stream).catch(() => {});
    }
  }

  async #finalize(item) {
    const stat = await fs.stat(item.partPath);
    if (item.size && stat.size !== item.size) {
      throw new Error('Downloaded file is incomplete');
    }
    await fs.mkdir(item.dir, { recursive: true });
    if (!item.savePath) item.savePath = path.join(item.dir, item.filename);
    const target = await uniquePath(item.savePath);
    await fs.rename(item.partPath, target);
    const finalStat = await fs.stat(target);
    item.savePath = target;
    item.filename = path.basename(target);
    item.size = finalStat.size;
    item.received = finalStat.size;
    item.status = 'completed';
    item.completedAt = Date.now();
    item.speed = 0;
    item.chunks = [];
    item.error = '';
    item.autoPaused = false;
    item._partReady = false;
    this.emit('change');
  }

  /* ------------------------------------------------------------------ */
  /* Video downloads (yt-dlp)                                            */
  /* ------------------------------------------------------------------ */

  async #runVideo(item, controller) {
    const signal = controller.signal;
    item.status = 'starting';
    item.error = '';
    item.note = 'Preparing video engine…';
    item.chunks = [];
    this.emit('change');

    const status = (info) => {
      if (signal.aborted) return;
      item.note = typeof info === 'string' ? info : installNote(info);
      this.emit('change');
    };

    const ytdlp = await ensureYtdlp(status);
    if (signal.aborted) return;

    if (!item.videoSelector || !item.filename || !item.size) {
      status('Reading video info…');
      const meta = await this.probe(item.url, signal);
      if (signal.aborted) return;
      if (!item.nameLocked) item.filename = meta.filename;
      item.size = meta.size || item.size;
      item.height = meta.height || item.height;
      item.duration = meta.duration || item.duration;
      item.formatLabel = meta.formatLabel || item.formatLabel;
      item.videoSelector = meta.formatSelector || item.videoSelector;
      item.videoExt = meta.ext || item.videoExt;
      item.contentType = meta.contentType || item.contentType;
      item.finalUrl = meta.finalUrl || item.url;
      this.emit('change');
    }

    item.category = 'video';
    const ext = item.videoExt || 'mp4';
    let ffmpeg = null;
    if (/\+/.test(String(item.videoSelector || ''))) {
      status('Checking the merge tool…');
      ffmpeg = await ensureFfmpeg(status);
      if (signal.aborted) return;
    } else {
      ffmpeg = await findFfmpeg();
    }

    await fs.mkdir(item.dir, { recursive: true });
    if (!item.savePath || !item.videoStem) {
      const currentExt = path.extname(item.filename || '').toLowerCase();
      const rawStem = currentExt ? item.filename.slice(0, -currentExt.length) : item.filename;
      const stem = sanitizeFilename(rawStem || 'video', 'video');
      item.savePath = await uniquePath(path.join(item.dir, `${stem}.${ext}`));
      item.videoStem = path.basename(item.savePath, path.extname(item.savePath));
    }
    item.filename = path.basename(item.savePath);
    item.videoTemp = path.join(item.dir, `${item.videoStem}.pdm-tmp`);
    item.partPath = `${item.savePath}.part`;
    item.note = 'Starting download…';
    item.status = 'downloading';
    if (!item.startedAt) item.startedAt = Date.now();
    item.speedLimit = this.settings.speedLimit;
    item._lastBytes = item.received || 0;
    item._lastTime = Date.now();
    this.emit('change');

    await this.#spawnVideo(item, controller, { ytdlp, ffmpeg, ext });
    if (signal.aborted) return;

    const finalPath = await this.#resolveVideoOutput(item);
    const stat = await fs.stat(finalPath);
    item.savePath = finalPath;
    item.filename = path.basename(finalPath);
    item.size = stat.size;
    item.received = stat.size;
    item.category = categorize(item.filename);
    item.contentType = `video/${path.extname(finalPath).slice(1).toLowerCase() || 'mp4'}`;
    item.status = 'completed';
    item.completedAt = Date.now();
    item.speed = 0;
    item.note = '';
    item.error = '';
    item.chunks = [];
    item.autoPaused = false;
    item.partPath = '';
    item.probed = true;
    this.emit('change');
  }

  async #spawnVideo(item, controller, { ytdlp, ffmpeg, ext }) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const args = buildDownloadArgs(item, { ytdlp, ffmpeg, ext });
      const child = spawn(ytdlp, args, { windowsHide: true });
      item._child = child;
      let stderr = '';
      let pending = '';
      let tail = '';
      let phaseBase = 0;
      let phaseTotal = 0;
      let phases = 0;
      let settled = false;
      let settle;
      const closed = new Promise((resolve) => {
        settle = resolve;
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        settle(value);
      };
      const onAbort = () => {
        killTree(child);
        setTimeout(() => {
          try {
            child.stdout.destroy();
            child.stderr.destroy();
          } catch {
            /* already closed */
          }
          finish(-1);
        }, 6000);
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });

      const handleLine = (raw) => {
        const text = raw.trim();
        if (!text) return;
        if (text.startsWith('pdm:')) {
          const [downloadedRaw, totalRaw, estimateRaw] = text.slice(4).split('|');
          const downloaded = Math.max(0, Number(downloadedRaw) || 0);
          const total = Number(totalRaw) || Number(estimateRaw) || 0;
          // HLS reports a growing estimate, so only trust explicit download
          // phases (Destination lines) when deciding where a phase starts.
          if (total) phaseTotal = total;
          item.received = phaseBase + downloaded;
          if (total) item.size = Math.max(item.size || 0, phaseBase + total);
          return;
        }
        if (/\[download\]\s+Destination:/i.test(text)) {
          if (phaseTotal) {
            phaseBase += phaseTotal;
            phaseTotal = 0;
          }
          phases += 1;
          const next = phases === 1 ? 'Downloading video stream…' : 'Downloading audio stream…';
          if (item.note !== next) {
            item.note = next;
            this.emit('change');
          }
          return;
        }
        if (/\[Merger\]|Merging formats/i.test(text)) {
          item.note = 'Merging audio and video…';
          if (item.size) item.received = item.size;
          this.emit('change');
          return;
        }
        if (/\[(Fixup|VideoConvertor|Metadata|EmbedThumbnail|ExtractAudio)/i.test(text)) {
          item.note = 'Finishing video…';
          if (item.size) item.received = item.size;
          this.emit('change');
        }
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        tail = (tail + chunk).slice(-8000);
        pending += chunk;
        let index;
        while ((index = pending.indexOf('\n')) >= 0) {
          handleLine(pending.slice(0, index));
          pending = pending.slice(index + 1);
        }
        if (pending.length > 20000) pending = pending.slice(-2000);
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-16000);
      });

      const code = await new Promise((resolve) => {
        child.on('error', (error) => {
          stderr += `\n${error.message}`;
          finish(-1);
        });
        child.on('exit', (value, signal) => finish(value ?? (signal ? -1 : 0)));
        child.on('close', (value) => finish(value ?? -1));
        closed.then(resolve);
      });
      controller.signal.removeEventListener('abort', onAbort);
      item._child = null;

      if (controller.signal.aborted || item.status === 'paused') return;
      if (code === 0) return;

      const formatGone = /requested format is not available|format is not available/i.test(stderr);
      if (formatGone && attempt === 0) {
        item.videoSelector = '';
        item.note = 'Retrying with the best available quality…';
        item.received = 0;
        this.emit('change');
        await this.#cleanVideoParts(item).catch(() => {});
        continue;
      }
      throw new Error(friendlyVideoError(`${stderr}\n${tail}`));
    }
  }

  async #resolveVideoOutput(item) {
    const prefix = path.basename(item.videoTemp || `${item.videoStem}.pdm-tmp`);
    const entries = await fs.readdir(item.dir, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.startsWith(`${prefix}.`)) continue;
      if (/\.(part|ytdl|temp|download|json|description|vtt|srt|ass|jpg|jpeg|png|webp)$/i.test(name)) continue;
      candidates.push(path.join(item.dir, name));
    }
    if (!candidates.length) throw new Error('The video finished but no output file was found.');
    const stats = await Promise.all(
      candidates.map(async (file) => ({ file, stat: await fs.stat(file) })),
    );
    stats.sort((a, b) => b.stat.size - a.stat.size);
    const chosen = stats[0].file;
    const ext = path.extname(chosen).slice(1) || 'mp4';
    const finalPath = await uniquePath(path.join(item.dir, `${item.videoStem}.${ext}`));
    await fs.rename(chosen, finalPath);
    return finalPath;
  }

  async #cleanVideoParts(item) {
    const stem = item.videoStem;
    if (!stem) return;
    const entries = await fs.readdir(item.dir).catch(() => []);
    for (const name of entries) {
      if (!name.startsWith(`${stem}.pdm-tmp.`)) continue;
      await fs.unlink(path.join(item.dir, name)).catch(() => {});
    }
  }

  pause(id) {
    const item = this.get(id);
    if (!item) throw new Error('Download not found');
    if (!['queued', 'scheduled', 'starting', 'downloading'].includes(item.status)) {
      return publicItem(item);
    }
    item.status = 'paused';
    item.autoPaused = false;
    item.error = '';
    if (item._abort) item._abort.abort();
    this.emit('change');
    this.saveNow();
    return publicItem(item);
  }

  resume(id) {
    const item = this.get(id);
    if (!item) throw new Error('Download not found');
    if (!['paused', 'error', 'scheduled'].includes(item.status)) return publicItem(item);
    item.status = 'queued';
    item.startAt = 0;
    item.autoPaused = false;
    item.error = '';
    this.emit('change');
    this.saveNow();
    this.pump();
    return publicItem(item);
  }

  pauseAll() {
    this.paused = true;
    for (const item of this.items) {
      if (item.status === 'downloading' || item.status === 'starting') {
        item.autoPaused = true;
        this.pause(item.id);
      }
    }
    this.emit('change');
    this.saveNow();
  }

  resumeAll() {
    this.paused = false;
    for (const item of this.items) {
      if (item.status === 'paused' || item.status === 'error' || item.status === 'scheduled') {
        item.autoPaused = false;
        item.status = 'queued';
        item.startAt = 0;
        item.error = '';
      }
    }
    this.emit('change');
    this.saveNow();
    this.pump();
  }

  async remove(id, deleteFile = false) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    const item = this.items[index];
    if (item._abort) item._abort.abort();
    if (item._child) killTree(item._child);
    if (item._running && item._done) {
      await Promise.race([item._done.catch(() => {}), sleep(8000)]);
    }
    this.items.splice(index, 1);
    const targets = [];
    if (deleteFile) {
      if (item.savePath) targets.push(item.savePath);
      if (item.partPath) targets.push(item.partPath);
    } else if (item.status !== 'completed' && item.partPath) {
      targets.push(item.partPath);
    }
    if (item.kind === 'video' && item.videoStem) {
      const entries = await fs.readdir(item.dir).catch(() => []);
      for (const name of entries) {
        if (!name.startsWith(`${item.videoStem}.`)) continue;
        if (deleteFile || item.status !== 'completed') {
          targets.push(path.join(item.dir, name));
        } else if (/\.(part|ytdl|temp|download)$/i.test(name) || name.includes('.pdm-tmp.')) {
          targets.push(path.join(item.dir, name));
        }
      }
    }
    for (const target of targets) {
      await fs.unlink(target).catch(() => {});
    }
    this.emit('change');
    this.saveNow();
    this.pump();
    return true;
  }

  async clearCompleted() {
    const keep = [];
    for (const item of this.items) {
      if (item.status === 'completed') {
        if (item.partPath) await fs.unlink(item.partPath).catch(() => {});
      } else {
        keep.push(item);
      }
    }
    this.items = keep;
    this.emit('change');
    this.saveNow();
  }

  tick() {
    const now = Date.now();
    let total = 0;
    for (const item of this.items) {
      if (item.status === 'downloading') {
        const elapsed = Math.max(0.2, (now - (item._lastTime || now)) / 1000);
        const delta = Math.max(0, (item.received || 0) - (item._lastBytes || 0));
        const instant = delta / elapsed;
        item.speed = item.speed > 0 ? item.speed * 0.6 + instant * 0.4 : instant;
        total += item.speed;
        item._lastBytes = item.received || 0;
        item._lastTime = now;
      } else {
        item.speed = 0;
        item._lastBytes = item.received || 0;
        item._lastTime = now;
      }
      if (item.status === 'scheduled' && item.startAt && item.startAt <= now) {
        item.status = 'queued';
        item.startAt = 0;
        this.emit('change');
      }
    }
    this.globalSpeed = total;
    this.#applySchedule(now);
    this.pump();
    const busy = this.items.some(
      (item) => item.status === 'downloading' || item.status === 'starting',
    );
    if (busy && now - this._lastSave > SAVE_INTERVAL) this.saveNow();
    this.emit('change');
  }

  #applySchedule(now) {
    const { enabled, start, stop } = this.settings.schedule;
    let blocked = false;
    if (enabled) blocked = !timeInWindow(new Date(now), start, stop);
    if (blocked === this.scheduleBlocked) return;
    this.scheduleBlocked = blocked;
    if (blocked) {
      for (const item of this.items) {
        if (item.status === 'downloading' || item.status === 'starting') {
          item.autoPaused = true;
          this.pause(item.id);
        }
      }
    } else {
      for (const item of this.items) {
        if (item.status === 'paused' && item.autoPaused) {
          item.autoPaused = false;
          item.status = 'queued';
        }
      }
      this.pump();
    }
    this.emit('change');
  }

  async close() {
    if (this._timer) clearInterval(this._timer);
    for (const item of this.items) {
      if (item._abort) item._abort.abort();
    }
    await this.saveNow();
  }
}
