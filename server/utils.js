import fs from 'node:fs/promises';
import path from 'node:path';

const VIDEO = new Set([
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg',
  'ts', '3gp', 'ogv', 'm3u8', 'mpd',
]);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'm4a', 'wma', 'opus', 'aiff', 'mid']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tif', 'tiff', 'avif', 'heic']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'tgz', 'zst']);
const DOCUMENT = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'md', 'rtf',
  'epub', 'mobi', 'odt', 'ods', 'odp', 'json', 'xml', 'yaml', 'yml',
]);
const APP = new Set([
  'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'appx', 'app', 'bin',
  'jar', 'msix', 'bat', 'cmd', 'ps1', 'sh',
]);

export const CATEGORY_LABELS = {
  video: 'Video',
  audio: 'Music',
  image: 'Images',
  archive: 'Compressed',
  document: 'Documents',
  app: 'Programs',
  other: 'Other',
};

export function categorize(name = '') {
  const ext = path.extname(String(name)).slice(1).toLowerCase();
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (IMAGE.has(ext)) return 'image';
  if (ARCHIVE.has(ext)) return 'archive';
  if (DOCUMENT.has(ext)) return 'document';
  if (APP.has(ext)) return 'app';
  return 'other';
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function sanitizeFilename(name, fallback = 'download') {
  let out = String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!out || out === '.' || out === '..') out = fallback;
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > 180) {
    const ext = path.extname(out);
    out = `${out.slice(0, Math.max(1, 180 - ext.length))}${ext}`;
  }
  return out;
}

export function filenameFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    let last = parts[parts.length - 1] || '';
    try {
      last = decodeURIComponent(last);
    } catch {
      /* keep encoded */
    }
    if (!last || last === '/') return '';
    return sanitizeFilename(last);
  } catch {
    return '';
  }
}

export function parseContentDisposition(header = '') {
  if (!header) return '';
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ''));
    } catch {
      return star[2].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = /filename\s*=\s*("([^"]+)"|([^;]+))/i.exec(header);
  if (plain) return (plain[2] || plain[3] || '').trim();
  return '';
}

export async function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const stem = path.basename(target, ext);
  let candidate = target;
  for (let i = 1; i < 2000; i += 1) {
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
    candidate = path.join(dir, `${stem} (${i})${ext}`);
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function normalizeUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Enter a download link');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error('That does not look like a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https links are supported');
  }
  return url.toString();
}

export function timeInWindow(date, start, stop) {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const parse = (value) => {
    const [h, m] = String(value || '0:0').split(':').map(Number);
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const from = parse(start);
  const to = parse(stop);
  if (from === to) return true;
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}
