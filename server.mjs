#!/usr/bin/env node
// DevHub local server
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  OUTPUT_DIR, LOG_DIR, TMP_DIR, DOWNLOAD_DIR,
  ensureDirs, loadConfig, saveConfig, loadTasks, saveTasks,
  mergedTasks, findTask, detectProject, listPorts, killPid,
  compressMedia, gitInfo, gitAction, getServices, controlService,
  which, hashId, logName, slugify,
} from './lib/lib.mjs';
import { spawnShell, openTarget, diskUsage, platformLabel, IS_WIN } from './lib/platform.mjs';
import { isLoopback, isLoopbackHost, authorized, lanAddresses, maskToken } from './lib/lan.mjs';
import { detectActions, findAction } from './lib/actions.mjs';
import { gitBranches, gitHistory, gitDiff, gitStashList, gitV2 } from './lib/gitx.mjs';
import { scanCleanup, deleteCleanup, CLEANUP_NAMES } from './lib/cleanup.mjs';
import { createBackup, listBackups, restoreBackup, deleteBackup, configuredTargets, backupDir } from './lib/backup.mjs';
import { detectAiTools, resolveAi } from './lib/ai.mjs';
import { createSplitSession, openTerminal, splitSessionName, tmuxAvailable, splitHint } from './lib/split.mjs';
import { validateConfigPatch } from './lib/configx.mjs';
import { createJob, listJobs, getJob, cancelJob, subscribe } from './lib/jobs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const running = new Map();
const actionRuns = new Map();

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

function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
  }, 2000).unref();
}

// ---------------------------------------------------------------- project actions

function startActionRun(task, action) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const id = `a-${crypto.randomBytes(6).toString('hex')}`;
  const logPath = path.join(LOG_DIR, `action-${slugify(task.name)}-${Date.now()}.log`);
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  log.write(`\n[${new Date().toISOString()}] $ ${action.command}  (cwd: ${task.path})\n`);

  const spec = spawnShell(action.command, {
    cwd: task.path,
    detached: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  });
  const child = spawn(spec.file, spec.args, spec.options);
  child.stdout.pipe(log);
  child.stderr.pipe(log);

  const record = {
    id,
    pid: child.pid,
    logPath,
    command: action.command,
    label: action.label,
    taskId: task.id,
    taskName: task.name,
    startedAt: Date.now(),
    running: true,
  };
  actionRuns.set(id, record);

  const finish = (code, signal) => {
    log.write(`\n[${stamp()}] proses berhenti (code ${code ?? '-'}${signal ? `, ${signal}` : ''})\n`);
    log.end();
    record.running = false;
    record.finishedAt = Date.now();
  };
  child.on('exit', finish);
  child.on('error', (error) => {
    log.write(`\n[${stamp()}] gagal start: ${error.message}\n`);
    log.end();
    record.running = false;
    record.error = error.message;
  });

  const finished = [...actionRuns.values()].filter((item) => !item.running).sort((a, b) => b.startedAt - a.startedAt);
  for (const old of finished.slice(20)) actionRuns.delete(old.id);
  return record;
}

function stopActionRun(id) {
  const record = actionRuns.get(id);
  if (!record || !record.running) return false;
  killTree(record.pid);
  record.running = false;
  record.finishedAt = Date.now();
  return true;
}

// ---------------------------------------------------------------- background jobs

