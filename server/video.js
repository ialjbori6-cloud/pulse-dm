/**
 * PulseDM video engine.
 *
 * Video pages (YouTube, Vimeo, TikTok, ...) are not direct files, so the
 * segmented HTTP engine cannot download them. This module drives yt-dlp
 * instead: it finds or installs the standalone tools, reads metadata, picks
 * the best stream combination and reports progress back to the manager.
 *
 * Zero npm dependencies: the ZIP reader below only needs node:zlib.
 */

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeFilename } from './utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN_DIR = path.join(ROOT, 'bin');

const YTDLP_RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const FFMPEG_WIN_ZIP = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const PROBE_TIMEOUT = 60000;
const MIN_BINARY_BYTES = 512 * 1024;

/** Sites that serve video pages rather than direct files. */
const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'm.youtube.com', 'music.youtube.com',
  'vimeo.com', 'dailymotion.com', 'dai.ly', 'twitch.tv', 'clips.twitch.tv',
  'tiktok.com', 'vt.tiktok.com', 'instagram.com', 'facebook.com', 'fb.watch', 'fb.com',
  'twitter.com', 'x.com', 't.co', 'reddit.com', 'redd.it', 'v.redd.it',
  'soundcloud.com', 'bandcamp.com', 'bilibili.com', 'b23.tv', 'rumble.com', 'odysee.com',
  'streamable.com', 'bitchute.com', 'vimeo.com', 'ok.ru', 'vk.com', 'nicovideo.jp',
  'archive.org', 'ted.com', 'coursera.org', 'udemy.com', 'brighteon.com', 'kick.com',
  'pinterest.com', 'snapchat.com', 'linkedin.com', 'tumblr.com', 'imdb.com',
  'news.ycombinator.com', 'www.youtube.com',
];

