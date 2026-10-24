// DevHub shared library
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  HOME, PLATFORM, IS_MAC, IS_LINUX, IS_WIN, platformLabel,
  which, whichSync, execShell, killProcess, pathWithExtras,
} from './platform.mjs';

const rawExec = promisify(execFile);
const exec = (file, args, options = {}) => rawExec(file, args, { windowsHide: true, ...options });
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { HOME, PLATFORM, IS_MAC, IS_LINUX, IS_WIN, which, platformLabel };

export const ROOT = path.resolve(__dirname, '..');
export const CONFIG_DIR = IS_WIN
  ? path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'devhub')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'devhub');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TASKS_FILE = path.join(CONFIG_DIR, 'tasks.json');
export const STATE_DIR = IS_WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'devhub')
  : path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'devhub');
export const OUTPUT_DIR = path.join(STATE_DIR, 'output');
export const LOG_DIR = path.join(STATE_DIR, 'logs');
export const TMP_DIR = path.join(STATE_DIR, 'tmp');
export const DOWNLOAD_DIR = path.join(HOME, 'Downloads');

export const DEFAULT_CONFIG = {
  port: 7070,
  scanRoots: [
    path.join(HOME, 'Projects'),
    path.join(HOME, 'Sites'),
    path.join(HOME, 'dev'),
    path.join(HOME, 'Developer'),
    path.join(HOME, 'code'),
  ],
  scanDepth: 2,
  outputDir: OUTPUT_DIR,
  downloadDir: DOWNLOAD_DIR,
  image: { quality: 75, maxDim: 1920 },
  video: { preset: '1080p' },
  services: [],
};

export const VIDEO_PRESETS = {
  '4k': { mac: 'Preset3840x2160', height: 2160 },
  '1080p': { mac: 'Preset1920x1080', height: 1080 },
  '720p': { mac: 'Preset1280x720', height: 720 },
  '480p': { mac: 'Preset640x480', height: 480 },
};

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.tif', '.tiff', '.gif', '.bmp', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm', '.ts', '.3gp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.aiff', '.aif', '.caf', '.flac', '.ogg', '.opus']);
export const MEDIA_EXT = new Set([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT]);

export async function ensureDirs() {
  for (const dir of [CONFIG_DIR, STATE_DIR, OUTPUT_DIR, LOG_DIR, TMP_DIR, DOWNLOAD_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

export async function loadConfig() {
  const saved = await readJson(CONFIG_FILE, {});
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    image: { ...DEFAULT_CONFIG.image, ...(saved.image || {}) },
    video: { ...DEFAULT_CONFIG.video, ...(saved.video || {}) },
    scanRoots: Array.isArray(saved.scanRoots) && saved.scanRoots.length ? saved.scanRoots : DEFAULT_CONFIG.scanRoots,
    services: Array.isArray(saved.services) ? saved.services : DEFAULT_CONFIG.services,
  };
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...patch };
  await writeJson(CONFIG_FILE, next);
  return next;
}

export async function loadTasks() {
  const data = await readJson(TASKS_FILE, { tasks: [] });
  return Array.isArray(data.tasks) ? data.tasks : [];
}

export async function saveTasks(tasks) {
  await writeJson(TASKS_FILE, { tasks });
}

export function hashId(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 10);
}

