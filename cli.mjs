#!/usr/bin/env node
// DevHub CLI
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROOT, HOME, LOG_DIR, OUTPUT_DIR, DOWNLOAD_DIR,
  ensureDirs, loadConfig, mergedTasks, findTask, compressMedia,
  listPorts, killPid, gitInfo, gitAction, getServices, controlService, which,
  slugify, formatBytes, detectProject, logName, platformLabel, IS_WIN, IS_MAC,
} from './lib/lib.mjs';
import { openTarget, pidsOnPort, killProcess, spawnShell, pathWithExtras } from './lib/platform.mjs';
import { autostartStatus, enableAutostart, disableAutostart } from './lib/autostart.mjs';
import { aiKeys, resolveAi, detectAiTools, installedAiTools, installHint } from './lib/ai.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m', magenta: '\x1b[35m',
};
const c = (color, text) => `${color}${text}${C.reset}`;
const dim = (text) => c(C.dim, text);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function header(title) {
  console.log(`\n${c(C.green, '◆')} ${c(C.bold, title)}\n`);
}

function fail(message) {
  console.error(`${c(C.red, '✖')} ${message}`);
  process.exit(1);
}

async function readLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function choose(prompt, items) {
  console.log(`\n${c(C.bold, prompt)}`);
  items.forEach((item, index) => {
    console.log(`  ${c(C.cyan, String(index + 1).padStart(2))}. ${item.label}${item.hint ? dim('  ' + item.hint) : ''}`);
  });
  console.log(`  ${c(C.dim, ' 0')}. ${dim('batal')}`);
  const answer = await readLine(`\nPilih [1-${items.length}]: `);
  const index = Number(answer) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= items.length) return null;
  return items[index].value;
}

function resolveUserPath(input) {
  const value = String(input || '').trim();
  if (value === '~') return HOME;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(HOME, value.slice(2));
  return path.resolve(value);
}

// ---------------------------------------------------------------- server control