function downloadJob(url, mode) {
  return createJob({
    type: 'download',
    label: `Download ${mode} · ${url.replace(/^https?:\/\//, '').slice(0, 70)}`,
    run: async ({ progress, signal }) => {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const logPath = path.join(LOG_DIR, 'download.log');
      const log = fs.createWriteStream(logPath, { flags: 'a' });
      const ytdlp = await which('yt-dlp');
      let bin;
      let args;

      const directFile = mode === 'file' || /\.(mp4|mkv|mp3|m4a|zip|pdf|jpg|jpeg|png|dmg|iso|exe|msi)(\?.*)?$/i.test(url);
      const curl = directFile ? await which('curl') : null;
      if (curl) {
        bin = curl;
        const name = decodeURIComponent(path.basename(new URL(url).pathname)) || `download-${Date.now()}`;
        args = ['-L', '--progress-bar', '-o', path.join(DOWNLOAD_DIR, name), url];
      } else if (ytdlp) {
        bin = ytdlp;
        args = ['-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s')];
        if (mode === 'audio') args.push('-x', '--audio-format', 'mp3');
        args.push('--newline', url);
      } else {
        throw new Error('yt-dlp belum terpasang. Jalankan: python3 -m pip install --user yt-dlp');
      }

      log.write(`\n[${new Date().toISOString()}] $ ${bin} ${args.join(' ')}\n`);
      progress(3, `Memulai ${path.basename(bin)}…`);
      const child = spawn(bin, args, {
        detached: !IS_WIN,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let lastPercent = 0;
      const onLine = (line) => {
        const text = String(line);
        log.write(text.endsWith('\n') ? text : `${text}\n`);
        const match = text.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (match) {
          const percent = Math.min(99, Number(match[1]));
          if (percent > lastPercent + 0.4) {
            lastPercent = percent;
            progress(Math.max(5, percent), `Mengunduh… ${percent.toFixed(1)}%`);
          }
        }
      };
      let stdoutBuffer = '';
      let stderrBuffer = '';
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) onLine(line);
      });
      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split('\n');
        stderrBuffer = lines.pop() || '';
        for (const line of lines) onLine(line);
      });

      const onAbort = () => killTree(child.pid);
      signal.addEventListener('abort', onAbort, { once: true });

      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      signal.removeEventListener('abort', onAbort);
      if (stdoutBuffer) onLine(stdoutBuffer);
      if (stderrBuffer) onLine(stderrBuffer);
      log.write(`\n[${stamp()}] selesai (code ${code})\n`);
      log.end();
      if (signal.aborted) throw new Error('Dibatalkan');
      if (code !== 0) throw new Error(`${path.basename(bin)} gagal (code ${code}) — cek log download`);
      return { logPath, tool: path.basename(bin), pid: child.pid };
    },
  });
}

function compressJob(paths, opts) {
  return createJob({
    type: 'compress',
    label: `Kompres ${paths.length} file`,
    run: async ({ progress, signal }) => {
      const results = [];
      for (let index = 0; index < paths.length; index += 1) {
        if (signal.aborted) throw new Error('Dibatalkan');
        const input = paths[index];
        progress(Math.round((index / paths.length) * 100), `Memproses ${path.basename(input)}…`);
        try {
          const result = await compressMedia(input, opts);
          result.url = `/files/${encodeURIComponent(path.basename(result.output))}`;
          results.push(result);
        } catch (error) {
          results.push({ input, error: error.message });
        }
      }
      return { results };
    },
  });
}

async function allBackupTargets(cfg) {
  const configured = configuredTargets(cfg);
  const tasks = await mergedTasks(cfg);
  const seen = new Set(configured.map((target) => path.resolve(target.path)));
  const extras = tasks
    .filter((task) => !seen.has(path.resolve(task.path)))
    .map((task) => ({ id: `task:${task.id}`, label: task.name, path: task.path, database: null, configured: false }));
  return [...configured, ...extras];
}

