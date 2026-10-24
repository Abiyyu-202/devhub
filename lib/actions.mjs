// Project action detection: package scripts, artisan, composer, django.
import fs from 'node:fs';
import path from 'node:path';

function exists(file) {
  try { fs.accessSync(file); return true; } catch { return false; }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function packageManager(dir) {
  if (exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(path.join(dir, 'bun.lockb')) || exists(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

const SKIP_SCRIPTS = new Set(['dev', 'start', 'preview', 'serve']);

export function detectActions(task) {
  const dir = task?.path;
  if (!dir || !exists(dir)) return [];
  const actions = [];
  const add = (id, label, command, group, extra = {}) => {
    if (actions.some((action) => action.id === id)) return;
    actions.push({ id, label, command, group, ...extra });
  };

  if (exists(path.join(dir, 'package.json'))) {
    const pkg = readJson(path.join(dir, 'package.json'));
    const scripts = pkg.scripts || {};
    const pm = packageManager(dir);
    const run = pm === 'npm' ? 'npm run' : `${pm} run`;
    for (const [name, raw] of Object.entries(scripts)) {
      if (SKIP_SCRIPTS.has(name)) continue;
      const label = name;
      const risky = /fresh|reset|drop|delete|clean/i.test(name) || /fresh|reset|drop/i.test(String(raw));
      add(`script:${name}`, label, `${run} ${name}`, 'Scripts', { risky });
    }
    add('install', `Install dependencies (${pm})`, `${pm} install`, 'Dependencies');
  }

  if (exists(path.join(dir, 'artisan'))) {
    add('artisan:migrate', 'Migrate', 'php artisan migrate', 'Laravel', { risky: true });
    add('artisan:fresh', 'Migrate fresh + seed', 'php artisan migrate:fresh --seed', 'Laravel', { risky: true });
    add('artisan:seed', 'Seed database', 'php artisan db:seed', 'Laravel');
    add('artisan:test', 'Tests', 'php artisan test', 'Laravel');
    add('artisan:routes', 'Route list', 'php artisan route:list', 'Laravel');
    add('artisan:clear', 'Optimize clear', 'php artisan optimize:clear', 'Laravel');
    add('artisan:storage', 'Storage link', 'php artisan storage:link', 'Laravel');
    add('artisan:queue', 'Queue work (stop when empty)', 'php artisan queue:work --stop-when-empty', 'Laravel');
  }

  if (exists(path.join(dir, 'composer.json'))) {
    add('composer:install', 'Composer install', 'composer install', 'Dependencies');
    add('composer:dump', 'Composer dump-autoload', 'composer dump-autoload', 'Dependencies');
    add('composer:update', 'Composer update', 'composer update', 'Dependencies', { risky: true });
  }

  if (exists(path.join(dir, 'manage.py'))) {
    add('django:migrate', 'Migrate', 'python3 manage.py migrate', 'Django', { risky: true });
    add('django:test', 'Tests', 'python3 manage.py test', 'Django');
    add('django:static', 'Collect static', 'python3 manage.py collectstatic --noinput', 'Django');
  }

  const order = ['Scripts', 'Dependencies', 'Laravel', 'Django'];
  return actions.sort((a, b) => {
    const ai = order.indexOf(a.group);
    const bi = order.indexOf(b.group);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.label.localeCompare(b.label);
  });
}

export function findAction(task, id) {
  return detectActions(task).find((action) => action.id === id) || null;
}
