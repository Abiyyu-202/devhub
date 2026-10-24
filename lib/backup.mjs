// Backup & restore: project archive + optional MySQL/MariaDB dump.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STATE_DIR, TMP_DIR, slugify } from './lib.mjs';
import { which, pathWithExtras } from './platform.mjs';

const rawExec = promisify(execFile);
const exec = (file, args, options = {}) => rawExec(file, args, { windowsHide: true, ...options });

export const BACKUP_DIR = path.join(STATE_DIR, 'backups');

const TAR_EXCLUDES = [
  'node_modules', 'vendor', 'dist', 'build', '.next', '.nuxt', '.svelte-kit',
  '.parcel-cache', '.turbo', 'coverage', '.nyc_output',
];

export function backupDir(cfg) {
  return cfg?.backup?.dir ? path.resolve(cfg.backup.dir) : BACKUP_DIR;
}

export function configuredTargets(cfg) {
  return (Array.isArray(cfg?.backup?.targets) ? cfg.backup.targets : []).map((target) => ({
    id: target.id,
    label: target.label || target.id,
    path: path.resolve(target.path || ''),
    database: target.database ? {
      engine: target.database.engine || 'mysql',
      name: target.database.name || '',
      user: target.database.user || 'root',
      password: target.database.password || '',
      socket: target.database.socket || '',
      host: target.database.host || '',
      port: target.database.port || null,
      binDir: target.database.binDir || '',
    } : null,
    configured: true,
  }));
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function dbBin(database, name) {
  const candidates = [];
  if (database.binDir) candidates.push(path.join(database.binDir, name));
  candidates.push(name);
  return candidates;
}

async function resolveDbBin(database, name) {
  for (const candidate of dbBin(database, name)) {
    if (candidate.includes(path.sep)) {
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    } else {
      const found = await which(candidate);
      if (found) return found;
    }
  }
  throw new Error(`${name} tidak ditemukan. Set database.binDir di config backup target.`);
}

function dbArgs(database) {
  const args = ['--no-defaults'];
  if (database.socket) args.push(`--socket=${database.socket}`);
  if (database.host) args.push(`--host=${database.host}`);
  if (database.port) args.push(`--port=${database.port}`);
  if (database.user) args.push(`--user=${database.user}`);
  return args;
}

function dbEnv(database) {
  return {
    ...process.env,
    PATH: pathWithExtras(),
    ...(database.password ? { MYSQL_PWD: database.password } : {}),
  };
}

async function runWithInput(bin, args, inputFile, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const input = fs.createReadStream(inputFile);
    input.pipe(child.stdin);
    input.on('error', reject);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} gagal (code ${code}): ${stderr.trim().slice(0, 800)}`));
    });
  });
}

async function archiveProject(target, tempDir, onProgress) {
  const parent = path.dirname(target.path);
  const base = path.basename(target.path);
  const output = path.join(tempDir, 'project.tar.gz');
  const args = ['-czf', output, '-C', parent];
  for (const name of TAR_EXCLUDES) args.push(`--exclude=${name}`);
  args.push(base);
  onProgress?.(15, `Mengarsipkan ${base}…`);
  await exec('tar', args, { maxBuffer: 8 * 1024 * 1024 });
  const stat = await fsp.stat(output);
  return { file: output, size: stat.size, base };
}

async function dumpDatabase(target, tempDir, onProgress) {
  if (!target.database?.name) return null;
  const bin = await resolveDbBin(target.database, 'mysqldump');
  const output = path.join(tempDir, 'database.sql');
  onProgress?.(45, `Dump database ${target.database.name}…`);
  const handle = fs.createWriteStream(output);
  await new Promise((resolve, reject) => {
    const child = spawn(bin, [...dbArgs(target.database), '--single-transaction', '--routines', '--triggers', target.database.name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dbEnv(target.database),
      windowsHide: true,
    });
    let stderr = '';
    child.stdout.pipe(handle);
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      handle.end();
      if (code === 0) resolve();
      else reject(new Error(`mysqldump gagal (code ${code}): ${stderr.trim().slice(0, 800)}`));
    });
  });
  await new Promise((resolve) => handle.on('close', resolve));
  const stat = await fsp.stat(output);
  return { file: output, size: stat.size, database: target.database.name };
}

export async function createBackup(cfg, target, { onProgress } = {}) {
  if (!target?.path) throw new Error('Target backup tidak punya path');
  try {
    if (!fs.statSync(target.path).isDirectory()) throw new Error('bukan folder');
  } catch {
    throw new Error(`Folder project tidak ditemukan: ${target.path}`);
  }

  const dir = backupDir(cfg);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const work = await fsp.mkdtemp(path.join(TMP_DIR, 'backup-'));
  const started = new Date();
  try {
    const project = await archiveProject(target, work, onProgress);
    const database = await dumpDatabase(target, work, onProgress);
    const meta = {
      id: `${slugify(target.label)}-${stamp()}`,
      label: target.label,
      targetId: target.id,
      projectPath: target.path,
      projectBase: project.base,
      projectSize: project.size,
      database: database ? { name: database.database, size: database.size } : null,
      createdAt: started.toISOString(),
      devhub: 2,
    };
    await fsp.writeFile(path.join(work, 'meta.json'), JSON.stringify(meta, null, 2));
    onProgress?.(75, 'Membuat arsip akhir…');
    const fileName = `${meta.id}.tar.gz`;
    const finalPath = path.join(dir, fileName);
    await exec('tar', ['-czf', finalPath, '-C', work, '.'], { maxBuffer: 8 * 1024 * 1024 });
    await fsp.writeFile(`${finalPath}.json`, JSON.stringify(meta, null, 2));
    const stat = await fsp.stat(finalPath);
    onProgress?.(100, 'Backup selesai');
    return { file: fileName, path: finalPath, size: stat.size, meta };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function listBackups(cfg) {
  const dir = backupDir(cfg);
  await fsp.mkdir(dir, { recursive: true });
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.tar.gz')) continue;
    const file = path.join(dir, name);
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    let meta = null;
    try { meta = JSON.parse(await fsp.readFile(`${file}.json`, 'utf8')); } catch {}
    items.push({
      file: name,
      size: stat.size,
      createdAt: meta?.createdAt || stat.mtime.toISOString(),
      label: meta?.label || name.replace(/-\d{8}-\d{6}\.tar\.gz$/, ''),
      projectPath: meta?.projectPath || '',
      database: meta?.database?.name || null,
      hasMeta: Boolean(meta),
    });
  }
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function safeBackupPath(cfg, file) {
  const dir = backupDir(cfg);
  const name = path.basename(String(file || ''));
  if (!name.endsWith('.tar.gz')) throw new Error('Nama backup tidak valid');
  const full = path.join(dir, name);
  if (!full.startsWith(dir + path.sep)) throw new Error('Nama backup tidak valid');
  return full;
}

export async function restoreBackup(cfg, targets, file, { confirm, mode = 'new', withDatabase = true, onProgress } = {}) {
  if (confirm !== 'RESTORE') throw new Error('Konfirmasi salah — ketik RESTORE');
  const archive = safeBackupPath(cfg, file);
  if (!fs.existsSync(archive)) throw new Error('File backup tidak ditemukan');

  await fsp.mkdir(TMP_DIR, { recursive: true });
  const work = await fsp.mkdtemp(path.join(TMP_DIR, 'restore-'));
  try {
    onProgress?.(10, 'Mengekstrak arsip…');
    await exec('tar', ['-xzf', archive, '-C', work], { maxBuffer: 8 * 1024 * 1024 });
    const meta = JSON.parse(await fsp.readFile(path.join(work, 'meta.json'), 'utf8'));
    if (!meta.projectPath) throw new Error('meta.json tidak valid');

    let restoredPath = null;
    if (mode === 'overwrite') {
      const parent = path.dirname(meta.projectPath);
      onProgress?.(40, 'Menimpa folder project…');
      await exec('tar', ['-xzf', path.join(work, 'project.tar.gz'), '-C', parent], { maxBuffer: 8 * 1024 * 1024 });
      restoredPath = meta.projectPath;
    } else {
      let dest = `${meta.projectPath}.restore-${stamp()}`;
      let n = 2;
      while (fs.existsSync(dest)) dest = `${meta.projectPath}.restore-${stamp()}-${n++}`;
      await fsp.mkdir(dest, { recursive: true });
      onProgress?.(40, 'Memulihkan project ke folder baru…');
      await exec('tar', ['-xzf', path.join(work, 'project.tar.gz'), '-C', dest], { maxBuffer: 8 * 1024 * 1024 });
      restoredPath = path.join(dest, meta.projectBase || path.basename(meta.projectPath));
    }

    let database = null;
    if (withDatabase && fs.existsSync(path.join(work, 'database.sql'))) {
      const target = targets.find((item) => item.id === meta.targetId) || targets.find((item) => item.path === meta.projectPath);
      if (!target?.database) throw new Error('Database target tidak ditemukan di config — restore database dilewati');
      const bin = await resolveDbBin(target.database, 'mysql');
      onProgress?.(75, `Restore database ${target.database.name}…`);
      await runWithInput(bin, [...dbArgs(target.database), target.database.name], path.join(work, 'database.sql'), dbEnv(target.database));
      database = target.database.name;
    }

    onProgress?.(100, 'Restore selesai');
    return { restoredPath, database, meta };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function deleteBackup(cfg, file) {
  const archive = safeBackupPath(cfg, file);
  await fsp.rm(archive, { force: true });
  await fsp.rm(`${archive}.json`, { force: true });
  return true;
}