async function serverAlive(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function startServer() {
  const cfg = await loadConfig();
  const port = cfg.port || 7070;
  if (await serverAlive(port)) return port;
  await ensureDirs();
  const log = path.join(LOG_DIR, 'server.log');
  const child = spawn(process.execPath, [path.join(__dirname, 'server.mjs')], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')],
    env: { ...process.env, PATH: pathWithExtras() },
  });
  child.unref();
  for (let i = 0; i < 40; i += 1) {
    if (await serverAlive(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server gagal start — cek ${log}`);
}

async function stopServer() {
  const cfg = await loadConfig();
  const pids = await pidsOnPort(cfg.port);
  if (!pids.length) {
    console.log(`${c(C.dim, 'DevHub tidak sedang jalan.')}`);
    return;
  }
  for (const pid of pids) {
    try { await killProcess(pid); } catch {}
  }
  console.log(`${c(C.green, '✔')} DevHub dihentikan ${dim(`(PID ${pids.join(', ')})`)}`);
}

async function cmdServe(args) {
  const open = args.includes('--open');
  if (open) {
    const port = await startServer();
    console.log(`${c(C.green, '✔')} DevHub jalan di ${c(C.cyan, `http://127.0.0.1:${port}`)}`);
    await openTarget(`http://127.0.0.1:${port}`);
    return;
  }
  const { spawn: run } = await import('node:child_process');
  const child = run(process.execPath, [path.join(__dirname, 'server.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, PATH: pathWithExtras() },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ---------------------------------------------------------------- maintenance

function toolVersion(bin, args, pattern) {
  const result = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env: { ...process.env, PATH: pathWithExtras() },
  });
  if (result.error || result.status !== 0) return null;
  const raw = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return raw.match(pattern)?.[1] || raw.split('\n')[0].trim() || null;
}

async function restartViaService(status) {
  if (!status?.enabled) return null;
  const env = { ...process.env, PATH: pathWithExtras() };
  let result;
  if (status.method === 'systemd') {
    result = spawnSync('systemctl', ['--user', 'restart', 'devhub.service'], { encoding: 'utf8', env });
  } else if (status.method === 'launchd') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    result = spawnSync('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/local.devhub`], { encoding: 'utf8', env });
  } else {
    return null;
  }
  if (result.error || result.status !== 0) return null;
  for (let i = 0; i < 40; i += 1) {
    if (await serverAlive(status.port)) return status.port;
    await wait(150);
  }
  return null;
}

async function restartServer() {
  const cfg = await loadConfig();
  const port = cfg.port || 7070;
  const auto = await autostartStatus().catch(() => null);
  if (auto?.enabled) {
    const servicePort = await restartViaService(auto);
    if (servicePort) return { port: servicePort, wasRunning: auto.running, pids: [], via: auto.method };
  }

  const wasRunning = await serverAlive(port);
  let pids = [];
  if (wasRunning) {
    pids = await pidsOnPort(port);
    for (const pid of pids) {
      try {
        if (IS_WIN) await killProcess(pid);
        else process.kill(pid, 'SIGTERM');
      } catch {}
    }
    for (let i = 0; i < 20; i += 1) {
      if (!(await serverAlive(port)) && !(await pidsOnPort(port)).length) break;
      await wait(150);
    }
    for (const pid of await pidsOnPort(port)) {
      try { await killProcess(pid, { force: true, tree: true }); } catch {}
    }
    for (let i = 0; i < 20 && (await pidsOnPort(port)).length; i += 1) {
      await wait(150);
    }
    if ((await pidsOnPort(port)).length) {
      throw new Error(`Gagal menghentikan server lama di port ${port}`);
    }
  }

  return { port: await startServer(), wasRunning, pids, via: null };
}

async function cmdRestart() {
  header('DevHub restart');
  try {
    const result = await restartServer();
    if (result.via) {
      console.log(`  ${c(C.green, '✔')} ${result.wasRunning ? 'Restart' : 'Start'} via ${result.via}`);
    } else if (result.wasRunning) {
      console.log(`  ${c(C.green, '✔')} Server lama dihentikan${result.pids.length ? ` ${dim(`(PID ${result.pids.join(', ')})`)}` : ''}`);
    } else {
      console.log(`  ${dim('Server belum jalan — dinyalakan.')}`);
    }
    console.log(`  ${c(C.green, '✔')} http://127.0.0.1:${result.port}`);
  } catch (error) {
    fail(error.message);
  }
}

async function cmdUpdate(args = []) {
  const restart = args.includes('--restart');
  header('DevHub update');

  const git = await which('git');
  if (!git) {
    const hint = IS_WIN ? 'winget install Git.Git' : IS_MAC ? 'brew install git' : 'sudo apt install git';
    fail(`git belum terpasang. Install dulu: ${hint}`);
  }

  const env = { ...process.env, PATH: pathWithExtras() };
  const run = (gitArgs, options = {}) => spawnSync(git, ['-C', ROOT, ...gitArgs], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env,
    ...options,
  });

  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') {
    fail(`Folder DevHub bukan git repository: ${ROOT}`);
  }

  const branch = (run(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || 'HEAD';
  const dirty = (run(['status', '--porcelain']).stdout || '')
    .split('\n')
    .filter((line) => line && !line.startsWith('??'));
  if (dirty.length) {
    console.error(`  ${c(C.yellow, '⚠')} Ada perubahan lokal yang belum di-commit:`);
    for (const line of dirty.slice(0, 5)) console.error(`    ${dim(line)}`);
    if (dirty.length > 5) console.error(`    ${dim(`… dan ${dirty.length - 5} file lain`)}`);
    fail('Commit atau stash dulu sebelum update.');
  }

  const before = (run(['rev-parse', 'HEAD']).stdout || '').trim();
  const beforeShort = before.slice(0, 7);
  const cfg = await loadConfig();
  const wasRunning = await serverAlive(cfg.port || 7070);
  console.log(`  ${dim(`branch ${branch} · ${beforeShort}`)}`);
  console.log(`  ${dim('Menarik update dari origin…')}`);

  const pull = run(['pull', '--ff-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (pull.error) fail(`git pull gagal: ${pull.error.message}`);
  if (pull.status !== 0) {
    const detail = `${pull.stderr || ''}${pull.stdout || ''}`.trim();
    fail(`git pull gagal${detail ? `:\n${detail}` : ''}`);
  }

  const after = (run(['rev-parse', 'HEAD']).stdout || '').trim();
  if (after === before) {
    console.log(`  ${c(C.green, '✔')} Sudah versi terbaru ${dim(beforeShort)}`);
    return;
  }

  const afterShort = after.slice(0, 7);
  const commits = (run(['log', '--oneline', '--no-decorate', `${before}..${after}`]).stdout || '')
    .split('\n')
    .filter(Boolean);
  console.log(`  ${c(C.green, '✔')} Update ${dim(beforeShort)} → ${dim(afterShort)}`);
  for (const line of commits.slice(0, 10)) console.log(`    ${line}`);
  if (commits.length > 10) console.log(`    ${dim(`… dan ${commits.length - 10} commit lain`)}`);

  if (!wasRunning) {
    console.log(`\n  ${dim('Server tidak sedang jalan. Jalankan')} ${c(C.cyan, 'devhub start')} ${dim('untuk memakai versi baru.')}`);
    return;
  }
  if (!restart) {
    console.log(`\n  ${c(C.yellow, '⚠')} Server masih memakai kode lama — jalankan ${c(C.cyan, 'devhub restart')}`);
    return;
  }

  console.log(`\n  ${dim('Restart server…')}`);
  try {
    const result = await restartServer();
    console.log(`  ${c(C.green, '✔')} Server jalan lagi di ${c(C.cyan, `http://127.0.0.1:${result.port}`)}${result.via ? dim(` (${result.via})`) : ''}`);
  } catch (error) {
    console.log(`  ${c(C.yellow, '⚠')} Update berhasil, tapi restart gagal: ${error.message}`);
    console.log(`  ${dim('Coba manual:')} ${c(C.cyan, 'devhub restart')}`);
    process.exitCode = 1;
  }
}

async function cmdCheck() {
  header('DevHub check');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= 20;
  const deps = [
    {
      key: 'git', label: 'git', note: 'update & git helper',
      args: ['--version'], pattern: /git version (\S+)/,
      install: { win: 'winget install Git.Git', mac: 'brew install git', linux: 'sudo apt install git' },
    },
    {
      key: 'curl', label: 'curl', note: 'downloader fallback',
      args: ['--version'], pattern: /^curl (\S+)/,
      install: { win: 'winget install curl.curl', mac: 'brew install curl', linux: 'sudo apt install curl' },
    },
    {
      key: 'ffmpeg', label: 'ffmpeg', note: IS_MAC ? 'opsional (macOS pakai sips/avconvert)' : 'kompresi media',
      args: ['-version'], pattern: /ffmpeg version (\S+)/,
      install: { win: 'winget install Gyan.FFmpeg', mac: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg' },
    },
    {
      key: 'tmux', label: 'tmux', note: IS_WIN ? 'split AI via WSL' : 'split AI (agy/opc)',
      args: ['-V'], pattern: /^tmux (\S+)/,
      install: { win: 'pakai WSL — tmux tidak native di Windows', mac: 'brew install tmux', linux: 'sudo apt install tmux' },
    },
    {
      key: 'fzf', label: 'fzf', note: 'pemilihan project',
      args: ['--version'], pattern: /^(\S+)/,
      install: { win: 'winget install junegunn.fzf', mac: 'brew install fzf', linux: 'sudo apt install fzf' },
    },
    {
      key: 'yt-dlp', label: 'yt-dlp', note: 'download streaming',
      args: ['--version'], pattern: /^(\S+)/,
      install: { win: 'winget install yt-dlp.yt-dlp', mac: 'brew install yt-dlp', linux: 'python3 -m pip install --user yt-dlp' },
    },
  ];

  const rows = [{
    label: 'Node.js', installed: true, ok: nodeOk,
    version: process.version, note: nodeOk ? '' : 'butuh Node 20+',
  }];
  for (const dep of deps) {
    const binPath = await which(dep.key);
    const installed = Boolean(binPath);
    const version = installed ? toolVersion(binPath, dep.args, dep.pattern) : null;
    rows.push({ ...dep, installed, ok: installed, version, binPath });
  }

  const mark = (row) => (row.installed && row.ok ? c(C.green, '●') : c(C.red, '○'));
  for (const row of rows) {
    const label = String(row.label).padEnd(12);
    let detail;
    if (!row.installed) detail = dim(row.note || 'tidak terpasang');
    else if (row.version) detail = row.version;
    else detail = dim(row.binPath || 'terpasang');
    if (row.label === 'Node.js' && !row.ok) detail = `${row.version} ${c(C.red, '(butuh Node 20+)')}`;
    console.log(`  ${mark(row)} ${label} ${detail}`);
  }

  const missing = rows.filter((row) => !row.installed);
  if (missing.length) {
    console.log(`\n  ${c(C.yellow, '⚠')} ${missing.length} dependency belum terpasang:`);
    for (const row of missing) {
      const hint = IS_WIN ? row.install.win : IS_MAC ? row.install.mac : row.install.linux;
      console.log(`    ${String(row.label).padEnd(12)} ${c(C.cyan, hint)}`);
    }
    console.log(`\n  ${dim('DevHub tetap jalan; fitur yang membutuhkan dependency tersebut belum aktif.')}`);
  } else if (nodeOk) {
    console.log(`\n  ${c(C.green, '✔')} Semua dependency terpasang.`);
  }

  if (!nodeOk) {
    const hint = IS_WIN ? 'winget install OpenJS.NodeJS.LTS' : IS_MAC ? 'brew install node' : 'sudo apt install nodejs npm';
    console.log(`\n  ${c(C.red, '✖')} Node.js ${process.version} terlalu lama; butuh Node 20+.`);
    console.log(`    ${c(C.cyan, hint)}`);
    process.exitCode = 1;
  }

  const cfg = await loadConfig();
  const port = cfg.port || 7070;
  const alive = await serverAlive(port);
  console.log(`\n  ${alive ? c(C.green, '●') : c(C.red, '○')} Server ${alive ? 'jalan' : 'mati'} ${dim(`http://127.0.0.1:${port}`)}`);
}

// ---------------------------------------------------------------- tasks

async function taskList() {
  const cfg = await loadConfig();
  return mergedTasks(cfg);
}

async function pickTask(query, { alwaysPrompt = false } = {}) {
  const tasks = await taskList();
  if (!tasks.length) fail('Belum ada project. Taruh project di folder scan atau tambah lewat dashboard.');
  if (query) {
    const needle = query.toLowerCase();
    const match = tasks.find((t) => t.name.toLowerCase().includes(needle) || t.path.toLowerCase().includes(needle) || t.id === query);
    if (match) return match;
    fail(`Tugas "${query}" tidak ditemukan`);
  }
  if (!alwaysPrompt && tasks.length === 1) return tasks[0];

  const fzf = await which('fzf');
  if (fzf) {
    const input = tasks.map((t) => `${t.name}\t${t.path}`).join('\n');
    const result = spawnSync(fzf, ['--with-nth=1,2', '--delimiter=\t', '--prompt=project> ', '--height=40%', '--reverse'], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'],
    });
    if (result.status !== 0) return null;
    const name = result.stdout.split('\t')[0].trim();
    return tasks.find((t) => t.name === name) || null;
  }

  return choose('Pilih project', tasks.map((t) => ({
    label: t.name, hint: `${t.path}  ${t.command || ''}`, value: t,
  })));
}

async function cmdTasks() {
  const tasks = await taskList();
  header(`Tugas (${tasks.length})`);
  for (const task of tasks) {
    const badge = task.source === 'manual' ? c(C.magenta, 'manual') : dim('auto');
    console.log(`  ${c(C.cyan, task.name.padEnd(22))} ${badge}  ${dim(task.path)}`);
    console.log(`  ${' '.repeat(23)}$ ${task.command || '-'}${task.port ? dim(`   :${task.port}`) : ''}\n`);
  }
}

async function cmdRun(query) {
  const task = await pickTask(query);
  if (!task) return;
  await ensureDirs();
  const logPath = path.join(LOG_DIR, logName(task.id));
  const log = fs.openSync(logPath, 'a');
  fs.writeSync(log, `\n[${new Date().toISOString()}] $ ${task.command} (cwd: ${task.path})\n`);
  const spec = spawnShell(task.command, {
    cwd: task.path,
    detached: true,
    stdio: ['ignore', log, log],
  });
  const child = spawn(spec.file, spec.args, spec.options);
  child.unref();
  console.log(`${c(C.green, '✔')} ${task.name} jalan ${dim(`(PID ${child.pid})`)}`);
  console.log(`  ${dim('log:')} ${logPath}`);
  if (task.port) console.log(`  ${dim('buka:')} http://127.0.0.1:${task.port}`);
}

// ---------------------------------------------------------------- AI splits

async function requireTmux() {
  if (IS_WIN) {
    console.log(`${c(C.yellow, '⚠')} Split tmux tidak tersedia native di Windows.`);
    console.log(`  Pakai ${c(C.cyan, 'WSL')} lalu jalankan DevHub dari distro Linux.`);
    return null;
  }
  const tmux = await which('tmux');
  if (!tmux) {
    console.log(`${c(C.yellow, '⚠')} tmux belum terpasang.`);
    console.log(`  macOS: ${c(C.cyan, 'brew install tmux')}   Linux: ${c(C.cyan, 'sudo apt install tmux')}`);
    return null;
  }
  return tmux;
}

async function pickAi(preselect) {
  if (preselect) {
    const ai = await resolveAi(preselect);
    if (!ai) fail(`AI "${preselect}" tidak dikenal. Pilihan: ${aiKeys().join(', ')}`);
    if (!ai.installed) fail(`${ai.label} tidak ditemukan di PATH. Install: ${installHint(ai)}`);
    return ai;
  }

  const installed = await installedAiTools();
  if (!installed.length) {
    fail(`Tidak ada AI CLI terdeteksi. Install salah satu: ${aiKeys().join(', ')}`);
  }
  if (installed.length === 1) {
    console.log(`${c(C.dim, `AI terdeteksi: ${installed[0].label}`)}`);
    return installed[0];
  }

  return choose('Pilih AI', installed.map((tool) => ({
    label: tool.label,
    hint: tool.binPath,
    value: tool,
  })));
}

async function cmdAiList() {
  const tools = await detectAiTools();
  header('AI CLI');
  for (const tool of tools) {
    const mark = tool.installed ? c(C.green, '●') : c(C.red, '○');
    console.log(`  ${mark} ${String(tool.key).padEnd(14)} ${dim(tool.installed ? tool.binPath : `belum terpasang · ${tool.install}`)}`);
  }
  console.log(`\n  ${dim('pakai:')} devhub ai [project] [--ai=<key>]`);
}

function openSplit(tmux, task, ai) {
  const session = `devhub-${slugify(task.name)}-${ai.key}`;
  const exists = spawnSync(tmux, ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;

  if (exists) {
    console.log(`${c(C.dim, 'Sesi sudah ada, attach…')}`);
    spawnSync(tmux, ['attach', '-t', session], { stdio: 'inherit' });
    return;
  }

  const run = (args) => spawnSync(tmux, args, { stdio: 'ignore' });
  const shell = process.env.SHELL || '/bin/sh';
  run(['new-session', '-d', '-s', session, '-c', task.path]);
  run(['set-option', '-t', session, 'mouse', 'on']);
  run(['set-option', '-t', session, 'pane-border-status', 'top']);
  run(['select-pane', '-t', `${session}:0.0`, '-T', `dev · ${task.name}`]);
  run(['send-keys', '-t', `${session}:0.0`, `cd ${JSON.stringify(task.path)} && ${task.command || shell}`, 'Enter']);

  run(['split-window', '-h', '-t', session, '-c', task.path]);
  run(['select-pane', '-t', `${session}:0.1`, '-T', ai.key]);
  const aiCommand = ai.binPath
    ? `exec ${JSON.stringify(ai.binPath)}`
    : `echo ${JSON.stringify(`${ai.label} tidak ditemukan di PATH`)}; exec ${shell}`;
  run(['send-keys', '-t', `${session}:0.1`, aiCommand, 'Enter']);
  run(['select-pane', '-t', `${session}:0.0`]);

  console.log(`${c(C.green, '✔')} tmux ${c(C.cyan, session)} — kiri: dev server, kanan: ${ai.key}`);
  spawnSync(tmux, ['attach', '-t', session], { stdio: 'inherit' });
}

async function cmdPair(query, aiKey) {
  const tmux = await requireTmux();
  if (!tmux) return;

  const ai = await resolveAi(aiKey);
  if (!ai) fail(`AI "${aiKey}" tidak dikenal`);
  if (!ai.installed) {
    console.log(`${c(C.yellow, '⚠')} ${ai.label} tidak ditemukan di PATH.`);
    console.log(`  Install: ${c(C.cyan, installHint(ai))}`);
  }

  const task = await pickTask(query, { alwaysPrompt: true });
  if (!task) return;

  console.log(`${c(C.dim, 'project:')} ${task.name}  ${dim(`$ ${task.command || '-'}`)}`);
  openSplit(tmux, task, ai);
}

async function cmdAgy(query) {
  return cmdPair(query, 'agy');
}

async function cmdOpc(query) {
  return cmdPair(query, 'opencode');
}

async function cmdAi(args) {
  if (args.includes('--list')) return cmdAiList();

  let preselect = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--ai=')) {
      preselect = arg.slice('--ai='.length) || null;
    } else if (arg === '--ai') {
      preselect = args[i + 1] || null;
      i += 1;
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  const query = positional[0] || null;

  const tmux = await requireTmux();
  if (!tmux) return;

  const task = await pickTask(query, { alwaysPrompt: true });
  if (!task) return;

  const ai = await pickAi(preselect);
  if (!ai) return;

  console.log(`${c(C.dim, 'project:')} ${task.name}  ${dim(`$ ${task.command || '-'}`)}`);
  openSplit(tmux, task, ai);
}

// ---------------------------------------------------------------- compress

async function cmdCompress(args) {
  const paths = args.filter((a) => !a.startsWith('--'));
  if (!paths.length) fail('Pakai: devhub compress <file...> [--quality=75] [--max=1920] [--preset=1080p] [--keep]');

  const quality = Number(args.find((a) => a.startsWith('--quality='))?.split('=')[1] || 75);
  const maxDim = Number(args.find((a) => a.startsWith('--max='))?.split('=')[1] || 1920);
  const preset = args.find((a) => a.startsWith('--preset='))?.split('=')[1] || '1080p';
  const keepFormat = args.includes('--keep');

  header('Kompres media');
  for (const input of paths) {
    const resolved = resolveUserPath(input);
    if (!fs.existsSync(resolved)) { console.log(`${c(C.red, '✖')} ${input} — tidak ditemukan`); continue; }
    process.stdout.write(`  ${dim('proses')} ${path.basename(resolved)} … `);
    try {
      const result = await compressMedia(resolved, { quality, maxDim, preset, keepFormat });
      if (result.note) {
        console.log(`${c(C.green, '✔')} ${formatBytes(result.before)} ${dim(result.note)}`);
      } else {
        console.log(`${c(C.green, '✔')} ${formatBytes(result.before)} → ${formatBytes(result.after)} ${c(C.green, `(−${result.savedPct}%)`)}`);
      }
      console.log(`    ${dim('→')} ${result.output}`);
    } catch (error) {
      console.log(`${c(C.red, '✖')} ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------- ports

async function cmdPorts(args) {
  if (args[0] === 'kill' && args[1]) {
    await killPid(Number(args[1]));
    console.log(`${c(C.green, '✔')} PID ${args[1]} dimatikan`);
    return;
  }
  const ports = await listPorts();
  header(`Port listen (${ports.length})`);
  console.log(`  ${dim('PORT'.padEnd(6))}${dim('PROSES'.padEnd(18))}${dim('PID'.padEnd(8))}${dim('ADDRESS')}`);
  for (const row of ports) {
    console.log(`  ${c(C.green, String(row.port).padEnd(6))}${row.command.padEnd(18)}${String(row.pid ?? '-').padEnd(8)}${dim(row.address)}`);
  }
  console.log(`\n  ${dim('matikan proses:')} devhub ports kill <pid>`);
}

// ---------------------------------------------------------------- git

async function cmdGit(args) {
  const dir = resolveUserPath(args[0] || process.cwd());
  const actionIndex = args.findIndex((a) => ['status', 'pull', 'push', 'commit'].includes(a));
  const action = actionIndex >= 0 ? args[actionIndex] : 'status';
  const message = args.slice(actionIndex + 1).join(' ');

  if (action === 'status') {
    const info = await gitInfo(dir);
    if (!info.ok) fail(info.error || 'Bukan repo git');
    header(`${path.basename(dir)} · ${info.branch}`);
    console.log(`  ahead ${c(C.cyan, info.ahead)} / behind ${c(C.cyan, info.behind)} · ${info.files.length} file berubah`);
    if (info.last?.hash) console.log(`  ${dim('last:')} ${info.last.hash} ${info.last.subject} ${dim(`(${info.last.when})`)}`);
    for (const file of info.files) console.log(`  ${c(C.yellow, file.status.trim() || '·')} ${file.file}`);
    return;
  }

  try {
    const output = await gitAction(dir, action, message);
    console.log(`${c(C.green, '✔')} git ${action}`);
    if (output) console.log(output);
  } catch (error) {
    fail(error.stderr?.trim() || error.message);
  }
}

// ---------------------------------------------------------------- download

async function cmdDownload(args) {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) fail('Pakai: devhub download <url> [--audio]');
  const audio = args.includes('--audio');
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  const ytdlp = await which('yt-dlp');

  let bin, cliArgs;
  if (ytdlp) {
    bin = ytdlp;
    cliArgs = ['-o', path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s')];
    if (audio) cliArgs.push('-x', '--audio-format', 'mp3');
    cliArgs.push(url);
  } else if (/\.(mp4|mkv|mp3|m4a|zip|pdf|jpg|jpeg|png|dmg|iso|exe|msi)(\?.*)?$/i.test(url)) {
    const curl = await which('curl');
    if (!curl) fail('curl tidak ditemukan di sistem ini');
    bin = curl;
    cliArgs = ['-L', '--progress-bar', '-o', path.join(DOWNLOAD_DIR, decodeURIComponent(path.basename(new URL(url).pathname))), url];
  } else {
    fail('yt-dlp belum terpasang. Jalankan: python3 -m pip install --user yt-dlp');
  }

  console.log(`${c(C.green, '✔')} ${path.basename(bin)} → ${DOWNLOAD_DIR}\n`);
  const child = spawn(bin, cliArgs, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// ---------------------------------------------------------------- status

async function cmdStatus() {
  const cfg = await loadConfig();
  const services = await getServices(cfg);
  const ports = await listPorts();
  const alive = await serverAlive(cfg.port);
  header('DevHub status');
  const dot = (on) => (on ? c(C.green, '●') : c(C.red, '○'));
  for (const svc of services) {
    const note = svc.url || (svc.port ? `127.0.0.1:${svc.port}` : '');
    console.log(`  ${dot(svc.running)} ${String(svc.label).padEnd(14)} ${dim(note)}`);
  }
  if (!services.length) console.log(`  ${dim('belum ada layanan di config')}`);
  console.log(`  ${dot(alive)} ${'DevHub'.padEnd(14)} ${dim(`http://127.0.0.1:${cfg.port}`)}`);
  console.log(`\n  ${ports.length} port listen · ${(await taskList()).length} project · ${platformLabel()}`);
}

// ---------------------------------------------------------------- autostart

function printAutostart(s) {
  if (!s.supported) fail(`Autostart belum didukung di ${platformLabel()}`);
  console.log(`  Autostart : ${s.enabled ? c(C.green, 'ON') : c(C.red, 'OFF')} ${dim(`(${s.method})`)}`);
  console.log(`  Terpasang : ${dim(s.path || '-')}`);
  console.log(`  Server    : ${s.running ? c(C.green, 'JALAN') : c(C.red, 'MATI')} ${dim(`port ${s.port}`)}`);
}

async function cmdAutostart(args) {
  const action = args[0] || 'status';
  try {
    if (action === 'on' || action === 'enable' || action === 'start') {
      const status = await enableAutostart();
      printAutostart(status);
      if (!status.running) console.log(`\n  ${c(C.yellow, '⚠')} Server belum merespons — cek ${dim(path.join(LOG_DIR, 'server.log'))}`);
      else console.log(`\n  ${c(C.green, '✔')} DevHub akan otomatis nyala saat login.`);
      return;
    }
    if (action === 'off' || action === 'disable' || action === 'stop') {
      const status = await disableAutostart();
      printAutostart(status);
      console.log(`\n  ${c(C.green, '✔')} Autostart dimatikan.`);
      return;
    }
    if (action === 'status') {
      printAutostart(await autostartStatus());
      return;
    }
    fail('Pakai: devhub autostart [on|off|status]');
  } catch (error) {
    fail(error.message);
  }
}

// ---------------------------------------------------------------- menu

async function menu() {
  console.log(`\n${c(C.green, '╭──────────────────────────────╮')}`);
  console.log(`${c(C.green, '│')}  ${c(C.bold, 'DevHub')} ${dim('· local toolbox')}      ${c(C.green, '│')}`);
  console.log(`${c(C.green, '╰──────────────────────────────╯')}`);

  const choice = await choose('Mau ngapain?', [
    { label: 'Buka dashboard', hint: 'http://127.0.0.1:7070', value: 'dashboard' },
    { label: 'Kompres foto/video', hint: 'path lokal', value: 'compress' },
    { label: 'Jalankan project', hint: 'dev server', value: 'run' },
    { label: 'devhub agy', hint: 'pilih project → tmux: dev + agy', value: 'agy' },
    { label: 'devhub opc', hint: 'pilih project → tmux: dev + opencode', value: 'opc' },
    { label: 'devhub ai', hint: 'pilih project + AI', value: 'ai' },
    { label: 'Port & service', hint: 'lihat / kill', value: 'ports' },
    { label: 'Git status', hint: 'project aktif', value: 'git' },
    { label: 'Download', hint: 'video / audio / file', value: 'download' },
    { label: 'Autostart', hint: 'nyala otomatis saat login', value: 'autostart' },
    { label: 'Cek dependency', hint: 'devhub check', value: 'check' },
    { label: 'Update DevHub', hint: 'git pull', value: 'update' },
    { label: 'Restart server', hint: 'stop + start', value: 'restart' },
  ]);

  if (!choice) return;
  if (choice === 'dashboard') return cmdServe(['--open']);
  if (choice === 'compress') {
    const answer = await readLine('Path file (pisahkan spasi): ');
    return cmdCompress(answer.split(/\s+/).filter(Boolean));
  }
  if (choice === 'run') return cmdRun();
  if (choice === 'agy') return cmdAgy();
  if (choice === 'opc') return cmdOpc();
  if (choice === 'ai') return cmdAi([]);
  if (choice === 'ports') return cmdPorts([]);
  if (choice === 'git') {
    const task = await pickTask();
    if (task) return cmdGit([task.path, 'status']);
    return;
  }
  if (choice === 'download') {
    const url = await readLine('URL: ');
    return cmdDownload([url]);
  }
  if (choice === 'autostart') {
    const status = await autostartStatus();
    return cmdAutostart([status.enabled ? 'off' : 'on']);
  }
  if (choice === 'check') return cmdCheck();
  if (choice === 'update') return cmdUpdate([]);
  if (choice === 'restart') return cmdRestart();
}

async function cmdService(args) {
  const [name, action] = args;
  if (!name || !action) fail('Pakai: devhub service <nama> <start|stop>  (nama dari config.services)');
  try {
    const cfg = await loadConfig();
    const output = await controlService(cfg, name, action);
    console.log(`${c(C.green, '✔')} ${output || `${name} ${action}`}`);
  } catch (error) { fail(error.message); }
}

// ---------------------------------------------------------------- main

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case undefined:
  case 'menu':
    await ensureDirs();
    await menu();
    break;
  case 'serve':
  case 'dashboard':
    await cmdServe(rest);
    break;
  case 'start':
    console.log(`${c(C.green, '✔')} http://127.0.0.1:${await startServer()}`);
    break;
  case 'stop':
    await stopServer();
    break;
  case 'restart':
    await cmdRestart();
    break;
  case 'update':
    await cmdUpdate(rest);
    break;
  case 'check':
    await cmdCheck();
    break;
  case 'tasks':
    await cmdTasks();
    break;
  case 'run':
    await cmdRun(rest[0]);
    break;
  case 'agy':
    await cmdAgy(rest[0]);
    break;
  case 'opc':
  case 'opencode':
    await cmdOpc(rest[0]);
    break;
  case 'ai':
    await cmdAi(rest);
    break;
  case 'compress':
    await cmdCompress(rest);
    break;
  case 'ports':
    await cmdPorts(rest);
    break;
  case 'git':
    await cmdGit(rest);
    break;
  case 'download':
    await cmdDownload(rest);
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'service':
    await cmdService(rest);
    break;
  case 'autostart':
    await cmdAutostart(rest);
    break;
  case 'path':
    console.log(ROOT);
    break;
  default:
    console.log(`DevHub — perintah:
  devhub                 menu interaktif
  devhub start           nyalakan server di background
  devhub stop            matikan server background
  devhub restart         restart server background
  devhub update          pull update DevHub (tanpa restart)
  devhub update --restart  pull + restart server
  devhub check           cek dependency yang kurang
  devhub serve           jalankan server di foreground
  devhub dashboard       nyalakan + buka browser
  devhub tasks           daftar project
  devhub run [nama]      jalankan project
  devhub agy [nama]      pilih project → tmux: dev server + agy
  devhub opc [nama]      pilih project → tmux: dev server + opencode
  devhub ai [nama]       pilih project + AI (agy/opencode/claude/…)
  devhub ai --list       daftar AI CLI yang terdeteksi
  devhub compress <f>    kompres foto/video
  devhub ports [kill id] lihat / matikan port
  devhub git [path] ...  status|pull|push|commit
  devhub download <url>  download video/audio
  devhub status          status layanan
  devhub autostart [on|off|status]  nyala otomatis saat login`);
}
