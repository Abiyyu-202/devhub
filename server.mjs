#!/usr/bin/env node
// DevHub local server
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OUTPUT_DIR, LOG_DIR, TMP_DIR, DOWNLOAD_DIR,
  ensureDirs, loadConfig, saveConfig, loadTasks, saveTasks,
  mergedTasks, findTask, detectProject, listPorts, killPid,
  compressMedia, gitInfo, gitAction, getServices, controlService,
  which, hashId, logName,
} from './lib/lib.mjs';
import { spawnShell, openTarget, diskUsage, platformLabel, IS_WIN } from './lib/platform.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const running = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body terlalu besar');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buffer = await readBody(req);
  if (!buffer.length) return {};
  return JSON.parse(buffer.toString('utf8'));
}

function stamp() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

function startTask(task) {
  if (running.has(task.id)) return running.get(task.id);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, logName(task.id));
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  log.write(`\n[${new Date().toISOString()}] $ ${task.command}  (cwd: ${task.path})\n`);

  const spec = spawnShell(task.command, {
    cwd: task.path,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const child = spawn(spec.file, spec.args, spec.options);
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code, signal) => {
    log.write(`\n[${stamp()}] proses berhenti (code ${code ?? '-'}${signal ? `, ${signal}` : ''})\n`);
    log.end();
    running.delete(task.id);
  });
  child.on('error', (error) => {
    log.write(`\n[${stamp()}] gagal start: ${error.message}\n`);
    log.end();
    running.delete(task.id);
  });

  const record = { pid: child.pid, logPath, startedAt: Date.now(), port: task.port, command: task.command };
  running.set(task.id, record);
  return record;
}