async function proxyHttp({ method, url: target, headers, body, timeout }) {
  const allowed = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const verb = String(method || 'GET').toUpperCase();
  if (!allowed.includes(verb)) throw new Error('Method tidak didukung');
  if (!/^https?:\/\//i.test(String(target || ''))) throw new Error('URL harus http:// atau https://');
  const controller = new AbortController();
  const ms = Math.max(500, Math.min(30000, Number(timeout) || 15000));
  const timer = setTimeout(() => controller.abort(), ms);
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method: verb,
      headers: headers && typeof headers === 'object' ? headers : {},
      body: ['GET', 'HEAD'].includes(verb) ? undefined : (body || undefined),
      signal: controller.signal,
      redirect: 'follow',
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          chunks.push(value.slice(0, Math.max(0, 1024 * 1024 - (size - value.length))));
          break;
        }
        chunks.push(value);
      }
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const text = buffer.toString('utf8');
    const responseHeaders = {};
    for (const [key, value] of response.headers.entries()) responseHeaders[key] = value;
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body: text,
      truncated: size > 1024 * 1024,
      duration: Date.now() - started,
      size: buffer.length,
    };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Timeout setelah ${ms} ms`);
    throw error;
  } finally {
    clearTimeout(timer);
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

  if (pathname === '/api/jobs/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const send = (snapshot) => {
      try { res.write(`event: jobs\ndata: ${JSON.stringify(snapshot)}\n\n`); } catch {}
    };
    send(listJobs());
    const unsubscribe = subscribe(send);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

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
      try {
        const current = await loadConfig();
        const clean = validateConfigPatch(patch, current);
        return json(res, 200, await saveConfig(clean));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
    }
  }

  if (pathname === '/api/lan' && method === 'GET') {
    const cfg = await loadConfig();
    return json(res, 200, {
      enabled: !isLoopbackHost(cfg.host),
      host: cfg.host || '127.0.0.1',
      port: cfg.port || 7070,
      token: cfg.accessToken ? maskToken(cfg.accessToken) : '',
      addresses: lanAddresses(),
    });
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

  if (pathname === '/api/git/branches' && method === 'GET') {
    const dir = searchParams.get('path');
    if (!dir) return json(res, 400, { error: 'path wajib' });
    try { return json(res, 200, await gitBranches(dir)); }
    catch (error) { return json(res, 400, { error: error.stderr?.trim() || error.message }); }
  }

  if (pathname === '/api/git/history' && method === 'GET') {
    const dir = searchParams.get('path');
    if (!dir) return json(res, 400, { error: 'path wajib' });
    try { return json(res, 200, { commits: await gitHistory(dir, searchParams.get('limit') || 25) }); }
    catch (error) { return json(res, 400, { error: error.stderr?.trim() || error.message }); }
  }

  if (pathname === '/api/git/diff' && method === 'GET') {
    const dir = searchParams.get('path');
    if (!dir) return json(res, 400, { error: 'path wajib' });
    try {
      const diff = await gitDiff(dir, searchParams.get('file') || '', searchParams.get('staged') === '1');
      return json(res, 200, { diff });
    } catch (error) { return json(res, 400, { error: error.stderr?.trim() || error.message }); }
  }

  if (pathname === '/api/git/stash' && method === 'GET') {
    const dir = searchParams.get('path');
    if (!dir) return json(res, 400, { error: 'path wajib' });
    try { return json(res, 200, { stashes: await gitStashList(dir) }); }
    catch (error) { return json(res, 400, { error: error.stderr?.trim() || error.message }); }
  }

  if (pathname === '/api/git/v2' && method === 'POST') {
    const { path: dir, action, ...payload } = await readJsonBody(req);
    if (!dir) return json(res, 400, { error: 'path wajib' });
    try {
      const output = await gitV2(dir, action, payload);
      return json(res, 200, { ok: true, output });
    } catch (error) {
      return json(res, 400, { error: error.stderr?.trim() || error.message });
    }
  }

  if (pathname === '/api/actions' && method === 'GET') {
    const taskId = searchParams.get('task');
    if (!taskId) return json(res, 400, { error: 'task wajib' });
    const cfg = await loadConfig();
    const task = await findTask(taskId, cfg);
    if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan' });
    return json(res, 200, {
      task: { id: task.id, name: task.name, path: task.path, command: task.command },
      actions: detectActions(task),
    });
  }

  if (pathname === '/api/actions/run' && method === 'POST') {
    const { taskId, actionId } = await readJsonBody(req);
    const cfg = await loadConfig();
    const task = await findTask(taskId, cfg);
    if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan' });
    const action = findAction(task, actionId);
    if (!action) return json(res, 400, { error: 'Aksi tidak dikenal untuk project ini' });
    const record = startActionRun(task, action);
    return json(res, 200, {
      ok: true,
      id: record.id,
      pid: record.pid,
      label: record.label,
      command: record.command,
      startedAt: record.startedAt,
    });
  }

  if (pathname === '/api/actions/log' && method === 'GET') {
    const id = searchParams.get('id');
    const record = actionRuns.get(String(id || ''));
    if (!record) return json(res, 404, { error: 'Aksi tidak ditemukan' });
    return json(res, 200, {
      id: record.id,
      running: record.running,
      label: record.label,
      command: record.command,
      taskName: record.taskName,
      log: await tailLog(record.logPath, 400),
    });
  }

  if (pathname === '/api/actions/stop' && method === 'POST') {
    const { id } = await readJsonBody(req);
    return json(res, 200, { ok: stopActionRun(id) });
  }

  if (pathname === '/api/jobs' && method === 'GET') {
    return json(res, 200, { jobs: listJobs() });
  }

  const jobCancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (jobCancelMatch && method === 'POST') {
    return json(res, 200, { ok: cancelJob(decodeURIComponent(jobCancelMatch[1])) });
  }

  if (pathname === '/api/jobs/compress' && method === 'POST') {
    const { paths = [], quality, maxDim, preset, keepFormat } = await readJsonBody(req);
    if (!Array.isArray(paths) || !paths.length) return json(res, 400, { error: 'paths wajib diisi' });
    const job = compressJob(paths.map(String), { quality, maxDim, preset, keepFormat });
    return json(res, 202, { ok: true, job });
  }

  if (pathname === '/api/cleanup/scan' && method === 'GET') {
    const cfg = await loadConfig();
    try {
      return json(res, 200, await scanCleanup(cfg));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/cleanup/delete' && method === 'POST') {
    const { paths = [] } = await readJsonBody(req);
    if (!Array.isArray(paths) || !paths.length) return json(res, 400, { error: 'paths wajib diisi' });
    const cfg = await loadConfig();
    try {
      return json(res, 200, await deleteCleanup(cfg, paths));
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/backups' && method === 'GET') {
    const cfg = await loadConfig();
    const targets = await allBackupTargets(cfg);
    return json(res, 200, {
      backups: await listBackups(cfg),
      dir: backupDir(cfg),
      targets: targets.map((target) => ({
        id: target.id,
        label: target.label,
        path: target.path,
        configured: Boolean(target.configured),
        database: target.database?.name || null,
      })),
    });
  }

  if (pathname === '/api/backups' && method === 'POST') {
    const { targetId } = await readJsonBody(req);
    const cfg = await loadConfig();
    const targets = await allBackupTargets(cfg);
    const target = targets.find((item) => item.id === targetId);
    if (!target) return json(res, 404, { error: 'Target backup tidak ditemukan' });
    const job = createJob({
      type: 'backup',
      label: `Backup ${target.label}`,
      run: async ({ progress }) => {
        const result = await createBackup(cfg, target, { onProgress: progress });
        return { file: result.file, size: result.size, database: result.meta.database?.name || null };
      },
    });
    return json(res, 202, { ok: true, job });
  }

  if (pathname === '/api/backups/restore' && method === 'POST') {
    const { file, confirm, mode, withDatabase } = await readJsonBody(req);
    const cfg = await loadConfig();
    const targets = await allBackupTargets(cfg);
    const job = createJob({
      type: 'restore',
      label: `Restore ${path.basename(String(file || 'backup'))}`,
      run: async ({ progress }) => restoreBackup(cfg, targets, file, {
        confirm,
        mode: mode === 'overwrite' ? 'overwrite' : 'new',
        withDatabase: withDatabase !== false,
        onProgress: progress,
      }),
    });
    return json(res, 202, { ok: true, job });
  }

  if (pathname === '/api/backups' && method === 'DELETE') {
    const file = searchParams.get('file');
    const cfg = await loadConfig();
    try {
      await deleteBackup(cfg, file);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/ai' && method === 'GET') {
    const cfg = await loadConfig();
    const tasks = await mergedTasks(cfg);
    const tmux = await tmuxAvailable();
    return json(res, 200, {
      tasks: tasks.map((task) => ({ id: task.id, name: task.name, path: task.path, command: task.command })),
      tools: await detectAiTools(),
      tmux: Boolean(tmux),
      hint: splitHint(),
    });
  }

  if (pathname === '/api/ai/launch' && method === 'POST') {
    const { taskId, ai: aiKey, open } = await readJsonBody(req);
    const cfg = await loadConfig();
    const task = await findTask(taskId, cfg);
    if (!task) return json(res, 404, { error: 'Tugas tidak ditemukan' });
    const ai = await resolveAi(aiKey);
    if (!ai) return json(res, 400, { error: 'AI tidak dikenal' });
    if (!ai.installed) return json(res, 400, { error: `${ai.label} belum terpasang`, hint: ai.install });
    const tmux = await tmuxAvailable();
    if (!tmux) return json(res, 400, { error: 'tmux belum terpasang', hint: splitHint() });
    try {
      const result = createSplitSession(tmux, task, ai);
      let terminal = null;
      let terminalError = null;
      if (open !== false) {
        try {
          terminal = (await openTerminal(result.session, { tmux })).terminal;
        } catch (error) {
          terminalError = error.message;
        }
      }
      return json(res, 200, {
        ok: true,
        session: result.session,
        created: result.created,
        ai: ai.key,
        task: task.name,
        terminal,
        terminalError,
      });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (pathname === '/api/http' && method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      return json(res, 200, await proxyHttp(payload));
    } catch (error) {
      return json(res, 400, { error: error.message });
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
    const job = downloadJob(target, mode);
    return json(res, 202, { ok: true, job });
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

const config = await loadConfig();
const port = Number(process.env.DEVHUB_PORT || config.port || 7070);
const requestedHost = process.env.DEVHUB_HOST || config.host || '127.0.0.1';
const lanRequested = !isLoopbackHost(requestedHost);
const host = lanRequested && !config.accessToken ? '127.0.0.1' : requestedHost;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  // Local requests stay passwordless. Anything coming from the network needs
  // the configured token (HTTP Basic Auth or X-DevHub-Token).
  if (!isLoopback(req.socket.remoteAddress)) {
    if (!config.accessToken) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('DevHub: LAN mode butuh accessToken. Jalankan: devhub lan on');
    }
    if (!authorized(req, config.accessToken)) {
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="DevHub", charset="UTF-8"',
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      return res.end('DevHub: password salah atau belum diisi');
    }
  }

  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(req, res, url);
  } catch (error) {
    console.error(`[devhub] ${req.method} ${url.pathname}:`, error);
    if (!res.headersSent) return json(res, 500, { error: error.message });
    res.end();
  }
});

await ensureDirs();

server.listen(port, host, () => {
  const local = `http://127.0.0.1:${port}`;
  console.log(`\n  DevHub  →  ${local}`);
  if (lanRequested) {
    if (!config.accessToken) {
      console.log('  ⚠ LAN diminta tapi accessToken kosong — server diikat ke 127.0.0.1 saja.');
      console.log('    Jalankan: devhub lan on\n');
    } else {
      for (const address of lanAddresses()) console.log(`  LAN     →  http://${address}:${port}  (password)`);
      console.log('');
    }
  } else {
    console.log('');
  }
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
