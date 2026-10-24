// Autostart integration: launchd (macOS), systemd --user (Linux), Startup (Windows).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, LOG_DIR, ensureDirs, loadConfig } from './lib.mjs';
import { HOME, IS_MAC, IS_LINUX, IS_WIN, pidsOnPort, pathWithExtras, killProcess } from './platform.mjs';

const exec = promisify(execFile);
const LABEL = 'local.devhub';
const MAC_PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LINUX_UNIT = path.join(HOME, '.config', 'systemd', 'user', 'devhub.service');
const WIN_STARTUP = path.join(
  process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'DevHub.vbs',
);

const NODE = process.execPath;
const SERVER = path.join(ROOT, 'server.mjs');

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function vbsEscape(value) {
  return String(value).replace(/"/g, '""');
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

async function quietly(file, args) {
  try {
    const result = await exec(file, args, { maxBuffer: 4 * 1024 * 1024 });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.code ?? 1 };
  }
}

async function waitForServer(port, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function macPlist() {
  const log = path.join(LOG_DIR, 'server.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(NODE)}</string>
    <string>${xmlEscape(SERVER)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(ROOT)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(pathWithExtras())}</string>
    <key>DEVHUB_AUTOSTART</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

async function linuxUnit() {
  return `[Unit]
Description=DevHub local toolbox
After=network.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${NODE} ${SERVER}
Restart=on-failure
RestartSec=3
Environment=PATH=${pathWithExtras()}
Environment=DEVHUB_AUTOSTART=1

[Install]
WantedBy=default.target
`;
}

function windowsVbs() {
  return `Set sh = CreateObject("WScript.Shell")
sh.Run """${vbsEscape(NODE)}"" ""${vbsEscape(SERVER)}""", 0, False
`;
}

export async function autostartStatus() {
  const cfg = await loadConfig();
  const port = Number(cfg.port || 7070);
  const pids = await pidsOnPort(port);

  if (IS_MAC) {
    const enabled = fs.existsSync(MAC_PLIST);
    const loaded = enabled
      ? (await quietly('/bin/launchctl', ['print', `gui/${uid()}/${LABEL}`])).code === 0
      : false;
    return { supported: true, enabled, loaded, running: pids.length > 0, method: 'launchd', path: MAC_PLIST, port };
  }

  if (IS_LINUX) {
    const enabled = fs.existsSync(LINUX_UNIT);
    const active = enabled
      ? (await quietly('systemctl', ['--user', 'is-active', '--quiet', 'devhub.service'])).code === 0
      : false;
    return { supported: true, enabled, loaded: active, running: pids.length > 0, method: 'systemd', path: LINUX_UNIT, port };
  }

  if (IS_WIN) {
    return {
      supported: true,
      enabled: fs.existsSync(WIN_STARTUP),
      loaded: fs.existsSync(WIN_STARTUP),
      running: pids.length > 0,
      method: 'startup-folder',
      path: WIN_STARTUP,
      port,
    };
  }

  return { supported: false, enabled: false, loaded: false, running: pids.length > 0, method: 'none', path: null, port };
}

export async function enableAutostart() {
  await ensureDirs();
  const cfg = await loadConfig();
  const port = Number(cfg.port || 7070);
  const pids = await pidsOnPort(port);

  // Ambil alih server yang sedang jalan supaya launchd/systemd yang pegang.
  if (!IS_WIN) {
    for (const pid of pids) {
      try { await killProcess(pid); } catch {}
    }
    for (let i = 0; i < 20 && (await pidsOnPort(port)).length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  if (IS_MAC) {
    await fsp.mkdir(path.dirname(MAC_PLIST), { recursive: true });
    await fsp.writeFile(MAC_PLIST, await macPlist());
    await quietly('/bin/launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
    const boot = await quietly('/bin/launchctl', ['bootstrap', `gui/${uid()}`, MAC_PLIST]);
    if (boot.code && boot.code !== 0) {
      // Older macOS fallback.
      await quietly('/bin/launchctl', ['load', '-w', MAC_PLIST]);
    }
    await quietly('/bin/launchctl', ['kickstart', `gui/${uid()}/${LABEL}`]);
    await waitForServer(port);
    return autostartStatus();
  }

  if (IS_LINUX) {
    await fsp.mkdir(path.dirname(LINUX_UNIT), { recursive: true });
    await fsp.writeFile(LINUX_UNIT, await linuxUnit());
    await quietly('systemctl', ['--user', 'daemon-reload']);
    const result = await quietly('systemctl', ['--user', 'enable', '--now', 'devhub.service']);
    if (result.code) throw new Error(result.stderr || 'systemctl gagal mengaktifkan autostart');
    await waitForServer(port);
    return autostartStatus();
  }

  if (IS_WIN) {
    await fsp.mkdir(path.dirname(WIN_STARTUP), { recursive: true });
    await fsp.writeFile(WIN_STARTUP, windowsVbs(), 'utf8');
    return autostartStatus();
  }

  throw new Error(`Autostart belum didukung di ${process.platform}`);
}

export async function disableAutostart() {
  if (IS_MAC) {
    await quietly('/bin/launchctl', ['bootout', `gui/${uid()}/${LABEL}`]);
    await fsp.rm(MAC_PLIST, { force: true });
    return autostartStatus();
  }

  if (IS_LINUX) {
    await quietly('systemctl', ['--user', 'disable', '--now', 'devhub.service']);
    await fsp.rm(LINUX_UNIT, { force: true });
    await quietly('systemctl', ['--user', 'daemon-reload']);
    return autostartStatus();
  }

  if (IS_WIN) {
    await fsp.rm(WIN_STARTUP, { force: true });
    return autostartStatus();
  }

  throw new Error(`Autostart belum didukung di ${process.platform}`);
}
