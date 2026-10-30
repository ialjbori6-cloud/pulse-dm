/**
 * PulseDM engine self-test.
 *
 * Spins up a local HTTP server that supports byte ranges, then exercises the
 * real download engine end to end:
 *   1. multi-connection segmented download + checksum
 *   2. probe metadata (name, size, resumability)
 *   3. pause / resume with partial-file persistence
 *   4. non-resumable single stream fallback
 *   5. queue concurrency limit
 *   6. delete-from-disk
 *
 * Run with: npm test
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DownloadManager } from '../server/manager.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}${detail ? `  \x1b[90m(${detail})\x1b[0m` : ''}`);
  } else {
    failures += 1;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `  \x1b[90m(${detail})\x1b[0m` : ''}`);
  }
}

function sha(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function waitFor(label, fn, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makePayload(bytes) {
  const buffer = Buffer.alloc(bytes);
  let value = 7;
  for (let i = 0; i < bytes; i += 1) {
    value = (value * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = value & 0xff;
  }
  return buffer;
}

const resumablePayload = makePayload(6 * 1024 * 1024 + 12345);
const streamPayload = makePayload(1 * 1024 * 1024 + 777);
const rangeHits = new Map();

function rangeResponse(req, res, payload, { contentType = 'application/octet-stream', name = 'file.bin' } = {}) {
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1;
      if (start >= payload.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        res.end();
        return;
      }
      const slice = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': slice.length,
      });
      res.end(slice);
      return;
    }
  }
  res.writeHead(200, { 'Content-Length': payload.length });
  res.end(payload);
}

async function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    rangeHits.set(url.pathname, (rangeHits.get(url.pathname) || 0) + 1);
    if (url.pathname === '/media/sample-video.mp4') {
      return rangeResponse(req, res, resumablePayload, {
        contentType: 'video/mp4',
        name: 'sample-video.mp4',
      });
    }
    if (url.pathname === '/plain.bin') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': streamPayload.length,
        'Content-Disposition': 'attachment; filename="plain.bin"',
      });
      res.end(streamPayload);
      return;
    }
    if (url.pathname === '/queue-a.bin' || url.pathname === '/queue-b.bin') {
      return rangeResponse(req, res, makePayload(2 * 1024 * 1024), { name: path.basename(url.pathname) });
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function main() {
  console.log('\nPulseDM engine self-test\n' + '─'.repeat(52));

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pulsedm-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const downloadDir = path.join(tempRoot, 'downloads');
  const { server, base } = await startServer();
  const manager = new DownloadManager({ dataDir });
  manager.on('change', () => {});
  await manager.init();
  await manager.updateSettings({
    defaultDir: downloadDir,
    maxConcurrent: 2,
    defaultConnections: 6,
    speedLimit: 0,
    schedule: { enabled: false, start: '01:00', stop: '07:00' },
    clipboardWatch: false,
  });

  try {
    console.log('\n1) Probe + segmented download');
    const probe = await manager.probe(`${base}/media/sample-video.mp4`);
    check('probe reports the real file size', probe.size === resumablePayload.length, `${probe.size} bytes`);
    check('probe reads Content-Disposition filename', probe.filename === 'sample-video.mp4', probe.filename);
    check('probe detects range support', probe.resumable === true);

    const added = await manager.add({
      url: `${base}/media/sample-video.mp4`,
      connections: 6,
    });
    check('download is accepted and queued', !!added.id, added.status);
    const first = manager.get(added.id);
    await waitFor('segmented download', () => first.status === 'completed', 40000);
    const firstBytes = await fs.readFile(first.savePath);
    check('file size matches source', firstBytes.length === resumablePayload.length, `${firstBytes.length} bytes`);
    check('sha-256 matches source', sha(firstBytes) === sha(resumablePayload));
    check(
      'server received multiple range requests',
      (rangeHits.get('/media/sample-video.mp4') || 0) > 2,
      `${rangeHits.get('/media/sample-video.mp4')} requests`,
    );
    check('partial file renamed on completion', await fs.access(first.partPath).then(() => false).catch(() => true));

    console.log('\n2) Pause + resume');
    await manager.updateSettings({ speedLimit: 1536 * 1024 });
    const paused = await manager.add({
      url: `${base}/media/sample-video.mp4?second=1`,
      filename: 'paused-copy.mp4',
      connections: 4,
    });
    const second = manager.get(paused.id);
    await waitFor('download to gather data', () => second.received > 700 * 1024, 20000);
    manager.pause(second.id);
    await waitFor('pause to settle', () => second.status === 'paused' && !second._running, 10000);
    const receivedAtPause = second.received;
    const partExists = await fs.access(second.partPath).then(() => true).catch(() => false);
    await sleep(700);
    check('progress stops when paused', second.received === receivedAtPause, `${receivedAtPause} bytes`);
    check('partial file is kept for resume', partExists);
    check('chunk map retains progress', second.chunks.some((chunk) => chunk.received > 0));

    manager.resume(second.id);
    await waitFor('resumed download', () => second.status === 'completed', 40000);
    const secondBytes = await fs.readFile(second.savePath);
    check('resumed file is complete and valid', sha(secondBytes) === sha(resumablePayload));
    check('resume started from existing bytes', receivedAtPause > 0, `${receivedAtPause} bytes reused`);
    await manager.updateSettings({ speedLimit: 0 });

    console.log('\n3) Non-resumable fallback');
    const streamAdded = await manager.add({ url: `${base}/plain.bin`, connections: 8 });
    const third = manager.get(streamAdded.id);
    await waitFor('single stream download', () => third.status === 'completed', 30000);
    const streamBytes = await fs.readFile(third.savePath);
    check('single stream file is complete', sha(streamBytes) === sha(streamPayload));
    check('single stream is marked non-resumable', third.resumable === false);

    console.log('\n4) Queue concurrency');
    await manager.updateSettings({ maxConcurrent: 1, speedLimit: 1024 * 1024 });
    const qa = await manager.add({ url: `${base}/queue-a.bin`, connections: 2 });
    const qb = await manager.add({ url: `${base}/queue-b.bin`, connections: 2 });
    let maxActive = 0;
    let observed = 0;
    const sampler = setInterval(() => {
      const active = manager.items.filter((item) =>
        ['starting', 'downloading'].includes(item.status),
      ).length;
      maxActive = Math.max(maxActive, active);
      observed += 1;
    }, 30);
    await waitFor(
      'both queued downloads',
      () => manager.get(qa.id).status === 'completed' && manager.get(qb.id).status === 'completed',
      45000,
    );
    clearInterval(sampler);
    check('respects max concurrent downloads', maxActive === 1, `${maxActive} active over ${observed} samples`);
    check('second queued item eventually ran', manager.get(qb.id).status === 'completed');
    await manager.updateSettings({ speedLimit: 0 });

    console.log('\n5) Remove + delete file');
    const target = manager.get(qa.id);
    await manager.remove(qa.id, true);
    check('record removed from list', !manager.get(qa.id));
    check('file deleted from disk', await fs.access(target.savePath).then(() => false).catch(() => true));

    console.log('\n6) Persistence');
    const queuedItem = await manager.add({ url: `${base}/queue-a.bin?later=1`, connections: 2 });
    manager.pause(queuedItem.id);
    await manager.saveNow();
    await manager.close();
    const restored = new DownloadManager({ dataDir });
    await restored.init();
    const restoredItem = restored.get(queuedItem.id);
    check('download list survives a restart', !!restoredItem);
    check('settings survive a restart', restored.settings.maxConcurrent === 1, String(restored.settings.maxConcurrent));
    check('paused state survives a restart', restoredItem?.status === 'paused', restoredItem?.status);
    await restored.close();
  } finally {
    server.close();
    await manager.close().catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log('─'.repeat(52));
  const passed = results.length - failures;
  console.log(`${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${results.length} checks passed\x1b[0m\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nSelf-test crashed:', error);
  process.exit(1);
});