export function slugify(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

export function logName(id) {
  return `${String(id).replace(/[^a-z0-9_-]/gi, '_')}.log`;
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function detectProject(dir) {
  const has = (f) => exists(path.join(dir, f));
  let command = null, port = null, type = 'unknown';

  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch {}
    const scripts = pkg.scripts || {};
    const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.preview ? 'preview' : null;
    command = scriptName ? `npm run ${scriptName}` : 'npm run dev';
    const raw = scriptName ? String(scripts[scriptName] || '') : '';
    const m = raw.match(/--port[=\s]+(\d{2,5})/);
    port = m ? Number(m[1]) : 3000;
    type = 'node';
  } else if (has('artisan')) {
    command = 'php artisan serve --host=127.0.0.1 --port=8000';
    port = 8000; type = 'laravel';
  } else if (has('composer.json')) {
    command = has('public') ? 'php -S 127.0.0.1:8000 -t public' : 'php -S 127.0.0.1:8000';
    port = 8000; type = 'php';
  } else if (has('index.php')) {
    command = 'php -S 127.0.0.1:8000';
    port = 8000; type = 'php';
  } else if (has('manage.py')) {
    command = 'python3 manage.py runserver 127.0.0.1:8000';
    port = 8000; type = 'django';
  } else if (has('index.html')) {
    command = 'python3 -m http.server 8000 --bind 127.0.0.1';
    port = 8000; type = 'static';
  }

  return { command, port, type };
}

const SKIP_DIRS = new Set([
  'node_modules', 'vendor', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  'Library', '.cache', '.local', '.npm', '.Trash', 'Applications', 'Movies', 'Music', 'Pictures',
]);

export async function scanProjects(cfg) {
  const found = new Set();
  const depthLimit = Number(cfg.scanDepth || 2);

  async function walk(dir, depth) {
    if (depth > depthLimit) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((e) => e.name));
    if (['package.json', 'composer.json', 'index.php', 'artisan', 'manage.py', 'index.html'].some((n) => names.has(n))) {
      found.add(dir);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), depth + 1);
    }
  }

  for (const root of cfg.scanRoots || []) {
    if (!exists(root)) continue;
    await walk(root, 1);
  }
  return [...found];
}

export async function mergedTasks(cfg) {
  const manual = await loadTasks();
  const knownPaths = new Set(manual.map((t) => path.resolve(t.path)));
  const tasks = manual.map((t) => ({ ...t, source: t.source || 'manual' }));

  for (const dir of await scanProjects(cfg)) {
    const resolved = path.resolve(dir);
    if (knownPaths.has(resolved)) continue;
    const detected = detectProject(dir);
    if (!detected.command) continue;
    tasks.push({
      id: `auto:${hashId(resolved)}`,
      name: path.basename(dir),
      path: resolved,
      command: detected.command,
      port: detected.port,
      type: detected.type,
      source: 'auto',
    });
  }

  tasks.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'manual' ? -1 : 1));
  return tasks;
}

export async function findTask(id, cfg) {
  const tasks = await mergedTasks(cfg);
  return tasks.find((t) => t.id === id) || null;
}

// ---------------------------------------------------------------- ports

const KNOWN_PORTS = {
  22: 'sshd',
  80: 'httpd (apache)',
  88: 'kerberos',
  443: 'httpd (apache)',
  5900: 'screensharingd',
  8000: 'http server',
  8080: 'http server',
  9000: 'php-fpm',
};

