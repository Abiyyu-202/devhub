// Cleanup / disk saver: scan scanRoots for regenerable build directories.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IS_WIN, whichSync } from './platform.mjs';

const rawExec = promisify(execFile);
const exec = (file, args, options = {}) => rawExec(file, args, { windowsHide: true, ...options });

export const CLEANUP_NAMES = [
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.turbo',
  '.vite',
  'coverage',
  '.nyc_output',
  'bower_components',
];

const CLEANUP_SET = new Set(CLEANUP_NAMES);
const SKIP_WALK = new Set(['.git', '.hg', '.svn', '.Trash', 'Library', 'Applications']);

function inside(parent, child) {
  const root = path.resolve(parent);
  const target = path.resolve(child);
  return target === root || target.startsWith(root + path.sep);
}

async function dirSize(dir) {
  if (!IS_WIN) {
    const du = whichSync('du') || '/usr/bin/du';
    try {
      const { stdout } = await exec(du, ['-sk', dir], { maxBuffer: 1024 * 1024 });
      const kb = Number(stdout.trim().split(/\s+/)[0]);
      if (Number.isFinite(kb)) return kb * 1024;
    } catch {}
  }
  let total = 0;
  async function walk(current) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        try { total += (await fsp.stat(full)).size; } catch {}
      }
    }
  }
  await walk(dir);
  return total;
}

export async function scanCleanup(cfg, { maxDepth = 6 } = {}) {
  const roots = (cfg.scanRoots || []).filter((root) => {
    try { return fs.statSync(root).isDirectory(); } catch { return false; }
  });
  const found = [];
  const seen = new Set();

  async function walk(current, root, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (CLEANUP_SET.has(entry.name)) {
        if (!seen.has(full)) {
          seen.add(full);
          const relative = path.relative(root, full);
          const parts = relative.split(path.sep);
          const project = parts.length > 1 ? parts[0] : path.basename(root);
          found.push({ path: full, name: entry.name, project, root });
        }
        continue; // never descend into a cleanup target
      }
      if (SKIP_WALK.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(full, root, depth + 1);
    }
  }

  for (const root of roots) await walk(root, root, 1);

  const entries = [];
  const queue = [...found];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      const size = await dirSize(item.path);
      let mtime = 0;
      try { mtime = (await fsp.stat(item.path)).mtimeMs; } catch {}
      entries.push({ ...item, size, mtime });
    }
  });
  await Promise.all(workers);

  entries.sort((a, b) => b.size - a.size);
  return {
    entries,
    total: entries.reduce((sum, entry) => sum + entry.size, 0),
    roots,
    whitelist: CLEANUP_NAMES,
  };
}

export async function deleteCleanup(cfg, targets) {
  const roots = (cfg.scanRoots || []).map((root) => path.resolve(root));
  const deleted = [];
  const skipped = [];

  for (const target of Array.isArray(targets) ? targets : []) {
    const resolved = path.resolve(String(target || ''));
    const name = path.basename(resolved);
    const underRoot = roots.some((root) => inside(root, resolved) && resolved !== root);
    if (!CLEANUP_SET.has(name) || !underRoot) {
      skipped.push({ path: resolved, reason: 'di luar scanRoots atau bukan folder whitelist' });
      continue;
    }
    let real;
    try { real = await fsp.realpath(resolved); } catch {
      skipped.push({ path: resolved, reason: 'tidak ditemukan' });
      continue;
    }
    if (!roots.some((root) => inside(root, real) && path.resolve(real) !== path.resolve(root))) {
      skipped.push({ path: resolved, reason: 'symlink keluar scanRoots' });
      continue;
    }
    try {
      const size = await dirSize(real);
      await fsp.rm(real, { recursive: true, force: true });
      deleted.push({ path: resolved, size });
    } catch (error) {
      skipped.push({ path: resolved, reason: error.message });
    }
  }

  return { deleted, skipped, freed: deleted.reduce((sum, entry) => sum + entry.size, 0) };
}
