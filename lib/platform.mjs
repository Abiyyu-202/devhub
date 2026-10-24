// Cross-platform helpers: PATH lookup, shells, ports, open/kill, disk.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const rawExec = promisify(execFile);
// Windows: child console apps (netstat, tasklist, taskkill, ...) open a visible
// console window when the parent has no console (DevHub runs detached). Hide them.
const exec = (file, args, options = {}) => rawExec(file, args, { windowsHide: true, ...options });

export const HOME = os.homedir();
export const PLATFORM = process.platform;
export const IS_MAC = PLATFORM === 'darwin';
export const IS_LINUX = PLATFORM === 'linux';
export const IS_WIN = PLATFORM === 'win32';

const EXTRA_PATHS = IS_WIN
  ? [
      path.join(HOME, 'AppData', 'Local', 'pnpm'),
      path.join(HOME, 'AppData', 'Local', 'pnpm', 'bin'),
      path.join(HOME, 'AppData', 'Local', 'Programs'),
      path.join(HOME, 'AppData', 'Roaming', 'npm'),
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files\\Git\\cmd',
    ]
  : [
      path.join(HOME, 'Library', 'pnpm', 'bin'),
      path.join(HOME, 'Library', 'pnpm'),
      path.join(HOME, '.local', 'share', 'pnpm'),
      path.join(HOME, '.pnpm'),
      path.join(HOME, '.local', 'bin'),
      path.join(HOME, '.opencode', 'bin'),
      path.join(HOME, '.bun', 'bin'),
      path.join(HOME, '.yarn', 'bin'),
      path.join(HOME, '.cargo', 'bin'),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/opt/local/bin',
      '/opt/local/sbin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ];

export function pathWithExtras(basePath) {
  const parts = (basePath || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of EXTRA_PATHS) {
    if (!parts.includes(dir)) {
      if (dir.startsWith(HOME) || dir.startsWith('/opt/')) {
        parts.unshift(dir);
      } else {
        parts.push(dir);
      }
    }
  }
  return parts.join(path.delimiter);
}

export function whichSync(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin)) {
    try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch { return null; }
  }

  const exts = IS_WIN
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const dirs = pathWithExtras().split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    const direct = path.join(dir, bin);
    try { fs.accessSync(direct, fs.constants.X_OK); return direct; } catch {}
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
  }
  return null;
}

export async function which(bin) {
  return whichSync(bin);
}

// Shell used to run user project commands (npm run dev, etc).
export function shellSpec(command) {
  if (IS_WIN) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  const shell = process.env.SHELL || (IS_MAC ? '/bin/zsh' : '/bin/sh');
  return { file: shell, args: ['-lc', command] };
}

export function spawnShell(command, options = {}) {
  const spec = shellSpec(command);
  const userEnv = options.env || {};
  const pnpmHome = process.env.PNPM_HOME || (IS_MAC ? path.join(HOME, 'Library', 'pnpm') : path.join(HOME, '.local', 'share', 'pnpm'));
  const env = {
    ...process.env,
    ...userEnv,
    PATH: pathWithExtras(userEnv.PATH),
    PNPM_HOME: pnpmHome,
  };
  return { ...spec, options: { windowsHide: true, ...options, env } };
}

export async function execShell(command, options = {}) {
  const spec = shellSpec(command);
  const userEnv = options.env || {};
  const pnpmHome = process.env.PNPM_HOME || (IS_MAC ? path.join(HOME, 'Library', 'pnpm') : path.join(HOME, '.local', 'share', 'pnpm'));
  const env = {
    ...process.env,
    ...userEnv,
    PATH: pathWithExtras(userEnv.PATH),
    PNPM_HOME: pnpmHome,
  };
  return exec(spec.file, spec.args, {
    maxBuffer: 8 * 1024 * 1024,
    ...options,
    env,
  });
}

export function openTarget(target) {
  if (IS_MAC) return exec('/usr/bin/open', [target]).catch(() => {});
  if (IS_WIN) {
    const safe = String(target).replace(/"/g, '');
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${safe}"`]).catch(() => {});
  }
  return exec('xdg-open', [target]).catch(() => {});
}

export async function killProcess(pid, { force = false, tree = false } = {}) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 1) throw new Error('PID tidak valid');
  if (numeric === process.pid) throw new Error('Tidak bisa mematikan DevHub sendiri');

  if (IS_WIN) {
    const args = ['/PID', String(numeric)];
    if (tree) args.push('/T');
    if (force) args.push('/F');
    await exec('taskkill', args);
    return true;
  }

  try {
    process.kill(numeric, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    throw new Error(`Gagal kill ${numeric}: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  try { process.kill(numeric, 0); process.kill(numeric, 'SIGKILL'); } catch {}
  return true;
}

export async function pidsOnPort(port) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric <= 0) return [];

  if (IS_WIN) {
    try {
      const { stdout } = await exec('netstat', ['-ano', '-p', 'tcp']);
      const pids = new Set();
      for (const line of stdout.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (fields[0] !== 'TCP' || fields[3] !== 'LISTENING') continue;
        if (!fields[1]?.endsWith(`:${numeric}`)) continue;
        const pid = Number(fields[4]);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids];
    } catch {
      return [];
    }
  }

  const lsof = whichSync('lsof');
  if (!lsof) return [];
  try {
    const { stdout } = await exec(lsof, ['-nP', `-iTCP:${numeric}`, '-sTCP:LISTEN', '-t']);
    return stdout.split('\n').map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export async function diskUsage() {
  if (IS_WIN) return null;
  try {
    const df = whichSync('df') || '/bin/df';
    const { stdout } = await exec(df, ['-k', '/']);
    const line = stdout.trim().split('\n')[1]?.split(/\s+/);
    if (!line) return null;
    return { total: Number(line[1]) * 1024, used: Number(line[2]) * 1024, free: Number(line[3]) * 1024 };
  } catch {
    return null;
  }
}

export function userShell() {
  return process.env.SHELL || (IS_WIN ? 'cmd.exe' : '/bin/sh');
}

export function platformLabel() {
  if (IS_MAC) return 'macOS';
  if (IS_WIN) return 'Windows';
  if (IS_LINUX) return 'Linux';
  return PLATFORM;
}
