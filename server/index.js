import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { DownloadManager, defaultSettings } from './manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PULSE_PORT || 8787);
const HOST = process.env.PULSE_HOST || '127.0.0.1';
const OPEN_ON_START = process.argv.includes('--open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

let manager;
const clients = new Set();
let statePending = true;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, error, status = 500) {
  sendJson(res, { error: error?.message || String(error) }, status);
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

async function serveStatic(urlPath, res) {
  let relative = decodeURIComponent(urlPath);
  if (relative === '/' || relative === '') relative = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) throw new Error('not a file');
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    const fallback = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': fallback.length });
    res.end(fallback);
  }
}

function broadcastState() {
  if (!clients.size) return;
  const payload = JSON.stringify(manager.getState());
  for (const res of clients) {
    res.write(`event: state\ndata: ${payload}\n\n`);
  }
}

function openExternal(target) {
  return new Promise((resolve) => {
    if (!target) return resolve(false);
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        execFile('explorer.exe', [target], { windowsHide: true }, () => resolve(true));
      } else if (platform === 'darwin') {
        execFile('open', [target], () => resolve(true));
      } else {
        execFile('xdg-open', [target], () => resolve(true));
      }
    } catch {
      resolve(false);
    }
  });
}

function revealInFolder(target) {
  return new Promise((resolve) => {
    if (!target) return resolve(false);
    const platform = process.platform;
    try {
      if (platform === 'win32') {
        execFile('explorer.exe', [`/select,${target}`], { windowsHide: true }, () => resolve(true));
      } else if (platform === 'darwin') {
        execFile('open', ['-R', target], () => resolve(true));
      } else {
        execFile('xdg-open', [path.dirname(target)], () => resolve(true));
      }
    } catch {
      resolve(false);
    }
  });
}

function pickFolder() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ path: null, supported: false });
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
      "$dialog.Description = 'Choose PulseDM download folder';",
      "$dialog.UseDescriptionForTitle = $true;",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
    ].join(' ');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { windowsHide: true, timeout: 180000 },
      (error, stdout) => {
        resolve({ path: (stdout || '').trim() || null, supported: true, error: error?.message });
      },
    );
  });
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
  } else if (process.platform === 'darwin') {
    execFile('open', [url], () => {});
  } else {
    execFile('xdg-open', [url], () => {});
  }
}

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('retry: 2000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(manager.getState())}\n\n`);
  clients.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    return sendJson(res, {
      ok: true,
      app: 'PulseDM',
      version: '1.0.0',
      port: PORT,
      uptime: Math.round(process.uptime()),
      platform: process.platform,
      node: process.version,
    });
  }

  if (pathname === '/api/state' && method === 'GET') {
    return sendJson(res, manager.getState());
  }

  if (pathname === '/api/events' && method === 'GET') {
    return sse(req, res);
  }

  if (pathname === '/api/defaults' && method === 'GET') {
    return sendJson(res, {
      home: os.homedir(),
      settings: defaultSettings(),
    });
  }

  if (pathname === '/api/probe' && method === 'POST') {
    const body = await readBody(req);
    const meta = await manager.probe(body.url);
    return sendJson(res, meta);
  }

  if (pathname === '/api/downloads' && method === 'POST') {
    const body = await readBody(req);
    const urls = Array.isArray(body.urls) ? body.urls : [body.url];
    const clean = urls.map((entry) => String(entry || '').trim()).filter(Boolean);
    if (!clean.length) return sendError(res, new Error('Enter a download link'), 400);
    const added = [];
    const failed = [];
    for (const entry of clean) {
      try {
        added.push(
          await manager.add({
            url: entry,
            filename: clean.length === 1 ? body.filename : '',
            dir: body.dir,
            connections: body.connections,
            startAt: body.startAt,
          }),
        );
      } catch (error) {
        failed.push({ url: entry, error: error.message });
      }
    }
    if (!added.length) return sendError(res, new Error(failed[0]?.error || 'Could not add download'), 400);
    return sendJson(res, { added, failed }, 201);
  }

  if (pathname === '/api/probe-url' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, await manager.probe(body.url));
  }

  if (pathname === '/api/settings' && method === 'GET') {
    return sendJson(res, manager.settings);
  }

  if (pathname === '/api/settings' && method === 'PUT') {
    const body = await readBody(req);
    const settings = await manager.updateSettings(body);
    return sendJson(res, settings);
  }

  if (pathname === '/api/pause-all' && method === 'POST') {
    manager.pauseAll();
    return sendJson(res, { paused: true });
  }

  if (pathname === '/api/resume-all' && method === 'POST') {
    manager.resumeAll();
    return sendJson(res, { paused: false });
  }

  if (pathname === '/api/clear-completed' && method === 'POST') {
    await manager.clearCompleted();
    return sendJson(res, { ok: true });
  }

  if (pathname === '/api/pick-folder' && method === 'POST') {
    return sendJson(res, await pickFolder());
  }

  const itemMatch = /^\/api\/downloads\/([a-f0-9-]+)(?:\/(pause|resume|retry|open|reveal))?$/.exec(
    pathname,
  );
  if (itemMatch) {
    const id = itemMatch[1];
    const action = itemMatch[2];
    const item = manager.get(id);
    if (!item) return sendError(res, new Error('Download not found'), 404);

    if (!action && method === 'DELETE') {
      const deleteFile = searchParams.get('deleteFile') === '1';
      await manager.remove(id, deleteFile);
      return sendJson(res, { ok: true });
    }
    if (action === 'pause' && method === 'POST') return sendJson(res, manager.pause(id));
    if ((action === 'resume' || action === 'retry') && method === 'POST') {
      return sendJson(res, manager.resume(id));
    }
    if (action === 'open' && method === 'POST') {
      if (item.status !== 'completed' || !item.savePath) {
        return sendError(res, new Error('This file is not finished yet'), 400);
      }
      await openExternal(item.savePath);
      return sendJson(res, { ok: true });
    }
    if (action === 'reveal' && method === 'POST') {
      const target =
        item.status === 'completed' && item.savePath ? item.savePath : item.dir || manager.settings.defaultDir;
      await revealInFolder(target);
      return sendJson(res, { ok: true });
    }
    return sendError(res, new Error('Unsupported action'), 405);
  }

  if (pathname === '/api/open-folder' && method === 'POST') {
    const body = await readBody(req);
    await openExternal(body.dir || manager.settings.defaultDir);
    return sendJson(res, { ok: true });
  }

  return sendError(res, new Error('Not found'), 404);
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(url.pathname, res);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    console.error('[PulseDM]', error);
    sendError(res, error, error.status || 500);
  }
});

async function main() {
  manager = new DownloadManager({ dataDir: DATA_DIR });
  await manager.init();

  manager.on('change', () => {
    statePending = true;
  });

  setInterval(() => {
    if (!statePending) return;
    statePending = false;
    broadcastState();
  }, 500).unref();

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`PulseDM is already running at http://${HOST}:${PORT}`);
      if (OPEN_ON_START) openBrowser(`http://${HOST}:${PORT}`);
      process.exit(0);
    }
    console.error('[PulseDM] Server error:', error);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    const address = `http://${HOST}:${PORT}`;
    console.log('');
    console.log('  PulseDM is ready.');
    console.log(`  ${address}`);
    console.log(`  Saving to ${manager.settings.defaultDir}`);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
    if (OPEN_ON_START) openBrowser(address);
  });

  const shutdown = async () => {
    console.log('\nStopping PulseDM...');
    await manager.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('[PulseDM] Failed to start:', error);
  process.exit(1);
});