const VIDEO_PATH = /\.(m3u8|mpd|f4m|ism)(?:$|[?#])/i;
const FILE_PATH = /\.(mp4|mkv|webm|mov|avi|flv|wmv|m4v|mpeg|mpg|ts|3gp|ogv|mp3|m4a|aac|ogg|opus|flac|wav|zip|rar|7z|pdf|exe|msi|dmg|apk|iso|gz)(?:$|[?#])/i;

export function isVideoUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ''));
  } catch {
    return false;
  }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (VIDEO_PATH.test(url.pathname + url.search)) return true;
  if (FILE_PATH.test(url.pathname)) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (VIDEO_HOSTS.some((entry) => host === entry.replace(/^www\./, '') || host.endsWith(`.${entry.replace(/^www\./, '')}`))) {
    return true;
  }
  // Generic "watch page" shapes used by many video sites.
  return /^\/(watch|video|videos|embed|clip|shorts|reel|reels|status|live)(\/|$)/i.test(url.pathname);
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatBytes(bytes) {
  const n = num(bytes);
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

async function exists(target) {
  try {
    const stat = await fs.stat(target);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function run(file, args, { timeout = 20000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function pickErrorLine(text = '') {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^error[:\s]/i.test(line)) ||
    [...lines].reverse().find((line) => /error|unable|failed|not available|unsupported/i.test(line));
  return (errorLine || lines[lines.length - 1] || 'The video engine stopped unexpectedly')
    .replace(/^ERROR:\s*/i, '')
    .slice(0, 400);
}

export function friendlyVideoError(text = '') {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (lower.includes('sign in to confirm') || lower.includes('confirm you’re not a bot') || lower.includes('confirm your age') || lower.includes('age-restricted')) {
    return 'This video needs a signed-in YouTube session (age or bot check). Try another link, or run yt-dlp with browser cookies.';
  }
  if (lower.includes('private video') || lower.includes('video unavailable') || lower.includes('this video is not available')) {
    return 'This video is private, removed or blocked in your region.';
  }
  if (lower.includes('unsupported url')) {
    return 'This page is not a supported video site. Paste a direct file link instead.';
  }
  if (lower.includes('requested format is not available')) {
    return 'That quality is no longer offered. Press Retry to pick the best available stream.';
  }
  if (lower.includes('ffmpeg') && (lower.includes('not found') || lower.includes('not installed') || lower.includes('is not recognized'))) {
    return 'The merge tool (ffmpeg) is not available. Retry so PulseDM can install it.';
  }
  if (lower.includes('http error 403') || lower.includes('forbidden')) {
    return 'The site refused the download (HTTP 403). The link may have expired or need cookies.';
  }
  if (lower.includes('timed out') || lower.includes('timeout')) {
    return 'The video site did not respond in time. Check your connection and retry.';
  }
  return pickErrorLine(raw);
}

/* ------------------------------------------------------------------ */
/* Downloads + tiny ZIP reader                                         */
/* ------------------------------------------------------------------ */

async function download(url, dest, onProgress) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
  });
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status})`);
  if (!response.body) throw new Error('Download failed (empty response)');
  const total = num(response.headers.get('content-length'));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;
  const out = createWriteStream(tmp);
  let received = 0;
  let last = 0;
  try {
    for await (const chunk of Readable.fromWeb(response.body)) {
      received += chunk.length;
      if (!out.write(chunk)) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      const now = Date.now();
      if (onProgress && now - last > 250) {
        last = now;
        onProgress(received, total);
      }
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  if (onProgress) onProgress(received, total || received);
  if (received < MIN_BINARY_BYTES) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error('Downloaded file looks incomplete');
  }
  await fs.rename(tmp, dest);
  return received;
}

function findEndOfCentralDirectory(buffer) {
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer[i] === 0x50 && buffer[i + 1] === 0x4b && buffer[i + 2] === 0x05 && buffer[i + 3] === 0x06) {
      return i;
    }
  }
  return -1;
}

/** Extract one file from a ZIP archive by basename, without npm helpers. */
async function extractFromZip(zipPath, wantedName, destPath) {
  const handle = await fs.open(zipPath, 'r');
  try {
    const size = (await handle.stat()).size;
    const tailLength = Math.min(size, 128 * 1024);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const eocd = findEndOfCentralDirectory(tail);
    if (eocd < 0) throw new Error('The tool archive is not a valid ZIP file');
    const entries = tail.readUInt16LE(eocd + 10);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    const readAt = async (position, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    };
    const central = await readAt(dirOffset, Math.min(size - dirOffset, 4 * 1024 * 1024));
    let cursor = 0;
    for (let index = 0; index < entries; index += 1) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) break;
      const method = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;
      if (path.basename(name).toLowerCase() !== wantedName.toLowerCase()) continue;
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
        throw new Error('Unsupported ZIP64 tool archive');
      }
      const local = await readAt(localOffset, 30);
      const localNameLength = local.readUInt16LE(26);
      const localExtraLength = local.readUInt16LE(28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      await fs.mkdir(path.dirname(destPath), { recursive: true });
      const tmp = `${destPath}.extract`;
      const source = createReadStream(zipPath, { start, end: start + compressedSize - 1 });
      const sink = createWriteStream(tmp);
      if (method === 0) await pipeline(source, sink);
      else if (method === 8) await pipeline(source, zlib.createInflateRaw(), sink);
      else throw new Error(`Unsupported ZIP compression (${method})`);
      const stat = await fs.stat(tmp);
      if (stat.size < MIN_BINARY_BYTES) {
        await fs.unlink(tmp).catch(() => {});
        throw new Error('Extracted tool looks incomplete');
      }
      await fs.rename(tmp, destPath);
      return destPath;
    }
    throw new Error('The tool archive did not contain the expected file');
  } finally {
    await handle.close();
  }
}

/* ------------------------------------------------------------------ */
/* Tool discovery / installation                                       */
/* ------------------------------------------------------------------ */

const installs = new Map();
const verified = new Map();

function platformBinary(name) {
  if (process.platform === 'win32') return `${name}.exe`;
  return name;
}

function ytdlpAssetName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return 'yt-dlp_linux';
}

export function ytdlpPath() {
  return path.join(BIN_DIR, platformBinary('yt-dlp'));
}

async function validate(exe, args) {
  if (verified.get(exe)) return true;
  try {
    await run(exe, args, { timeout: 20000 });
    verified.set(exe, true);
    return true;
  } catch {
    return false;
  }
}

async function install(exe, task, label) {
  if (installs.has(exe)) return installs.get(exe);
  const promise = (async () => {
    await fs.mkdir(BIN_DIR, { recursive: true });
    await task();
    verified.delete(exe);
    return exe;
  })()
    .catch((error) => {
      throw new Error(`${label}: ${error.message}`);
    })
    .finally(() => {
      installs.delete(exe);
    });
  installs.set(exe, promise);
  return promise;
}

/**
 * Make sure yt-dlp is available. Downloads the standalone build on first use.
 * @param {(info: {phase: string, received?: number, total?: number, percent?: number}) => void} [onProgress]
 */
export async function ensureYtdlp(onProgress) {
  const exe = ytdlpPath();
  if (await exists(exe)) {
    if (/yt-dlp/i.test(path.basename(exe)) && (await validate(exe, ['--version']))) return exe;
  }
  if (await exists(exe)) await fs.unlink(exe).catch(() => {});
  return install(exe, async () => {
    onProgress?.({ phase: 'installing-ytdlp' });
    const tmpZip = path.join(os.tmpdir(), `pulsedm-${process.pid}-ytdlp`);
    const asset = ytdlpAssetName();
    const target = path.join(BIN_DIR, asset);
    try {
      await download(`${YTDLP_RELEASE}/${asset}`, tmpZip, (received, total) => {
        onProgress?.({
          phase: 'downloading-ytdlp',
          received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : 0,
        });
      });
      await fs.mkdir(BIN_DIR, { recursive: true });
      await fs.rename(tmpZip, target).catch(async () => {
        await fs.copyFile(tmpZip, target);
        await fs.unlink(tmpZip).catch(() => {});
      });
      if (process.platform !== 'win32') await fs.chmod(target, 0o755);
      if (target !== exe) await fs.rename(target, exe).catch(() => fs.copyFile(target, exe));
      if (!(await validate(exe, ['--version']))) throw new Error('yt-dlp did not start after downloading');
      onProgress?.({ phase: 'ready' });
    } finally {
      await fs.unlink(tmpZip).catch(() => {});
    }
  }, 'Could not install yt-dlp');
}

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG_PATH,
  process.env.PULSE_FFMPEG,
  path.join(BIN_DIR, platformBinary('ffmpeg')),
].filter(Boolean);

export async function findFfmpeg() {
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate && (await exists(candidate)) && (await validate(candidate, ['-version']))) return candidate;
  }
  if (process.platform !== 'win32') {
    const found = await new Promise((resolve) => {
      execFile('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true }, (error) =>
        resolve(error ? null : 'ffmpeg'),
      );
    });
    if (found) return found;
  }
  return null;
}

/**
 * Make sure ffmpeg is available (needed to merge separate video + audio).
 * Only Windows gets an automatic install; other systems must provide ffmpeg.
 */
export async function ensureFfmpeg(onProgress) {
  const existing = await findFfmpeg();
  if (existing) return existing;
  if (process.platform !== 'win32') {
    throw new Error('ffmpeg is required to merge video and audio. Install ffmpeg and add it to PATH.');
  }
  const exe = platformBinary('ffmpeg');
  const target = path.join(BIN_DIR, exe);
  return install(target, async () => {
    onProgress?.({ phase: 'installing-ffmpeg' });
    const tmpZip = path.join(os.tmpdir(), `pulsedm-${process.pid}-ffmpeg.zip`);
    try {
      await download(FFMPEG_WIN_ZIP, tmpZip, (received, total) => {
        onProgress?.({
          phase: 'downloading-ffmpeg',
          received,
          total,
          percent: total ? Math.min(100, (received / total) * 100) : 0,
        });
      });
      await extractFromZip(tmpZip, exe, target);
      if (!(await validate(target, ['-version']))) throw new Error('ffmpeg did not start after extracting');
      onProgress?.({ phase: 'ready' });
    } finally {
      await fs.unlink(tmpZip).catch(() => {});
    }
  }, 'Could not install ffmpeg');
}

/** Human readable note for the UI while tools install. */
export function installNote(info) {
  if (!info) return 'Preparing video engine…';
  if (info.phase === 'installing-ytdlp') return 'Installing the video engine (yt-dlp)…';
  if (info.phase === 'installing-ffmpeg') return 'Installing the merge tool (ffmpeg)…';
  if (info.phase === 'downloading-ytdlp' || info.phase === 'downloading-ffmpeg') {
    const label = info.phase === 'downloading-ytdlp' ? 'video engine' : 'merge tool';
    const size = info.total ? ` · ${formatBytes(info.total)}` : '';
    return `Downloading the ${label}${size} · ${Math.round(info.percent || 0)}%`;
  }
  return 'Preparing video engine…';
}

/* ------------------------------------------------------------------ */
/* Metadata + stream selection                                         */
/* ------------------------------------------------------------------ */

const STORYBOARD = /storyboard|thumbnail/i;

function isStoryboard(format) {
  return STORYBOARD.test(String(format.format_note || '')) ||
    String(format.format_id || '').startsWith('sb') ||
    STORYBOARD.test(String(format.resolution || ''));
}

function preferredExt(format) {
  return String(format.ext || '').toLowerCase();
}

function audioScore(format, language) {
  const note = String(format.format_note || '').toLowerCase();
  const lang = String(format.language || '').toLowerCase();
  let score = num(format.abr) * 10 || num(format.tbr);
  if (preferredExt(format) === 'm4a') score += 400;
  if (lang && language && lang === String(language).toLowerCase()) score += 300;
  if (note.includes('default')) score += 200;
  if (note.includes('drc')) score -= 20;
  return score;
}

function videoScore(format) {
  const ext = preferredExt(format);
  const codec = String(format.vcodec || '').toLowerCase();
  const protocol = String(format.protocol || '').toLowerCase();
  let score = num(format.height) * 10000 + num(format.fps) * 100;
  if (ext === 'mp4') score += 800;
  if (codec.startsWith('avc') || codec.startsWith('h264')) score += 400;
  else if (codec.startsWith('av01')) score += 300;
  else if (codec.startsWith('vp9') || codec.startsWith('vp09')) score += 100;
  if (protocol.startsWith('http')) score += 200;
  if (num(format.filesize) || num(format.filesize_approx)) score += 100;
  if (String(format.dynamic_range || '').toLowerCase().includes('hdr')) score -= 50;
  score += Math.min(99, num(format.tbr));
  return score;
}

/**
 * Pick the best stream combination.
 * With ffmpeg we take the highest quality video-only stream plus the best
 * audio; without it we fall back to a progressive (already combined) stream.
 */
export function selectFormats(info, { canMerge = false } = {}) {
  const formats = (info?.formats || []).filter((format) => format && format.url && !isStoryboard(format));
  const combined = formats
    .filter((format) => format.vcodec && format.vcodec !== 'none' && format.acodec && format.acodec !== 'none')
    .sort((a, b) => videoScore(b) - videoScore(a));
  const videos = formats
    .filter((format) => format.vcodec && format.vcodec !== 'none' && (!format.acodec || format.acodec === 'none'))
    .sort((a, b) => videoScore(b) - videoScore(a));
  const audios = formats
    .filter((format) => format.acodec && format.acodec !== 'none' && (!format.vcodec || format.vcodec === 'none'))
    .sort((a, b) => audioScore(b, info?.language) - audioScore(a, info?.language));

  const sizeOf = (format) => num(format.filesize) || num(format.filesize_approx);
  const bestCombined = combined[0] || null;
  const bestVideo = videos[0] || null;
  const bestAudio = audios[0] || null;
  const videoSize = bestVideo ? sizeOf(bestVideo) : 0;
  const audioSize = bestAudio ? sizeOf(bestAudio) : 0;
  // Only claim a size when the video stream size is known; otherwise progress
  // is filled in from yt-dlp's own byte counters while downloading.
  const mergedSize = videoSize ? videoSize + audioSize : 0;
  const mergedHeight = bestVideo ? num(bestVideo.height) : 0;
  const combinedHeight = bestCombined ? num(bestCombined.height) : 0;

  if (canMerge && bestVideo && bestAudio && (!bestCombined || mergedHeight >= combinedHeight)) {
    const ext = preferredExt(bestVideo) === 'mp4' && preferredExt(bestAudio) === 'm4a' ? 'mp4' : 'mkv';
    return {
      mode: 'merge',
      video: bestVideo,
      audio: bestAudio,
      format: bestVideo,
      selector: `${bestVideo.format_id}+${bestAudio.format_id}`,
      height: mergedHeight,
      fps: num(bestVideo.fps) || null,
      ext,
      size: mergedSize,
      label: `${mergedHeight ? `${mergedHeight}p` : 'Best quality'} ${ext.toUpperCase()} · video + audio`,
    };
  }

  if (bestCombined) {
    const ext = preferredExt(bestCombined) || 'mp4';
    return {
      mode: 'single',
      video: bestCombined,
      audio: null,
      format: bestCombined,
      selector: String(bestCombined.format_id),
      height: combinedHeight,
      fps: num(bestCombined.fps) || null,
      ext,
      size: sizeOf(bestCombined),
      label: `${combinedHeight ? `${combinedHeight}p` : 'Best quality'} ${ext.toUpperCase()}`,
    };
  }

  if (bestVideo) {
    // Video-only streams hide their audio; explain instead of saving a mute file.
    throw new Error('This video only offers separate video and audio streams, which need ffmpeg to merge.');
  }
  throw new Error('No downloadable video stream was found on this page.');
}

export function videoFilename(info, selection) {
  const rawTitle = String(info?.title || info?.fulltitle || info?.id || '').trim();
  let stem = sanitizeFilename(rawTitle || 'video', 'video');
  const ext = `.${selection?.ext || 'mp4'}`;
  if (path.extname(stem).toLowerCase() === ext) {
    return stem;
  }
  if (stem.length > 150) stem = stem.slice(0, 150).trim();
  return `${stem}${ext}`;
}

async function readInfo(url, { signal, ytdlp } = {}) {
  const exe = ytdlp || (await ensureYtdlp());
  const args = ['-J', '--no-playlist', '--no-warnings', '--socket-timeout', '20', url];
  const child = spawn(exe, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  const limit = 96 * 1024 * 1024;
  const timer = setTimeout(() => {
    stderr += '\nTimed out reading video info';
    killTree(child);
  }, PROBE_TIMEOUT);
  const abort = () => killTree(child);
  signal?.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (stdout.length < limit) stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  const code = await new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    child.on('error', (error) => {
      stderr += `\n${error.message}`;
      finish(-1);
    });
    child.on('exit', (value, signal) => finish(value ?? (signal ? -1 : 0)));
    child.on('close', (value) => finish(value ?? -1));
  });
  clearTimeout(timer);
  signal?.removeEventListener('abort', abort);
  if (code !== 0) throw new Error(friendlyVideoError(stderr));
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new Error('The video site returned an unexpected response.');
  }
  if (info?.entries?.length) info = info.entries[0];
  if (!info || !Array.isArray(info.formats)) throw new Error('No playable streams were found for this link.');
  return info;
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // yt-dlp's bootloader spawns a child process; killing only the parent
    // leaves that child downloading, so end the whole tree first.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 2500);
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/**
 * Probe a video page and return metadata shaped like the file probe plus
 * video-specific fields used by the UI.
 */
export async function probeVideo(url, { canMerge = false, signal, onStatus } = {}) {
  onStatus?.('Reading video info…');
  const ytdlp = await ensureYtdlp((info) => onStatus?.(installNote(info)));
  onStatus?.('Reading video info…');
  const info = await readInfo(url, { signal, ytdlp });
  const selection = selectFormats(info, { canMerge: !!canMerge });
  const filename = videoFilename(info, selection);
  return {
    url,
    finalUrl: info.webpage_url || url,
    filename,
    size: selection.size,
    resumable: true,
    contentType: `video/${selection.ext === 'mkv' ? 'x-matroska' : selection.ext}`,
    video: true,
    title: String(info.title || '').slice(0, 300),
    uploader: String(info.uploader || info.channel || '').slice(0, 160),
    duration: Math.round(num(info.duration)),
    height: selection.height || 0,
    fps: selection.fps || null,
    ext: selection.ext,
    formatLabel: selection.label,
    formatSelector: selection.selector,
    mode: selection.mode,
    needsFfmpeg: selection.mode === 'merge',
    ytdlp,
  };
}

/** Format yt-dlp args for one download. */
export function buildDownloadArgs(item, { ytdlp, ffmpeg, ext = 'mp4' } = {}) {
  const base = item.videoTemp || item.savePath || item.filename || 'video';
  const stem = item.videoTemp ? path.basename(item.videoTemp) : path.basename(base, path.extname(base));
  const args = [
    '--no-playlist',
    '--newline',
    '--no-warnings',
    '--continue',
    '--no-mtime',
    '--socket-timeout', '30',
    '--retries', '5',
    '--fragment-retries', '5',
    '--concurrent-fragments', '4',
    '--progress-template',
    'pdm:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '-P', item.dir,
    '-o', `${stem}.%(ext)s`,
    '--merge-output-format', ext === 'mkv' ? 'mkv' : 'mp4',
  ];
  if (item.videoSelector) args.push('-f', item.videoSelector);
  else args.push('-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b');
  if (ffmpeg) {
    const location = path.dirname(ffmpeg) || ffmpeg;
    args.push('--ffmpeg-location', location);
  }
  if (item.speedLimit && item.speedLimit > 0) args.push('--limit-rate', String(Math.round(item.speedLimit)));
  args.push('--', item.url);
  return args;
}
