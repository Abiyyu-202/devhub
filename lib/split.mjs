// Shared tmux split logic for CLI and dashboard AI launcher.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { slugify } from './lib.mjs';
import { which, IS_MAC, IS_WIN, IS_LINUX } from './platform.mjs';

export function splitSessionName(task, ai) {
  return `devhub-${slugify(task.name)}-${ai.key}`;
}

export async function tmuxAvailable() {
  return which('tmux');
}

export function sessionExists(tmux, session) {
  return spawnSync(tmux, ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

export function createSplitSession(tmux, task, ai) {
  const session = splitSessionName(task, ai);
  if (sessionExists(tmux, session)) return { session, created: false };

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
  return { session, created: true };
}

export function attachCommand(tmux, session) {
  return `${tmux} attach -t ${session}`;
}

// Opens a real terminal window attached to the session. Used by the dashboard,
// where the server process has no TTY of its own.
export async function openTerminal(session, { tmux } = {}) {
  if (IS_WIN) throw new Error('Terminal otomatis tidak didukung native di Windows — pakai WSL.');
  const tmuxBin = tmux || (await which('tmux')) || 'tmux';
  const command = attachCommand(tmuxBin, session);

  if (IS_MAC) {
    // Using a .command file avoids AppleScript/Automation permission prompts.
    const dir = path.join(os.tmpdir(), 'devhub-terminal');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${session}.command`);
    fs.writeFileSync(
      file,
      `#!/bin/sh\nexec ${JSON.stringify(tmuxBin)} attach -t ${JSON.stringify(session)}\n`,
      { mode: 0o755 },
    );
    const result = spawnSync('/usr/bin/open', ['-a', 'Terminal', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || 'Gagal membuka Terminal');
    }
    return { terminal: 'Terminal.app', command, file };
  }

  if (IS_LINUX) {
    const candidates = [
      ['x-terminal-emulator', ['-e', 'sh', '-lc', command]],
      ['gnome-terminal', ['--', 'sh', '-lc', command]],
      ['konsole', ['-e', 'sh', '-lc', command]],
      ['xfce4-terminal', ['-e', `sh -lc ${JSON.stringify(command)}`]],
      ['alacritty', ['-e', 'sh', '-lc', command]],
      ['kitty', ['sh', '-lc', command]],
    ];
    for (const [bin, args] of candidates) {
      const found = await which(bin);
      if (!found) continue;
      const child = spawn(found, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { terminal: bin, command };
    }
    throw new Error('Tidak ada terminal GUI yang terdeteksi');
  }

  throw new Error('Platform tidak didukung');
}

export function splitHint() {
  if (IS_WIN) return 'Windows: jalankan DevHub dari WSL untuk fitur split tmux.';
  if (IS_MAC) return 'macOS: butuh tmux (brew install tmux).';
  return 'Linux: butuh tmux dan terminal GUI (gnome-terminal/konsole/x-terminal-emulator).';
}
