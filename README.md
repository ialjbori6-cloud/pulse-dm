# PulseDM

A working Internet Download Manager–style app for Windows, macOS and Linux. It has a **real segmented download engine** (up to 16 parallel range connections), pause/resume, a queue, scheduler, speed limiting, a modern web interface, and a browser extension that captures links and browser downloads.

Everything runs locally. No accounts, no cloud, no telemetry, no npm dependencies.

```
┌──────────────────────────────────────────────────────────────┐
│  PulseDM                                             —  □  ×  │
├───────────────┬──────────────────────────────────────────────┤
│  All downloads│  32.4 MB/s       3 active · 2 queued          │
│  In progress  │  ┌────────────────────────────────────────┐  │
│  Unfinished   │  │ ▶ Ubuntu 24.04.iso        8×  62%      │  │
│  Finished     │  │ ♪ Podcast ep.42.mp3       4×  100%     │  │
│  Video        │  │ ▣ project-assets.zip      8×  paused   │  │
│  Music …      │  └────────────────────────────────────────┘  │
└───────────────┴──────────────────────────────────────────────┘
```

---

## Quick start

### Windows (one click)

1. Install **Node.js 20 or newer** from [nodejs.org](https://nodejs.org) (only required runtime).
2. Double-click **`PulseDM.vbs`** — the engine starts hidden and the app opens in your browser.
   - Prefer a visible console? Use **`PulseDM.bat`** instead.
3. Downloads go to `%USERPROFILE%\Downloads\PulseDM` by default.

### Any platform (terminal)

```bash
cd pulse-dm
npm start          # starts the engine and opens the UI
# or
npm run serve      # no browser auto-open
```

Then open <http://127.0.0.1:8787>.

### Install the browser extension (optional but recommended)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.
4. Pin **PulseDM — Download Catcher** to the toolbar.

Now you can:

- right-click any link → **Download with PulseDM**
- right-click a video/audio/image → **Download media with PulseDM**
- paste a link in the popup and send it
- enable **Take over browser downloads** to cancel Chrome downloads and route them to PulseDM automatically

The extension talks to the local engine on `http://127.0.0.1:8787`.

---

## Features

| Area | What it does |
| --- | --- |
| **Segmented engine** | Splits files into chunks and downloads them over up to 16 parallel HTTP Range connections, then merges into the final file |
| **Resume** | Every chunk's progress is persisted; pause, close the app, or reboot and resume from the exact byte |
| **Queue** | Configurable simultaneous downloads (1–8); the rest wait their turn |
| **Pause / resume all** | Toolbar or scheduler-driven queue control |
| **Scheduler** | Optional download window (e.g. 01:00–07:00); outside it the queue parks itself and resumes automatically |
| **Speed limit** | Token-bucket throttle: unlimited, 1, 2, 5, 10, 25, 50 MB/s |
| **Metadata probe** | Reads `Content-Disposition`, size, MIME type and range support before downloading |
| **Single-stream fallback** | Servers without Range support get a normal streamed download |
| **Retries** | Failed chunks retry with backoff (3 attempts) without losing progress |
| **Categories** | Auto-sorts video, music, documents, programs, compressed, images, other |
| **Live UI** | Server-Sent Events push progress every 500 ms; speed sparkline, per-chunk connection map, ETA |
| **Clipboard & drag-drop** | Paste a link anywhere or drop links onto the page |
| **Folder picker** | Native Windows folder dialog for choosing destinations |
| **Persistence** | Queue, settings and partial state survive restarts |
| **No dependencies** | Pure Node.js standard library + vanilla HTML/CSS/JS |

---

## How the download engine works

1. **Probe** — sends `GET` with `Range: bytes=0-0` to learn the size, filename, MIME type and whether the server returns `206 Partial Content`.
2. **Plan** — splits the file into chunks sized dynamically for the chosen connection count (256 KB–16 MB each, roughly 16 chunks per worker).
3. **Fetch** — N workers pull unfinished chunks with `Range: bytes=<start>-<end>`, writing each response at its exact offset in a `.pulsesave` file (`fs.createWriteStream` with `start`).
4. **Track** — each chunk stores `received`/`done`; state is checkpointed to `data/state.json` while downloading and immediately on pause.
5. **Finish** — verifies the size, renames the part file to its final name, and checks for collisions (`file (1).zip`).

If the server does not support ranges, PulseDM falls back to one sequential stream; resuming then restarts that file from zero.

Speed limiting uses a token bucket shared by all workers, so the total throughput stays under the configured cap.

---

## Interface

- **Sidebar** — library filters, file-type categories with counts, live throughput sparkline, save-folder shortcut.
- **Hero** — total speed, active/queued/completed counters, overall progress bar, scheduler/pause banner.
- **Queue** — rows with category icon, size, status pill, segmented progress, speed + ETA, and status-aware actions.
- **Details drawer** — click any row for a per-chunk connection map, full metadata, source URL and save path.
- **New download dialog** — checks the link, shows filename/size/resumability, lets you pick name, folder, connections, or schedule it.
- **Settings** — folder, concurrency, connections, speed cap, schedule window, clipboard offers, light/dark theme.
- **Keyboard** — `Ctrl/Cmd+N` new download, `Esc` closes panels, `Enter`/`Space` opens a focused row.

Light theme is available in Settings → Appearance. The choice is stored in `localStorage`.

---

## Project structure

```
pulse-dm/
├── server/
│   ├── index.js          HTTP server, REST API, SSE, static files, OS integration
│   ├── manager.js        segmented download engine, queue, scheduler, rate limiter
│   └── utils.js          filenames, categories, MIME/URL helpers
├── public/
│   ├── index.html        app shell
│   ├── styles.css        full design system (dark + light, responsive)
│   ├── app.js            live UI, dialogs, drag & drop, SSE client
│   └── favicon.svg
├── extension/
│   ├── manifest.json     Chrome/Edge MV3
│   ├── background.js     context menus + browser-download takeover
│   ├── popup.html/.js    send links, toggle takeover
│   └── icons/            generated PNG icons
├── tools/
│   ├── selftest.mjs      end-to-end engine test (local range server + checksums)
│   └── make-icons.mjs    PNG icon generator (pure Node)
├── data/                 runtime queue + settings (created automatically)
├── PulseDM.vbs/.bat/.command
└── package.json
```

---

## HTTP API

The UI is a client of the same API, so it can be automated or integrated.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | engine status |
| `GET` | `/api/state` | full queue, stats, settings |
| `GET` | `/api/events` | SSE stream (`state` events) |
| `POST` | `/api/downloads` | add `{ url, filename?, dir?, connections?, startAt? }` or `{ urls: [...] }` |
| `POST` | `/api/probe` | inspect a URL without downloading |
| `POST` | `/api/downloads/:id/pause` | pause |
| `POST` | `/api/downloads/:id/resume` | resume / retry |
| `POST` | `/api/downloads/:id/open` | open finished file |
| `POST` | `/api/downloads/:id/reveal` | show in file manager |
| `DELETE` | `/api/downloads/:id?deleteFile=1` | remove (optionally delete file) |
| `POST` | `/api/pause-all` · `/api/resume-all` | queue control |
| `POST` | `/api/clear-completed` | remove completed records (files stay) |
| `GET`/`PUT` | `/api/settings` | read/update settings |
| `POST` | `/api/pick-folder` | native folder picker (Windows) |
| `POST` | `/api/open-folder` | open a folder |

Example:

```bash
curl -X POST http://127.0.0.1:8787/api/downloads \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/big.iso","connections":8}'
```

The port can be changed with `PULSE_PORT` (update `extension/background.js`/`popup.js` and manifest host permissions if you do).

---

## Tests

```bash
npm test
```

The suite starts a local HTTP server with range support and exercises the actual engine:

```
1) Probe + segmented download   ✓ size, name, ranges, checksum, 27 range requests
2) Pause + resume               ✓ progress frozen, part kept, checksum after resume
3) Non-resumable fallback       ✓ sequential stream checksum
4) Queue concurrency            ✓ never more than maxConcurrent active
5) Remove + delete file         ✓ record and disk cleanup
6) Persistence                  ✓ queue/settings/paused state across restart
22/22 checks passed
```

Regenerate extension icons with `npm run icons`.

---

## Notes & limitations

- **Local engine required** — browsers cannot write arbitrary files or merge parallel downloads, so a small local Node process does the work; the UI is served by it.
- Only unauthenticated `http`/`https` links. No cookie/session import, HLS/DASH segment reassembly, or FTP.
- The range downloader relies on servers returning `206`. If a server lies about range support, the file is restarted as a single stream.
- Browser-download takeover is opt-in and works on Chrome/Edge MV3. Firefox support would need a separate manifest and API tweaks.
- On non-Windows systems the native folder picker is unavailable; type the path instead.
- `.pulsesave` files are partial data. Removing a queued/paused download deletes its part file; completed files are never deleted unless you ask.

## Security

The server binds to `127.0.0.1` only and is intended for a single trusted user. It has no authentication, can write files to any path your user can access, and opens files/folders on request. Do not expose port 8787 to a network or the internet.

## Tech

Node.js 20+ (`http`, `fs`, `fetch`, streams, SSE) · vanilla HTML/CSS/JS · Canvas 2D · Chrome/Edge Manifest V3.

No affiliation with Internet Download Manager (Tonec) — PulseDM is an original implementation inspired by its workflow.
