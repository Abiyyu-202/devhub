// Validation + normalization for config edits from the dashboard.
import path from 'node:path';
import { HOME, VIDEO_PRESETS } from './lib.mjs';

function fail(message) {
  throw new Error(message);
}

function str(value, label, { max = 4000, allowEmpty = true } = {}) {
  if (typeof value !== 'string') fail(`${label} harus string`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) fail(`${label} wajib diisi`);
  if (trimmed.length > max) fail(`${label} terlalu panjang`);
  return trimmed;
}

function expandHome(value) {
  if (value === '~') return HOME;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(HOME, value.slice(2));
  return value;
}

function port(value, label, { allowNull = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    fail(`${label} wajib diisi`);
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) fail(`${label} harus 1-65535`);
  return number;
}

function command(value, label) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    return text || undefined;
  }
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    const parts = value.map((part) => part.trim()).filter(Boolean);
    return parts.length ? parts : undefined;
  }
  fail(`${label} harus string atau array string`);
}

function validateService(service, index) {
  if (!service || typeof service !== 'object' || Array.isArray(service)) fail(`services[${index}] tidak valid`);
  const id = str(service.id, `services[${index}].id`, { max: 60, allowEmpty: false });
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) fail(`services[${index}].id hanya huruf, angka, - dan _`);
  const result = { id, label: str(service.label || id, `services[${index}].label`, { max: 80 }) || id };
  if (service.port !== undefined && service.port !== null && service.port !== '') result.port = port(service.port, `services[${index}].port`, { allowNull: true });
  if (service.url) {
    const url = str(service.url, `services[${index}].url`);
    if (!/^https?:\/\//i.test(url)) fail(`services[${index}].url harus http:// atau https://`);
    result.url = url;
  }
  const start = command(service.start, `services[${index}].start`);
  const stop = command(service.stop, `services[${index}].stop`);
  if (start) result.start = start;
  if (stop) result.stop = stop;
  return result;
}

function validateDatabase(db, label) {
  if (!db || typeof db !== 'object' || Array.isArray(db)) fail(`${label} tidak valid`);
  const engine = str(db.engine || 'mysql', `${label}.engine`, { max: 20 });
  if (!['mysql', 'mariadb'].includes(engine)) fail(`${label}.engine harus mysql/mariadb`);
  const result = {
    engine,
    name: str(db.name, `${label}.name`, { max: 120, allowEmpty: false }),
    user: str(db.user || 'root', `${label}.user`, { max: 120 }) || 'root',
  };
  if (db.password) result.password = str(db.password, `${label}.password`, { max: 400 });
  if (db.socket) result.socket = str(db.socket, `${label}.socket`, { max: 500 });
  if (db.host) result.host = str(db.host, `${label}.host`, { max: 200 });
  if (db.port) result.port = port(db.port, `${label}.port`);
  if (db.binDir) result.binDir = str(db.binDir, `${label}.binDir`, { max: 500 });
  return result;
}

function validateBackupTarget(target, index) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail(`backup.targets[${index}] tidak valid`);
  const id = str(target.id, `backup.targets[${index}].id`, { max: 60, allowEmpty: false });
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) fail(`backup.targets[${index}].id hanya huruf, angka, - dan _`);
  const projectPath = expandHome(str(target.path, `backup.targets[${index}].path`, { max: 1000, allowEmpty: false }));
  if (!path.isAbsolute(projectPath)) fail(`backup.targets[${index}].path harus absolut`);
  const result = {
    id,
    label: str(target.label || id, `backup.targets[${index}].label`, { max: 100 }) || id,
    path: projectPath,
  };
  if (target.database) result.database = validateDatabase(target.database, `backup.targets[${index}].database`);
  return result;
}

export function validateConfigPatch(patch, current = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('Body config tidak valid');
  const clean = {};

  if ('port' in patch) clean.port = port(patch.port, 'port');
  if ('host' in patch) {
    const host = str(patch.host, 'host', { max: 200, allowEmpty: false });
    const valid = ['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(host)
      || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
      || /^[a-z0-9.-]+$/i.test(host);
    if (!valid) fail('host tidak valid');
    clean.host = host;
  }
  if ('accessToken' in patch) clean.accessToken = str(patch.accessToken, 'accessToken', { max: 300 });
  if ('scanRoots' in patch) {
    if (!Array.isArray(patch.scanRoots)) fail('scanRoots harus array');
    clean.scanRoots = patch.scanRoots.slice(0, 40).map((root, index) => {
      const value = expandHome(str(root, `scanRoots[${index}]`, { max: 1000, allowEmpty: false }));
      if (!path.isAbsolute(value)) fail(`scanRoots[${index}] harus absolut`);
      return value;
    });
    if (!clean.scanRoots.length) fail('scanRoots minimal satu folder');
  }
  if ('scanDepth' in patch) {
    const depth = Number(patch.scanDepth);
    if (!Number.isInteger(depth) || depth < 1 || depth > 6) fail('scanDepth harus 1-6');
    clean.scanDepth = depth;
  }
  if ('outputDir' in patch) clean.outputDir = expandHome(str(patch.outputDir, 'outputDir', { max: 1000, allowEmpty: false }));
  if ('downloadDir' in patch) clean.downloadDir = expandHome(str(patch.downloadDir, 'downloadDir', { max: 1000, allowEmpty: false }));
  if ('image' in patch) {
    const image = patch.image || {};
    const quality = Number(image.quality);
    const maxDim = Number(image.maxDim);
    if (!Number.isInteger(quality) || quality < 20 || quality > 95) fail('image.quality harus 20-95');
    if (!Number.isInteger(maxDim) || maxDim < 320 || maxDim > 7680) fail('image.maxDim harus 320-7680');
    clean.image = { quality, maxDim };
  }
  if ('video' in patch) {
    const preset = str(patch.video?.preset, 'video.preset', { max: 20 });
    if (!VIDEO_PRESETS[preset]) fail(`video.preset harus salah satu: ${Object.keys(VIDEO_PRESETS).join(', ')}`);
    clean.video = { preset };
  }
  if ('services' in patch) {
    if (!Array.isArray(patch.services)) fail('services harus array');
    clean.services = patch.services.slice(0, 40).map(validateService);
  }
  if ('backup' in patch) {
    const backup = patch.backup || {};
    const result = {};
    if ('dir' in backup) {
      const dir = expandHome(str(backup.dir, 'backup.dir', { max: 1000 }));
      if (dir && !path.isAbsolute(dir)) fail('backup.dir harus absolut');
      result.dir = dir;
    }
    if ('targets' in backup) {
      if (!Array.isArray(backup.targets)) fail('backup.targets harus array');
      result.targets = backup.targets.slice(0, 40).map(validateBackupTarget);
      const ids = new Set();
      for (const target of result.targets) {
        if (ids.has(target.id)) fail(`backup target id duplikat: ${target.id}`);
        ids.add(target.id);
      }
    }
    clean.backup = result;
  }

  const nextHost = clean.host ?? current.host ?? '127.0.0.1';
  const nextToken = clean.accessToken ?? current.accessToken ?? '';
  const lan = !['127.0.0.1', '::1', 'localhost'].includes(String(nextHost).toLowerCase());
  if (lan && !nextToken) fail('LAN mode butuh accessToken — jalankan devhub lan on atau isi token');

  return clean;
}
