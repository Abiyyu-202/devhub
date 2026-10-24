// Git Helper v2: branches, diff, history, stash, discard.
import path from 'node:path';
import { gitRun } from './lib.mjs';

function branchName(value) {
  const name = String(value || '').trim();
  if (!name || name.startsWith('-') || name.length > 120 || /\.\.|[\s~^:?*[\\]/.test(name)) {
    throw new Error('Nama branch tidak valid');
  }
  return name;
}

function relFile(dir, file) {
  const value = String(file || '').trim();
  if (!value) throw new Error('File wajib diisi');
  const resolved = path.resolve(dir, value);
  if (resolved !== path.resolve(dir) && !resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('File harus di dalam project');
  }
  return path.relative(dir, resolved);
}

function parseRecords(raw, separator = '\x1e') {
  return String(raw || '').split(separator).map((chunk) => chunk.trim()).filter(Boolean);
}

export async function gitBranches(dir) {
  const raw = await gitRun(dir, ['branch', '--format=%(refname:short) %(HEAD)']);
  const branches = String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const current = /\*$/.test(line);
    return { name: line.replace(/\s*\*$/, '').trim(), current };
  });
  let remote = [];
  try {
    const remoteRaw = await gitRun(dir, ['branch', '-r', '--format=%(refname:short)']);
    remote = String(remoteRaw || '').split('\n').map((name) => name.trim()).filter((name) => name && !name.endsWith('/HEAD'));
  } catch {}
  return { branches, remote, current: branches.find((b) => b.current)?.name || '' };
}

export async function gitHistory(dir, limit = 25) {
  const count = Math.max(1, Math.min(100, Number(limit) || 25));
  const raw = await gitRun(dir, ['log', `--max-count=${count}`, '--format=%h%x1f%an%x1f%ar%x1f%s%x1e']);
  return parseRecords(raw).map((line) => {
    const [hash, author, when, subject] = line.split('\x1f');
    return { hash, author, when, subject };
  });
}

export async function gitDiff(dir, file, staged = false) {
  const args = ['diff', '--no-ext-diff', '--unified=3'];
  if (staged) args.push('--cached');
  if (file) args.push('--', relFile(dir, file));
  const output = await gitRun(dir, args);
  return output.length > 200000 ? `${output.slice(0, 200000)}\n… diff dipotong` : output;
}

export async function gitStashList(dir) {
  const raw = await gitRun(dir, ['stash', 'list', '--format=%gd%x1f%gs%x1e']);
  return parseRecords(raw).map((line) => {
    const [ref, subject] = line.split('\x1f');
    return { ref, subject };
  });
}

export async function gitV2(dir, action, payload = {}) {
  switch (action) {
    case 'fetch':
      return gitRun(dir, ['fetch', '--all', '--prune']);
    case 'pull':
      return gitRun(dir, ['pull', '--ff-only']);
    case 'push':
      return gitRun(dir, ['push']);
    case 'commit': {
      const message = String(payload.message || '').trim();
      if (!message) throw new Error('Pesan commit wajib diisi');
      await gitRun(dir, ['add', '-A']);
      return gitRun(dir, ['commit', '-m', message]);
    }
    case 'stage':
      return gitRun(dir, ['add', '--', relFile(dir, payload.file)]);
    case 'unstage':
      return gitRun(dir, ['restore', '--staged', '--', relFile(dir, payload.file)]);
    case 'discard':
      if (payload.file) return gitRun(dir, ['restore', '--', relFile(dir, payload.file)]);
      return gitRun(dir, ['restore', '.']);
    case 'switch':
      return gitRun(dir, ['switch', branchName(payload.branch)]);
    case 'create':
      return gitRun(dir, ['switch', '-c', branchName(payload.branch)]);
    case 'delete':
      return gitRun(dir, ['branch', payload.force ? '-D' : '-d', branchName(payload.branch)]);
    case 'stash':
      return gitRun(dir, ['stash', 'push', '-u', '-m', String(payload.message || `devhub ${new Date().toISOString()}`)]);
    case 'stash-pop':
      return gitRun(dir, ['stash', 'pop']);
    case 'stash-drop':
      return gitRun(dir, ['stash', 'drop', String(payload.ref || 'stash@{0}')]);
    case 'merge':
      return gitRun(dir, ['merge', branchName(payload.branch)]);
    default:
      throw new Error(`Aksi git tidak dikenal: ${action}`);
  }
}