export function portOpen(port, host = '127.0.0.1', timeout = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function listPortsMac() {
  const listeners = new Map();
  const netstat = whichSync('netstat') || '/usr/sbin/netstat';

  try {
    const { stdout } = await exec(netstat, ['-an', '-p', 'tcp'], { maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[5] !== 'LISTEN') continue;
      const local = fields[3] || '';
      const port = Number(local.split('.').pop());
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
      const address = local.replace(/\.\d+$/, '');
      if (!listeners.has(port)) listeners.set(port, { port, address, pid: null, command: '' });
    }
  } catch {}

  let stdout = '';
  const lsof = whichSync('lsof');
  if (lsof) {
    try {
      ({ stdout } = await exec(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { maxBuffer: 4 * 1024 * 1024 }));
    } catch (error) {
      stdout = error.stdout || '';
    }
  }

  let current = null;
  const seen = new Set();
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      current = { pid: Number(value), command: '', address: '', port: 0 };
    } else if (tag === 'c' && current) {
      current.command = value;
    } else if (tag === 'n' && current) {
      const match = value.match(/:(\d+)$/);
      if (!match) continue;
      const port = Number(match[1]);
      const key = `${current.pid}:${port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = listeners.get(port) || {};
      listeners.set(port, {
        port,
        pid: current.pid,
        command: current.command,
        address: existing.address || value.slice(0, -match[0].length),
      });
    }
  }

  return listeners;
}

async function listPortsLinux() {
  const listeners = new Map();
  const ss = whichSync('ss');

  if (ss) {
    try {
      const { stdout } = await exec(ss, ['-ltnpH'], { maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const fields = line.trim().split(/\s+/);
        const local = fields[3] || '';
        const match = local.match(/:(\d+)$/);
        if (!match) continue;
        const port = Number(match[1]);
        if (!Number.isInteger(port) || port <= 0) continue;
        const user = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        listeners.set(port, {
          port,
          address: local.slice(0, -match[0].length) || '*',
          pid: user ? Number(user[2]) : null,
          command: user ? user[1] : '',
        });
      }
    } catch {}
  }

  if (!listeners.size) {
    const lsof = whichSync('lsof');
    if (lsof) {
      try {
        const { stdout } = await exec(lsof, ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'], { maxBuffer: 4 * 1024 * 1024 });
        let current = null;
        for (const line of stdout.split('\n')) {
          if (!line) continue;
          const tag = line[0];
          const value = line.slice(1);
          if (tag === 'p') current = { pid: Number(value), command: '', address: '', port: 0 };
          else if (tag === 'c' && current) current.command = value;
          else if (tag === 'n' && current) {
            const match = value.match(/:(\d+)$/);
            if (!match) continue;
            const port = Number(match[1]);
            listeners.set(port, {
              port,
              pid: current.pid,
              command: current.command,
              address: value.slice(0, -match[0].length) || '*',
            });
          }
        }
      } catch {}
    }
  }

  if (!listeners.size) {
    const netstat = whichSync('netstat');
    if (netstat) {
      try {
        const { stdout } = await exec(netstat, ['-ltn'], { maxBuffer: 4 * 1024 * 1024 });
        for (const line of stdout.split('\n')) {
          const fields = line.trim().split(/\s+/);
          if (fields[0] !== 'tcp' && fields[0] !== 'tcp6') continue;
          const local = fields[3] || '';
          const match = local.match(/:(\d+)$/);
          if (!match) continue;
          const port = Number(match[1]);
          listeners.set(port, { port, address: local.slice(0, -match[0].length) || '*', pid: null, command: '' });
        }
      } catch {}
    }
  }

  return listeners;
}

async function listPortsWindows() {
  const listeners = new Map();
  const netstat = whichSync('netstat') || 'netstat.exe';
  let names = new Map();

  const tasklist = whichSync('tasklist');
  if (tasklist) {
    try {
      const { stdout } = await exec(tasklist, ['/FO', 'CSV', '/NH'], { maxBuffer: 4 * 1024 * 1024 });
      for (const line of stdout.split('\n')) {
        const match = line.match(/^"([^"]+)","(\d+)"/);
        if (match) names.set(Number(match[2]), match[1].replace(/\.exe$/i, ''));
      }
    } catch {}
  }

  try {
    const { stdout } = await exec(netstat, ['-ano', '-p', 'tcp'], { maxBuffer: 4 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
      const local = fields[1] || '';
      const match = local.match(/:(\d+)$/);
      if (!match) continue;
      const port = Number(match[1]);
      const pid = Number(fields[4]);
      if (!Number.isInteger(port) || port <= 0) continue;
      listeners.set(port, {
        port,
        address: local.slice(0, -match[0].length) || '*',
        pid: Number.isInteger(pid) && pid > 0 ? pid : null,
        command: names.get(pid) || '',
      });
    }
  } catch {}

  return listeners;
}

export async function listPorts() {
  let listeners;
  if (IS_WIN) listeners = await listPortsWindows();
  else if (IS_MAC) listeners = await listPortsMac();
  else listeners = await listPortsLinux();

  return [...listeners.values()]
    .map((row) => ({
      ...row,
      command: row.command || KNOWN_PORTS[row.port] || (row.pid ? '(unknown)' : '(system)'),
      address: row.address || '*',
    }))
    .sort((a, b) => a.port - b.port);
}

export async function killPid(pid) {
  return killProcess(pid);
}

// ---------------------------------------------------------------- compression

export function classify(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return null;
}

export function compressionBackend() {
  if (IS_MAC && fs.existsSync('/usr/bin/sips') && fs.existsSync('/usr/bin/avconvert')) return 'macos';
  if (whichSync('ffmpeg')) return 'ffmpeg';
  return 'none';
}

export function compressionHint() {
  if (compressionBackend() === 'macos') return 'pakai sips + avconvert bawaan macOS';
  if (compressionBackend() === 'ffmpeg') return 'pakai ffmpeg';
  return IS_WIN
    ? 'butuh ffmpeg — install: winget install Gyan.FFmpeg'
    : 'butuh ffmpeg — install: brew install ffmpeg / sudo apt install ffmpeg';
}

function uniqueOutput(baseName, ext, outDir) {
  const stamp = Date.now().toString(36);
  return path.join(outDir, `${baseName}-min-${stamp}${ext}`);
}

function ffmpegArgsImage(input, output, { quality, maxDim, keepFormat }) {
  const inputExt = path.extname(input).toLowerCase();
  const keepable = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const ext = keepFormat && keepable.has(inputExt) ? inputExt : '.jpg';
  const args = ['-y', '-i', input, '-vf', `scale='min(${maxDim},iw)':-2`];

  if (ext === '.jpg' || ext === '.jpeg') {
    const qscale = Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29)));
    args.push('-q:v', String(qscale));
  } else if (ext === '.webp') {
    args.push('-quality', String(quality));
  } else if (ext === '.png') {
    args.push('-compression_level', '9');
  }

  args.push('-frames:v', '1', output);
  return { args, ext };
}

export async function compressMedia(input, opts = {}) {
  const kind = classify(input);
  if (!kind) throw new Error(`Format tidak didukung: ${path.extname(input) || input}`);

  const backend = compressionBackend();
  if (backend === 'none') throw new Error(`Kompresi butuh ffmpeg di ${platformLabel()}. ${compressionHint()}`);

  const cfg = await loadConfig();
  const outDir = opts.outputDir || cfg.outputDir || OUTPUT_DIR;
  await fsp.mkdir(outDir, { recursive: true });

  const before = (await fsp.stat(input)).size;
  const base = path.basename(input, path.extname(input));
  const quality = Math.min(100, Math.max(1, Number(opts.quality ?? cfg.image.quality ?? 75)));
  const maxDim = Math.max(320, Number(opts.maxDim ?? cfg.image.maxDim ?? 1920));
  const keepFormat = Boolean(opts.keepFormat);

  let output;
  if (kind === 'image') {
    if (backend === 'macos') {
      const ext = keepFormat ? path.extname(input).toLowerCase() : '.jpg';
      output = uniqueOutput(base, ext, outDir);
      const args = ['-Z', String(maxDim)];
      if (!keepFormat) args.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality));
      args.push(input, '--out', output);
      await exec('/usr/bin/sips', args, { maxBuffer: 1024 * 1024 });
    } else {
      const ffmpeg = whichSync('ffmpeg');
      const inputExt = path.extname(input).toLowerCase();
      const keepable = new Set(['.jpg', '.jpeg', '.png', '.webp']);
      const ext = keepFormat && keepable.has(inputExt) ? inputExt : '.jpg';
      output = uniqueOutput(base, ext, outDir);
      const { args } = ffmpegArgsImage(input, output, { quality, maxDim, keepFormat });
      await exec(ffmpeg, args, { maxBuffer: 8 * 1024 * 1024 });
    }
  } else if (kind === 'video') {
    const presetKey = opts.preset || cfg.video.preset || '1080p';
    const preset = VIDEO_PRESETS[presetKey] || VIDEO_PRESETS['1080p'];
    output = uniqueOutput(base, '.mp4', outDir);
    if (backend === 'macos') {
      await exec('/usr/bin/avconvert', ['--source', input, '--preset', preset.mac, '--output', output, '--replace'], {
        maxBuffer: 8 * 1024 * 1024,
      });
    } else {
      const ffmpeg = whichSync('ffmpeg');
      await exec(ffmpeg, [
        '-y', '-i', input,
        '-vf', `scale=-2:'min(${preset.height},ih)'`,
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        output,
      ], { maxBuffer: 16 * 1024 * 1024 });
    }
  } else {
    output = uniqueOutput(base, '.m4a', outDir);
    if (backend === 'macos') {
      await exec('/usr/bin/avconvert', ['--source', input, '--preset', 'PresetAppleM4A', '--output', output, '--replace'], {
        maxBuffer: 8 * 1024 * 1024,
      });
    } else {
      const ffmpeg = whichSync('ffmpeg');
      await exec(ffmpeg, ['-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '128k', output], {
        maxBuffer: 8 * 1024 * 1024,
      });
    }
  }

  const after = (await fsp.stat(output)).size;
  if (after >= before) {
    const originalExt = path.extname(input).toLowerCase() || path.extname(output);
    const fallback = uniqueOutput(base, originalExt, outDir);
    await fsp.copyFile(input, fallback);
    if (fallback !== output) await fsp.rm(output, { force: true });
    const size = (await fsp.stat(fallback)).size;
    return {
      input,
      output: fallback,
      name: path.basename(fallback),
      kind,
      before,
      after: size,
      saved: 0,
      savedPct: 0,
      backend,
      note: 'Sudah optimal — file asli dipertahankan',
    };
  }

  return {
    input,
    output,
    name: path.basename(output),
    kind,
    before,
    after,
    saved: before - after,
    savedPct: before > 0 ? Number((((before - after) / before) * 100).toFixed(1)) : 0,
    backend,
  };
}

// ---------------------------------------------------------------- git

function gitBin() {
  return whichSync('git') || 'git';
}

async function git(dir, args) {
  const { stdout } = await exec(gitBin(), ['-C', dir, ...args], {
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: pathWithExtras() },
  });
  return stdout.trim();
}

export async function gitInfo(dir) {
  try {
    const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const statusRaw = await git(dir, ['status', '--porcelain=v1', '-b']);
    const lines = statusRaw.split('\n').filter(Boolean);
    const header = lines[0] || '';
    const files = lines.slice(1).map((line) => ({ status: line.slice(0, 2), file: line.slice(3) }));
    const lastCommit = await git(dir, ['log', '-1', '--format=%h|%s|%an|%ar']);
    const ahead = header.match(/ahead (\d+)/)?.[1] || '0';
    const behind = header.match(/behind (\d+)/)?.[1] || '0';
    const upstream = header.match(/\.\.\.(\S+)/)?.[1] || '';
    const [hash, subject, author, when] = lastCommit.split('|');
    return { ok: true, branch, ahead: Number(ahead), behind: Number(behind), upstream, files, last: { hash, subject, author, when } };
  } catch (error) {
    return { ok: false, error: error.stderr?.trim() || error.message };
  }
}

export async function gitAction(dir, action, message) {
  if (action === 'pull') return git(dir, ['pull', '--ff-only']);
  if (action === 'push') return git(dir, ['push']);
  if (action === 'commit') {
    if (!message || !message.trim()) throw new Error('Pesan commit wajib diisi');
    await git(dir, ['add', '-A']);
    return git(dir, ['commit', '-m', message.trim()]);
  }
  throw new Error(`Aksi tidak dikenal: ${action}`);
}

// ---------------------------------------------------------------- services

export async function getServices(cfg) {
  const services = Array.isArray(cfg.services) ? cfg.services : [];

  return Promise.all(services.map(async (svc) => {
    let running = false;
    if (svc.url) {
      try {
        const res = await fetch(svc.url, { signal: AbortSignal.timeout(3000) });
        running = res.status < 500;
      } catch {}
    } else if (svc.port) {
      running = await portOpen(Number(svc.port));
    }

    return {
      id: svc.id,
      label: svc.label || svc.id,
      port: svc.port ?? null,
      url: svc.url || null,
      running,
      controllable: Boolean(svc.start || svc.stop),
      canStart: Boolean(svc.start),
      canStop: Boolean(svc.stop),
    };
  }));
}

async function runConfigured(command, timeout = 120000) {
  const env = { ...process.env, PATH: pathWithExtras() };
  if (Array.isArray(command)) {
    const [file, ...args] = command;
    if (!file) throw new Error('Perintah layanan kosong');
    const { stdout } = await exec(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, env });
    return stdout.trim();
  }
  const { stdout } = await execShell(String(command), { timeout });
  return stdout.trim();
}

export async function controlService(cfg, id, action) {
  const services = Array.isArray(cfg.services) ? cfg.services : [];
  const svc = services.find((s) => s.id === id);
  if (!svc) throw new Error(`Service tidak dikenal: ${id}`);

  const command = action === 'start' ? svc.start : svc.stop;
  if (!command) throw new Error(`${svc.label || id} tidak punya perintah ${action}`);
  const output = await runConfigured(command);
  return output || `${svc.label || id} ${action}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}