function stopTask(id) {
  const record = running.get(id);
  if (!record) return false;
  if (IS_WIN) {
    spawn('taskkill', ['/PID', String(record.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-record.pid, 'SIGTERM'); } catch { try { process.kill(record.pid, 'SIGTERM'); } catch {} }
    setTimeout(() => {
      try { process.kill(-record.pid, 'SIGKILL'); } catch {}
    }, 2500).unref();
  }
  running.delete(id);
  return true;
}

async function tailLog(file, lines = 200) {
  try {
    const stat = await fsp.stat(file);
    const readSize = Math.min(stat.size, 200 * 1024);
    const handle = await fsp.open(file, 'r');
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, Math.max(0, stat.size - readSize));
    await handle.close();
    return buffer.toString('utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

async function systemInfo() {
  const disk = await diskUsage();

  let projects = 0;
  try {
    const cfg = await loadConfig();
    projects = (await mergedTasks(cfg)).length;
  } catch {}

  return {
    hostname: os.hostname(),
    platform: `${platformLabel()} ${os.release()}`,
    uptime: process.uptime(),
    load: os.loadavg().map((n) => Number(n.toFixed(2))),
    memory: { total: os.totalmem(), free: os.freemem() },
    disk,
    projects,
    node: process.version,
  };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/ping' && method === 'GET') {
    return json(res, 200, { ok: true, pid: process.pid });
  }

  if (pathname === '/api/status' && method === 'GET') {
    const cfg = await loadConfig();
    const [services, ports, sys] = await Promise.all([getServices(cfg), listPorts().catch(() => []), systemInfo()]);
    return json(res, 200, {
      services,
      ports: ports.length,
      running: [...running.entries()].map(([id, r]) => ({ id, ...r })),
      system: sys,
    });
  }

  if (pathname === '/api/system' && method === 'GET') {
    return json(res, 200, await systemInfo());
  }

  if (pathname === '/api/config') {
    if (method === 'GET') return json(res, 200, await loadConfig());
    if (method === 'POST') {
      const patch = await readJsonBody(req);
      return json(res, 200, await saveConfig(patch));
    }
  }

  if (pathname === '/api/tasks' && method === 'GET') {
    const cfg = await loadConfig();
    const tasks = await mergedTasks(cfg);
    return json(res, 200, tasks.map((task) => ({
      ...task,
      running: running.has(task.id) ? running.get(task.id) : null,
    })));
  }

  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.name || !body.path) return json(res, 400, { error: 'name dan path wajib diisi' });
    if (!fs.existsSync(body.path)) return json(res, 400, { error: 'Path tidak ditemukan' });
    const manual = await loadTasks();
    const task = {
      id: `m:${hashId(body.path + body.name + Date.now())}`,
      name: String(body.name).trim(),
      path: path.resolve(body.path),
      command: String(body.command || detectProject(body.path).command || '').trim(),
      port: body.port ? Number(body.port) : detectProject(body.path).port,
      type: body.type || 'manual',
      source: 'manual',
      createdAt: new Date().toISOString(),
    };
    manual.push(task);
    await saveTasks(manual);
    return json(res, 201, task);
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(run|stop|log))?$/);
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]);
    const action = taskMatch[2];
    const cfg = await loadConfig();

    if (!action && method === 'DELETE') {
      const manual = await loadTasks();
      const next = manual.filter((t) => t.id !== id);
      await saveTasks(next);
      stopTask(id);
      return json(res, 200, { ok: true });
    }

    if (!action && (method === 'PATCH' || method === 'PUT')) {
      const body = await readJsonBody(req);
      const manual = await loadTasks();
      const index = manual.findIndex((t) => t.id === id);
      if (index === -1) return json(res, 404, { error: 'Tugas manual tidak ditemukan' });
      manual[index] = { ...manual[index], ...body, id: manual[index].id, source: 'manual' };
      await saveTasks(manual);
      return json(res, 200, manual[index]);
    }

    if (action === 'run' && method === 'POST') {
      const task = await findTask(id, cfg);
      if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan' });
      const record = startTask(task);
      return json(res, 200, { ok: true, ...record });
    }

    if (action === 'stop' && method === 'POST') {
      const ok = stopTask(id);
      return json(res, 200, { ok });
    }

    if (action === 'log' && method === 'GET') {
      const record = running.get(id);
      const logPath = record?.logPath || path.join(LOG_DIR, logName(id));
      return json(res, 200, { log: await tailLog(logPath, 300) });
    }
  }

  if (pathname === '/api/ports' && method === 'GET') {
    return json(res, 200, await listPorts());
  }

  if (pathname === '/api/ports/kill' && method === 'POST') {
    const { pid } = await readJsonBody(req);
    try {
      await killPid(pid);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/services' && method === 'POST') {
    const { name, action } = await readJsonBody(req);
    try {
      const cfg = await loadConfig();
      const output = await controlService(cfg, name, action);
      return json(res, 200, { ok: true, output: String(output || '') });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/git' && method === 'GET') {
    const dir = searchParams.get('path');
    if (!dir) return json(res, 400, { error: 'path wajib' });
    return json(res, 200, await gitInfo(dir));
  }

  if (pathname === '/api/git' && method === 'POST') {
    const { path: dir, action, message } = await readJsonBody(req);
    try {
      const output = await gitAction(dir, action, message);
      return json(res, 200, { ok: true, output });
    } catch (error) {
      return json(res, 400, { error: error.stderr?.trim() || error.message });
    }
  }

  if (pathname === '/api/compress' && method === 'POST') {
    try {
      const request = new Request('http://localhost/api/compress', {
        method: 'POST',
        headers: req.headers,
        body: req,
        duplex: 'half',
      });
      const form = await request.formData();
      const files = form.getAll('files').filter((f) => typeof f === 'object' && 'arrayBuffer' in f);
      if (!files.length) return json(res, 400, { error: 'Tidak ada file' });

      const opts = {
        quality: Number(form.get('quality') || 75),
        maxDim: Number(form.get('maxDim') || 1920),
        preset: String(form.get('preset') || '1080p'),
        keepFormat: form.get('keepFormat') === 'true',
      };

      const results = [];
      for (const file of files) {
        const ext = path.extname(file.name || '') || '.bin';
        const temp = path.join(TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
        await fsp.mkdir(TMP_DIR, { recursive: true });
        await fsp.writeFile(temp, Buffer.from(await file.arrayBuffer()));
        try {
          const result = await compressMedia(temp, opts);
          const outName = `${path.basename(file.name || 'file', ext)}-min${path.extname(result.output)}`;
          const finalPath = path.join(OUTPUT_DIR, outName);
          await fsp.rename(result.output, finalPath);
          result.output = finalPath;
          result.name = outName;
          result.originalName = file.name;
          result.url = `/files/${encodeURIComponent(outName)}`;
          results.push(result);
        } catch (error) {
          results.push({ input: file.name, error: error.message });
        } finally {
          await fsp.rm(temp, { force: true });
        }
      }
      return json(res, 200, { results });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/compress/path' && method === 'POST') {
    const { paths = [], quality, maxDim, preset, keepFormat } = await readJsonBody(req);
    const results = [];
    for (const input of paths) {
      try {
        const result = await compressMedia(input, { quality, maxDim, preset, keepFormat });
        result.url = `/files/${encodeURIComponent(path.basename(result.output))}`;
        results.push(result);
      } catch (error) {
        results.push({ input, error: error.message });
      }
    }
    return json(res, 200, { results });
  }

  if (pathname === '/api/download' && method === 'POST') {
    const { url: target, mode = 'video' } = await readJsonBody(req);
    if (!/^https?:\/\//i.test(target || '')) return json(res, 400, { error: 'URL tidak valid' });

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, 'download.log');
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const ytdlp = await which('yt-dlp');
    let args, bin;

    if (ytdlp) {
      bin = ytdlp;
      args = ['-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s')];
      if (mode === 'audio') args.push('-x', '--audio-format', 'mp3');
      args.push(target);
    } else if (mode === 'file' || /\.(mp4|mkv|mp3|m4a|zip|pdf|jpg|jpeg|png|dmg|iso|exe|msi)(\?.*)?$/i.test(target)) {
      const curl = await which('curl');
      if (!curl) {
        log.end();
        return json(res, 400, { error: 'curl tidak ditemukan di sistem ini' });
      }
      bin = curl;
      args = ['-L', '--progress-bar', '-o', path.join(DOWNLOAD_DIR, decodeURIComponent(path.basename(new URL(target).pathname)) || `download-${Date.now()}`), target];
    } else {
      log.end();
      return json(res, 400, {
        error: 'yt-dlp belum terpasang. Jalankan: python3 -m pip install --user yt-dlp (atau brew install yt-dlp)',
      });
    }

    log.write(`\n[${new Date().toISOString()}] $ ${bin} ${args.join(' ')}\n`);
    const child = spawn(bin, args, { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('exit', (code) => log.write(`\n[${stamp()}] selesai (code ${code})\n`));
    child.unref();

    return json(res, 200, { ok: true, tool: bin, pid: child.pid, logPath });
  }

  if (pathname === '/api/download/log' && method === 'GET') {
    return json(res, 200, { log: await tailLog(path.join(LOG_DIR, 'download.log'), 120) });
  }

  if (pathname === '/api/reveal' && method === 'POST') {
    const { path: target } = await readJsonBody(req);
    if (!target || !fs.existsSync(target)) return json(res, 400, { error: 'Path tidak ditemukan' });
    openTarget(target);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'Endpoint tidak ditemukan' });
}

async function serveStatic(req, res, url) {
  if (url.pathname.startsWith('/files/')) {
    const name = decodeURIComponent(url.pathname.slice('/files/'.length));
    const safe = path.basename(name);
    const file = path.join(OUTPUT_DIR, safe);
    if (!file.startsWith(OUTPUT_DIR) || !fs.existsSync(file)) return json(res, 404, { error: 'File tidak ditemukan' });
    const stat = await fsp.stat(file);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="${safe.replace(/"/g, '')}"`,
    });
    return fs.createReadStream(file).pipe(res);
  }

  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return json(res, 404, { error: 'Tidak ditemukan' });
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(`[devhub] ${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) return json(res, 500, { error: error.message });
    res.end();
  }
});

const config = await loadConfig();
const port = Number(process.env.DEVHUB_PORT || config.port || 7070);

await ensureDirs();

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  DevHub  →  http://127.0.0.1:${port}\n`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} sudah dipakai. Set DEVHUB_PORT atau ubah ~/.config/devhub/config.json`);
    process.exit(1);
  }
  throw error;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const [id] of running) stopTask(id);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
