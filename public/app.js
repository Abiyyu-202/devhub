const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  view: 'compress',
  files: [],
  tasks: [],
  ports: [],
  status: null,
  logTaskId: null,
  logTimer: null,
  dlTimer: null,
  cleanup: [],
  backups: [],
  targets: [],
  jobs: [],
  jobsReady: false,
  notified: new Set(),
  compressJobId: null,
  downloadJobId: null,
  actionTask: null,
  actionRun: null,
  actionTimer: null,
  ai: null,
  config: null,
};

const VIEW_META = {
  compress: ['Kompres Media', 'Foto & video — pakai sips/avconvert di macOS, ffmpeg di Linux/Windows.'],
  tasks: ['Tugas & Project', 'Project terdeteksi otomatis, plus tugas manual. Run/stop dan aksi project.'],
  backup: ['Backup & Restore', 'Arsip project + dump database. Restore selalu minta konfirmasi.'],
  cleanup: ['Cleanup', 'Hapus folder build yang bisa dibuat ulang dan bebaskan disk.'],
  git: ['Git Helper', 'Branch, diff, history, stash, discard — tanpa buka terminal.'],
  ai: ['AI Launcher', 'Buat sesi tmux: dev server di kiri, AI pilihan di kanan.'],
  ports: ['Server & Port', 'Lihat yang sedang listen, matikan proses nyangkut, kontrol layanan lokal.'],
  api: ['API Tester', 'Mini Postman lokal — request dikirim dari server DevHub.'],
  download: ['Downloader', 'Download video/audio/file sebagai background job dengan progress.'],
  jobs: ['Antrian Job', 'Progress kompres, download, backup, dan restore.'],
  config: ['Config', 'Edit scan roots, kompresi, services, dan backup target.'],
};

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || response.statusText);
  return data;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function bytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n, i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3600);
}

function setProgress(container, bar, percent, message) {
  if (!container || !bar) return;
  container.classList.remove('hidden');
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  bar.classList.toggle('indeterminate', percent === null);
  if (message) container.title = message;
}

function hideProgress(container) {
  if (container) container.classList.add('hidden');
}

function switchView(view) {
  state.view = view;
  $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  const [title, sub] = VIEW_META[view] || ['DevHub', ''];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  if (view === 'tasks') loadTasks();
  if (view === 'backup') loadBackups();
  if (view === 'ports') loadPorts();
  if (view === 'git') loadGitProjects();
  if (view === 'ai') loadAi();
  if (view === 'jobs') loadJobs();
  if (view === 'config') loadConfig();
  if (view === 'download') updateDownloadNote();
}

$$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
$('#refreshBtn').addEventListener('click', () => refreshAll());

// ------------------------------------------------------------ status
async function loadStatus() {
  try {
    const data = await api('/api/status');
    state.status = data;
    const services = Array.isArray(data.services) ? data.services : [];
    $('#sideStatus').innerHTML = services.length
      ? services.map((svc) => `<div class="status-row"><span>${esc(svc.label)}</span><span class="dot ${svc.running ? 'on' : 'off'}"></span></div>`).join('')
      : '<div class="status-row"><span>Layanan</span><span class="hint">config</span></div>';

    const sys = data.system;
    $('#hostInfo').innerHTML = `<b>${esc(sys.hostname)}</b><br>${sys.projects} project · ${data.ports} port<br>${bytes(sys.memory.free)} free`;

    if (state.view === 'ports') renderServices();
  } catch (error) {
    console.error(error);
  }
}

async function refreshAll() {
  await loadStatus();
  if (state.view === 'tasks') await loadTasks();
  if (state.view === 'ports') await loadPorts();
  if (state.view === 'git') await loadGit();
  if (state.view === 'backup') await loadBackups();
  if (state.view === 'ai') await loadAi();
  if (state.view === 'jobs') await loadJobs();
  if (state.view === 'config') await loadConfig();
  toast('Diperbarui');
}

// ------------------------------------------------------------ compress
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');

dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('drag');
  addFiles([...event.dataTransfer.files]);
});
fileInput.addEventListener('change', () => { addFiles([...fileInput.files]); fileInput.value = ''; });

function addFiles(files) {
  for (const file of files) {
    const exists = state.files.some((f) => f.name === file.name && f.size === file.size);
    if (!exists) state.files.push(file);
  }
  renderFileChips();
}

function renderFileChips() {
  $('#fileChips').innerHTML = state.files.map((file, index) => `
    <span class="chip">${esc(file.name)} · ${bytes(file.size)}
      <button data-index="${index}" title="Hapus">×</button>
    </span>`).join('');
  $$('#fileChips button').forEach((btn) => btn.addEventListener('click', () => {
    state.files.splice(Number(btn.dataset.index), 1);
    renderFileChips();
  }));
  $('#compressHint').textContent = state.files.length
    ? `${state.files.length} file siap dikompres (${bytes(state.files.reduce((acc, f) => acc + f.size, 0))})`
    : 'Belum ada file dipilih.';
}

$('#quality').addEventListener('input', (event) => { $('#qualityVal').textContent = event.target.value; });

$('#compressBtn').addEventListener('click', async () => {
  if (!state.files.length) return toast('Pilih file dulu', true);
  const button = $('#compressBtn');
  button.disabled = true;
  button.textContent = 'Mengompres…';
  try {
    const form = new FormData();
    for (const file of state.files) form.append('files', file, file.name);
    form.append('quality', $('#quality').value);
    form.append('maxDim', $('#maxDim').value);
    form.append('preset', $('#preset').value);
    form.append('keepFormat', $('#keepFormat').checked ? 'true' : 'false');

    const data = await api('/api/compress', { method: 'POST', body: form });
    renderResults(data.results);
    state.files = [];
    renderFileChips();
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Kompres sekarang';
  }
});

function renderResults(results) {
  $('#results').innerHTML = (results || []).map((result) => {
    if (result.error) {
      return `<div class="result"><div><div class="name">${esc(result.input)}</div><div class="meta" style="color:var(--red)">${esc(result.error)}</div></div></div>`;
    }
    return `<div class="result">
      <div>
        <div class="name">${esc(result.originalName || result.name)}</div>
        <div class="meta">${bytes(result.before)} → ${bytes(result.after)}</div>
      </div>
      <div class="row">
        <span class="saved" style="${result.note ? 'color:var(--dim)' : ''}">${result.note ? 'sudah optimal' : `−${result.savedPct}%`}</span>
        <a class="btn small" href="${result.url}" download>Unduh</a>
      </div>
    </div>`;
  }).join('') || '<div class="hint">Tidak ada hasil.</div>';
}

$('#pathBtn').addEventListener('click', async () => {
  const paths = $('#pathInput').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  if (!paths.length) return toast('Isi path dulu', true);
  const button = $('#pathBtn');
  button.disabled = true;
  try {
    const data = await api('/api/jobs/compress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paths,
        quality: Number($('#quality').value),
        maxDim: Number($('#maxDim').value),
        preset: $('#preset').value,
        keepFormat: $('#keepFormat').checked,
      }),
    });
    state.compressJobId = data.job.id;
    setProgress($('#compressProgress'), $('#compressProgressBar'), 0, 'Menunggu antrian…');
    toast('Kompres jalan di background');
    switchView('jobs');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------ jobs stream
function startJobStream() {
  const source = new EventSource('/api/jobs/events');
  source.addEventListener('jobs', (event) => {
    try { handleJobs(JSON.parse(event.data)); } catch (error) { console.error(error); }
  });
}

function handleJobs(jobs) {
  state.jobs = jobs;
  if (!state.jobsReady) {
    for (const job of jobs) if (['done', 'error', 'canceled'].includes(job.status)) state.notified.add(job.id);
    state.jobsReady = true;
  }
  renderJobs();

  for (const job of jobs) {
    if (job.id === state.compressJobId) {
      setProgress($('#compressProgress'), $('#compressProgressBar'), job.progress, job.message);
    }
    if (job.id === state.downloadJobId) {
      setProgress($('#dlProgress'), $('#dlProgressBar'), job.progress, job.message);
    }
    if (!['done', 'error', 'canceled'].includes(job.status) || state.notified.has(job.id)) continue;
    state.notified.add(job.id);

    if (job.type === 'compress') {
      if (job.status === 'done') {
        renderResults(job.result?.results || []);
        toast('Kompres selesai');
        setTimeout(() => hideProgress($('#compressProgress')), 2500);
      } else if (job.status === 'error') toast(job.error || 'Kompres gagal', true);
      state.compressJobId = null;
    }
    if (job.type === 'download') {
      if (job.status === 'done') toast('Download selesai');
      else if (job.status === 'error') toast(job.error || 'Download gagal', true);
      pollDownloadLog();
      setTimeout(() => hideProgress($('#dlProgress')), 2500);
      state.downloadJobId = null;
    }
    if (job.type === 'backup') {
      if (job.status === 'done') {
        toast(`Backup selesai: ${job.result?.file || ''}`);
        if (state.view === 'backup') loadBackups();
      } else if (job.status === 'error') toast(job.error || 'Backup gagal', true);
    }
    if (job.type === 'restore') {
      if (job.status === 'done') {
        toast(`Restore selesai → ${job.result?.restoredPath || ''}`);
        if (state.view === 'backup') loadBackups();
        loadTasks();
      } else if (job.status === 'error') toast(job.error || 'Restore gagal', true);
    }
  }
}

async function loadJobs() {
  try {
    const data = await api('/api/jobs');
    handleJobs(data.jobs || []);
  } catch (error) {
    toast(error.message, true);
  }
}

function jobBadge(job) {
  const map = {
    done: ['green', 'selesai'],
    error: ['amber', 'error'],
    canceled: ['amber', 'batal'],
    running: ['blue', 'jalan'],
    queued: ['', 'antri'],
  };
  const [color, label] = map[job.status] || ['', job.status];
  return `<span class="badge ${color}">${label}</span>`;
}

function renderJobs() {
  const list = $('#jobList');
  if (!list) return;
  if (!state.jobs.length) {
    list.innerHTML = '<div class="hint">Belum ada job.</div>';
    return;
  }
  list.innerHTML = `<div class="job-list">${state.jobs.map((job) => `
    <div class="job-row">
      <div class="job-top">
        <div>
          <div class="job-label">${esc(job.label)}</div>
          <div class="job-meta">${esc(job.type)} · ${new Date(job.createdAt).toLocaleTimeString('id-ID', { hour12: false })} · ${esc(job.id.slice(0, 8))}</div>
        </div>
        <div class="row">
          ${jobBadge(job)}
          ${['queued', 'running'].includes(job.status) ? `<button class="btn small danger" data-job-cancel="${esc(job.id)}">Batal</button>` : ''}
        </div>
      </div>
      <div class="progress"><div class="progress-bar" style="width:${job.progress}%"></div></div>
      <div class="job-meta" style="margin-top:6px">${job.progress}% · ${esc(job.message || '')}</div>
    </div>`).join('')}</div>`;

  $$('[data-job-cancel]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/jobs/${encodeURIComponent(btn.dataset.jobCancel)}/cancel`, { method: 'POST' });
      toast('Job dibatalkan');
    } catch (error) { toast(error.message, true); }
  }));
}

$('#jobsRefresh').addEventListener('click', loadJobs);

// ------------------------------------------------------------ tasks
async function loadTasks() {
  try {
    state.tasks = await api('/api/tasks');
    renderTasks();
    fillGitProjects();
    fillAiProjects();
  } catch (error) {
    toast(error.message, true);
  }
}

function renderTasks() {
  if (!state.tasks.length) {
    $('#taskGrid').innerHTML = '<div class="hint">Belum ada project. Tambahkan manual atau taruh project di folder scan.</div>';
    return;
  }
  $('#taskGrid').innerHTML = state.tasks.map((task) => {
    const running = Boolean(task.running);
    return `<div class="task">
      <div class="task-top">
        <div>
          <div class="task-name">${esc(task.name)}</div>
          <div class="task-path">${esc(task.path)}</div>
        </div>
        <span class="badge ${task.source === 'manual' ? 'blue' : ''}">${task.source === 'manual' ? 'manual' : 'auto'}</span>
      </div>
      <div class="task-cmd">$ ${esc(task.command || '-')}</div>
      <div class="task-foot">
        ${running
          ? `<span class="badge green"><span class="dot on" style="margin:0"></span> PID ${task.running.pid}</span>
             <button class="btn small danger" data-stop="${esc(task.id)}">Stop</button>`
          : `<button class="btn small primary" data-run="${esc(task.id)}">Run</button>`}
        <button class="btn small" data-log="${esc(task.id)}">Log</button>
        <button class="btn small" data-actions="${esc(task.id)}">Aksi</button>
        <button class="btn small ghost" data-reveal="${esc(task.path)}">Folder</button>
        ${task.source === 'manual' ? `<button class="btn small ghost" data-delete="${esc(task.id)}">Hapus</button>` : ''}
        ${task.port ? `<span class="badge">:${task.port}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  $$('[data-run]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(btn.dataset.run)}/run`, { method: 'POST' });
      toast('Menjalankan…');
      await loadTasks();
      loadStatus();
    } catch (error) { toast(error.message, true); }
  }));

  $$('[data-stop]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api(`/api/tasks/${encodeURIComponent(btn.dataset.stop)}/stop`, { method: 'POST' });
      toast('Dihentikan');
      await loadTasks();
    } catch (error) { toast(error.message, true); }
  }));

  $$('[data-log]').forEach((btn) => btn.addEventListener('click', () => openLog(btn.dataset.log)));
  $$('[data-actions]').forEach((btn) => btn.addEventListener('click', () => {
    const task = state.tasks.find((item) => item.id === btn.dataset.actions);
    if (task) openActions(task);
  }));
  $$('[data-reveal]').forEach((btn) => btn.addEventListener('click', () => api('/api/reveal', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: btn.dataset.reveal }),
  }).catch((error) => toast(error.message, true))));
  $$('[data-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Hapus tugas ini?')) return;
    await api(`/api/tasks/${encodeURIComponent(btn.dataset.delete)}`, { method: 'DELETE' });
    await loadTasks();
  }));
}

$('#taskRefresh').addEventListener('click', loadTasks);
$('#showAddTask').addEventListener('click', () => {
  const form = $('#addTaskForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
});
$('#cancelAddTask').addEventListener('click', () => { $('#addTaskForm').style.display = 'none'; });
$('#addTaskBtn').addEventListener('click', async () => {
  try {
    await api('/api/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: $('#taskName').value,
        path: $('#taskPath').value,
        command: $('#taskCommand').value,
        port: $('#taskPort').value || undefined,
      }),
    });
    $('#taskName').value = $('#taskPath').value = $('#taskCommand').value = $('#taskPort').value = '';
    $('#addTaskForm').style.display = 'none';
    toast('Tugas ditambahkan');
    await loadTasks();
  } catch (error) { toast(error.message, true); }
});

function openLog(id) {
  state.logTaskId = id;
  $('#modal').classList.remove('hidden');
  const task = state.tasks.find((t) => t.id === id);
  $('#modalTitle').textContent = task ? `Log · ${task.name}` : 'Log';
  $('#modalSub').textContent = task?.command || '';
  refreshLog();
  clearInterval(state.logTimer);
  state.logTimer = setInterval(refreshLog, 1500);
}

async function refreshLog() {
  if (!state.logTaskId) return;
  try {
    const data = await api(`/api/tasks/${encodeURIComponent(state.logTaskId)}/log`);
    const box = $('#modalLog');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = data.log || '(log kosong — jalankan tugas dulu)';
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch (error) {
    $('#modalLog').textContent = error.message;
  }
}

$('#modalRefresh').addEventListener('click', refreshLog);
$('#modalClose').addEventListener('click', () => {
  $('#modal').classList.add('hidden');
  clearInterval(state.logTimer);
  state.logTaskId = null;
});
$('#modal').addEventListener('click', (event) => { if (event.target.id === 'modal') $('#modalClose').click(); });

// ------------------------------------------------------------ project actions
async function openActions(task) {
  state.actionTask = task;
  state.actionRun = null;
  clearTimeout(state.actionTimer);
  $('#actionModal').classList.remove('hidden');
  $('#actionTitle').textContent = `Aksi · ${task.name}`;
  $('#actionSub').textContent = task.path;
  $('#actionStop').classList.add('hidden');
  $('#actionLog').textContent = 'Pilih aksi di atas.';
  $('#actionList').innerHTML = '<div class="hint">Mendeteksi aksi…</div>';
  try {
    const data = await api(`/api/actions?task=${encodeURIComponent(task.id)}`);
    renderActions(data.actions);
  } catch (error) {
    $('#actionList').innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
  }
}

function renderActions(actions) {
  if (!actions.length) {
    $('#actionList').innerHTML = '<div class="hint">Tidak ada aksi terdeteksi untuk project ini.</div>';
    return;
  }
  $('#actionList').innerHTML = actions.map((action) => `
    <button class="btn action-btn ${action.risky ? 'risky' : ''}" data-action-id="${esc(action.id)}" title="${esc(action.command)}">
      <span class="a-group">${esc(action.group)}</span>
      <span>${esc(action.label)}</span>
    </button>`).join('');
  $$('[data-action-id]').forEach((btn) => btn.addEventListener('click', async () => {
    const action = actions.find((item) => item.id === btn.dataset.actionId);
    if (!action) return;
    if (action.risky && !confirm(`${action.label} bisa mengubah data.\n\n$ ${action.command}\n\nLanjut?`)) return;
    await runAction(action);
  }));
}

async function runAction(action) {
  try {
    const data = await api('/api/actions/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: state.actionTask.id, actionId: action.id }),
    });
    state.actionRun = data.id;
    $('#actionStop').classList.remove('hidden');
    $('#actionLog').textContent = `$ ${data.command}\n\n(menjalankan…)`;
    toast(`Aksi: ${data.label}`);
    pollActionLog();
  } catch (error) {
    toast(error.message, true);
  }
}

async function pollActionLog() {
  if (!state.actionRun) return;
  clearTimeout(state.actionTimer);
  try {
    const data = await api(`/api/actions/log?id=${encodeURIComponent(state.actionRun)}`);
    const box = $('#actionLog');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = data.log || '(log kosong)';
    if (atBottom) box.scrollTop = box.scrollHeight;
    $('#actionSub').textContent = `$ ${data.command}`;
    if (data.running) {
      state.actionTimer = setTimeout(pollActionLog, 1400);
    } else {
      $('#actionStop').classList.add('hidden');
    }
  } catch (error) {
    $('#actionLog').textContent = error.message;
  }
}

$('#actionStop').addEventListener('click', async () => {
  if (!state.actionRun) return;
  try {
    await api('/api/actions/stop', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.actionRun }),
    });
    toast('Aksi dihentikan');
    pollActionLog();
  } catch (error) { toast(error.message, true); }
});

$('#actionClose').addEventListener('click', () => {
  $('#actionModal').classList.add('hidden');
  clearTimeout(state.actionTimer);
  state.actionRun = null;
});
$('#actionModal').addEventListener('click', (event) => { if (event.target.id === 'actionModal') $('#actionClose').click(); });

// ------------------------------------------------------------ backup
async function loadBackups() {
  try {
    const data = await api('/api/backups');
    state.backups = data.backups || [];
    state.targets = data.targets || [];
    renderBackupTargets();
    renderBackups();
    $('#backupNote').textContent = data.dir ? `Disimpan di ${data.dir}` : '';
  } catch (error) {
    toast(error.message, true);
  }
}

function renderBackupTargets() {
  if (!state.targets.length) {
    $('#backupTargets').innerHTML = '<div class="hint">Belum ada target. Tambahkan di Config → Backup targets.</div>';
    return;
  }
  $('#backupTargets').innerHTML = state.targets.map((target) => `
    <div class="target-card">
      <div class="t-name">${esc(target.label)}</div>
      <div class="t-path">${esc(target.path)}</div>
      <div class="row">
        ${target.database ? `<span class="badge green">DB ${esc(target.database)}</span>` : '<span class="badge">project saja</span>'}
        ${target.configured ? '<span class="badge blue">config</span>' : ''}
      </div>
      <div class="t-foot">
        <button class="btn small primary" data-backup-target="${esc(target.id)}">Backup sekarang</button>
      </div>
    </div>`).join('');

  $$('[data-backup-target]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const data = await api('/api/backups', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: btn.dataset.backupTarget }),
      });
      toast(`Backup jalan: ${data.job.label}`);
      switchView('jobs');
    } catch (error) { toast(error.message, true); }
    btn.disabled = false;
  }));
}

function renderBackups() {
  $('#backupCount').textContent = `${state.backups.length} arsip`;
  if (!state.backups.length) {
    $('#backupList').innerHTML = '<div class="hint">Belum ada backup.</div>';
    return;
  }
  $('#backupList').innerHTML = `<div class="backup-list">${state.backups.map((backup) => `
    <div class="backup-row">
      <div>
        <div class="b-name">${esc(backup.file)}</div>
        <div class="b-meta">${bytes(backup.size)} · ${esc(backup.label)}${backup.database ? ` · DB ${esc(backup.database)}` : ''} · ${new Date(backup.createdAt).toLocaleString('id-ID')}</div>
      </div>
      <div class="row">
        <button class="btn small" data-restore="${esc(backup.file)}">Restore</button>
        <button class="btn small danger" data-backup-delete="${esc(backup.file)}">Hapus</button>
      </div>
    </div>`).join('')}</div>`;

  $$('[data-restore]').forEach((btn) => btn.addEventListener('click', () => restoreBackup(btn.dataset.restore)));
  $$('[data-backup-delete]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Hapus backup ${btn.dataset.backupDelete}?`)) return;
    try {
      await api(`/api/backups?file=${encodeURIComponent(btn.dataset.backupDelete)}`, { method: 'DELETE' });
      toast('Backup dihapus');
      await loadBackups();
    } catch (error) { toast(error.message, true); }
  }));
}

async function restoreBackup(file) {
  const mode = confirm(`Restore ${file}\n\nOK = ke folder baru (.restore-*)\nCancel = batal`);
  if (!mode) return;
  const typed = prompt(`Restore ${file} ke folder baru.\nDatabase (kalau ada di backup) ikut direstore.\n\nKetik RESTORE untuk lanjut:`);
  if (typed !== 'RESTORE') return toast('Restore dibatalkan');
  try {
    const data = await api('/api/backups/restore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, confirm: 'RESTORE', mode: 'new', withDatabase: true }),
    });
    toast(`Restore jalan: ${data.job.label}`);
    switchView('jobs');
  } catch (error) {
    toast(error.message, true);
  }
}

$('#backupRefresh').addEventListener('click', loadBackups);

// ------------------------------------------------------------ cleanup
async function scanCleanup() {
  const button = $('#cleanupScan');
  button.disabled = true;
  button.textContent = 'Memindai…';
  $('#cleanupList').innerHTML = '<div class="hint">Menghitung ukuran folder…</div>';
  try {
    const data = await api('/api/cleanup/scan');
    state.cleanup = data.entries || [];
    renderCleanup(data.total);
  } catch (error) {
    toast(error.message, true);
    $('#cleanupList').innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Scan';
  }
}

function renderCleanup(total) {
  $('#cleanupTotal').textContent = state.cleanup.length ? `${state.cleanup.length} folder · ${bytes(total)} bisa dibebaskan` : 'Tidak ada folder yang bisa dibersihkan.';
  $('#cleanupAll').checked = false;
  $('#cleanupDelete').disabled = true;
  if (!state.cleanup.length) {
    $('#cleanupList').innerHTML = '<div class="hint">Tidak ada node_modules/vendor/build di scanRoots.</div>';
    return;
  }
  $('#cleanupList').innerHTML = state.cleanup.map((entry, index) => `
    <label class="cleanup-row">
      <input type="checkbox" data-cleanup-index="${index}" />
      <span class="badge">${esc(entry.name)}</span>
      <span class="c-path">${esc(entry.path)}</span>
      <span class="c-size">${bytes(entry.size)}</span>
    </label>`).join('');
  $$('[data-cleanup-index]').forEach((box) => box.addEventListener('change', updateCleanupSelection));
}

function updateCleanupSelection() {
  const selected = $$('[data-cleanup-index]:checked');
  $('#cleanupDelete').disabled = selected.length === 0;
  $('#cleanupDelete').textContent = selected.length ? `Hapus ${selected.length} folder` : 'Hapus terpilih';
}

$('#cleanupAll').addEventListener('change', (event) => {
  $$('[data-cleanup-index]').forEach((box) => { box.checked = event.target.checked; });
  updateCleanupSelection();
});

$('#cleanupScan').addEventListener('click', scanCleanup);
$('#cleanupDelete').addEventListener('click', async () => {
  const indexes = $$('[data-cleanup-index]:checked').map((box) => Number(box.dataset.cleanupIndex));
  const selected = indexes.map((index) => state.cleanup[index]).filter(Boolean);
  if (!selected.length) return;
  const total = selected.reduce((sum, entry) => sum + entry.size, 0);
  if (!confirm(`Hapus ${selected.length} folder (${bytes(total)})?\n\n${selected.slice(0, 5).map((entry) => entry.path).join('\n')}${selected.length > 5 ? '\n…' : ''}`)) return;
  try {
    const result = await api('/api/cleanup/delete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: selected.map((entry) => entry.path) }),
    });
    toast(`${result.deleted.length} folder dihapus · ${bytes(result.freed)} dibebaskan`);
    for (const skipped of result.skipped || []) toast(`${skipped.path}: ${skipped.reason}`, true);
    await scanCleanup();
  } catch (error) {
    toast(error.message, true);
  }
});

// ------------------------------------------------------------ git
function fillGitProjects() {
  const select = $('#gitProject');
  if (!select) return;
  const current = select.value;
  select.innerHTML = state.tasks.map((task) => `<option value="${esc(task.path)}">${esc(task.name)}</option>`).join('');
  if (current && state.tasks.some((task) => task.path === current)) select.value = current;
}

async function loadGitProjects() {
  if (!state.tasks.length) await loadTasks();
  else fillGitProjects();
  if ($('#gitProject').value) await loadGit();
}

async function loadGit() {
  const dir = $('#gitProject').value;
  if (!dir) return;
  $('#gitBody').innerHTML = '<div class="hint">Memuat…</div>';
  try {
    const info = await api(`/api/git?path=${encodeURIComponent(dir)}`);
    if (!info.ok) {
      $('#gitBody').innerHTML = `<div class="hint" style="color:var(--red)">${esc(info.error || 'Bukan repository git')}</div>`;
      return;
    }
    const [branches, history, stash] = await Promise.all([
      api(`/api/git/branches?path=${encodeURIComponent(dir)}`).catch(() => ({ branches: [], remote: [] })),
      api(`/api/git/history?path=${encodeURIComponent(dir)}`).catch(() => ({ commits: [] })),
      api(`/api/git/stash?path=${encodeURIComponent(dir)}`).catch(() => ({ stashes: [] })),
    ]);

    $('#gitBody').innerHTML = `
      <div class="git-status">
        <div class="stat"><div class="k">Branch</div><div class="v" style="color:var(--accent)">${esc(info.branch)}</div></div>
        <div class="stat"><div class="k">Ahead / Behind</div><div class="v">${info.ahead} / ${info.behind}</div></div>
        <div class="stat"><div class="k">Perubahan</div><div class="v">${info.files.length} file</div></div>
      </div>

      <div class="git-bar">
        <select class="input" id="gitBranchSel">${branches.branches.map((branch) => `<option value="${esc(branch.name)}" ${branch.current ? 'selected' : ''}>${esc(branch.name)}${branch.current ? ' (aktif)' : ''}</option>`).join('')}</select>
        <button class="btn small" data-gitv2="switch">Switch</button>
        <button class="btn small" data-gitv2="create">Branch baru</button>
        <button class="btn small danger" data-gitv2="delete">Hapus branch</button>
        <button class="btn small" data-gitv2="fetch">Fetch</button>
        <span class="hint">${branches.remote?.length ? `remote: ${esc(branches.remote.join(', '))}` : ''}</span>
      </div>

      <div class="stat" style="margin-bottom:14px">
        <div class="k">Commit terakhir</div>
        <div class="v" style="font-size:12.5px">${esc(info.last.hash)} · ${esc(info.last.subject)}</div>
        <div class="hint">${esc(info.last.author)} · ${esc(info.last.when)}</div>
      </div>

      ${info.files.length ? `<div class="file-list">${info.files.map((file) => {
        const staged = file.status[0] !== ' ' && file.status[0] !== '?';
        const untracked = file.status === '??';
        const unstaged = file.status[1] !== ' ';
        return `<div class="file-row" data-diff-file="${esc(file.file)}">
          <span class="st">${esc(file.status.trim() || '·')}</span>
          <span class="fname">${esc(file.file)}</span>
          <span class="file-actions">
            ${staged ? `<button class="btn small ghost" data-git-file="unstage" data-file="${esc(file.file)}">Unstage</button>` : ''}
            ${!staged && (unstaged || untracked) ? `<button class="btn small ghost" data-git-file="stage" data-file="${esc(file.file)}">Stage</button>` : ''}
            ${!untracked ? `<button class="btn small danger" data-git-file="discard" data-file="${esc(file.file)}">Discard</button>` : ''}
          </span>
        </div>`;
      }).join('')}</div>` : '<div class="hint">Working tree bersih.</div>'}

      <pre class="log-box diff-box hidden" id="gitDiff" style="margin-top:12px"></pre>

      <div class="row" style="margin-top:16px">
        <input class="input" id="gitMessage" style="flex:1;min-width:220px" placeholder="Pesan commit…" />
        <button class="btn primary" data-gitv2="commit">Commit all</button>
        <button class="btn" data-gitv2="pull">Pull</button>
        <button class="btn" data-gitv2="push">Push</button>
      </div>
      <pre class="log-box" id="gitOutput" style="margin-top:14px;display:none"></pre>

      <div class="card" style="margin-top:16px;background:#0d1319">
        <div class="card-head" style="margin-bottom:10px">
          <div><div class="card-title">Stash</div><div class="card-sub">${stash.stashes.length} stash</div></div>
          <div class="row">
            <button class="btn small" data-gitv2="stash">Stash all</button>
            <button class="btn small" data-gitv2="stash-pop" ${stash.stashes.length ? '' : 'disabled'}>Pop</button>
          </div>
        </div>
        <div class="history-list">${stash.stashes.map((item) => `<div><span class="h-hash">${esc(item.ref)}</span><span class="h-sub">${esc(item.subject)}</span></div>`).join('') || '<span class="hint">Tidak ada stash.</span>'}</div>
      </div>

      <div class="card" style="margin-top:16px;background:#0d1319">
        <div class="card-head" style="margin-bottom:10px">
          <div><div class="card-title">History</div><div class="card-sub">25 commit terakhir</div></div>
        </div>
        <div class="history-list">${history.commits.map((commit) => `<div><span class="h-hash">${esc(commit.hash)}</span><span class="h-sub">${esc(commit.subject)}</span><span class="h-when">${esc(commit.when)}</span></div>`).join('') || '<span class="hint">Belum ada commit.</span>'}</div>
      </div>
    `;

    $$('[data-gitv2]').forEach((btn) => btn.addEventListener('click', async () => {
      const action = btn.dataset.gitv2;
      try {
        if (action === 'create') {
          const name = prompt('Nama branch baru:');
          if (!name) return;
          await gitDo(action, { branch: name });
          return;
        }
        if (action === 'switch') {
          const branch = $('#gitBranchSel').value;
          if (!branch) return;
          await gitDo(action, { branch });
          return;
        }
        if (action === 'delete') {
          const branch = $('#gitBranchSel').value;
          if (!branch || !confirm(`Hapus branch ${branch}?`)) return;
          await gitDo(action, { branch, force: confirm('Paksa hapus walau belum di-merge?') });
          return;
        }
        if (action === 'commit') {
          await gitDo(action, { message: $('#gitMessage')?.value });
          return;
        }
        if (action === 'stash') {
          await gitDo(action, { message: prompt('Pesan stash (opsional):') || undefined });
          return;
        }
        await gitDo(action, {});
      } catch (error) {
        toast(error.message, true);
      }
    }));

    $$('[data-git-file]').forEach((btn) => btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const action = btn.dataset.gitFile;
      const file = btn.dataset.file;
      if (action === 'discard' && !confirm(`Buang perubahan pada ${file}?`)) return;
      await gitDo(action, { file });
    }));

    $$('[data-diff-file]').forEach((row) => row.addEventListener('click', async () => {
      const file = row.dataset.diffFile;
      const box = $('#gitDiff');
      box.classList.remove('hidden');
      box.textContent = 'Memuat diff…';
      try {
        const data = await api(`/api/git/diff?path=${encodeURIComponent(dir)}&file=${encodeURIComponent(file)}`);
        box.textContent = data.diff || '(tidak ada diff)';
      } catch (error) {
        box.textContent = error.message;
      }
    }));
  } catch (error) {
    $('#gitBody').innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
  }
}

async function gitDo(action, payload = {}) {
  const dir = $('#gitProject').value;
  try {
    const result = await api('/api/git/v2', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: dir, action, ...payload }),
    });
    toast(`Git: ${action}`);
    await loadGit();
    if (result.output) {
      const output = $('#gitOutput');
      if (output) {
        output.style.display = 'block';
        output.textContent = result.output;
      }
    }
  } catch (error) {
    toast(error.message, true);
  }
}

$('#gitProject').addEventListener('change', loadGit);
$('#gitRefresh').addEventListener('click', loadGit);

// ------------------------------------------------------------ AI launcher
function fillAiProjects() {
  const select = $('#aiProject');
  if (!select) return;
  const current = select.value;
  select.innerHTML = state.tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.name)}</option>`).join('');
  if (current && state.tasks.some((task) => task.id === current)) select.value = current;
}

async function loadAi() {
  try {
    const data = await api('/api/ai');
    state.ai = data;
    const installed = data.tools.filter((tool) => tool.installed);
    $('#aiProject').innerHTML = data.tasks.map((task) => `<option value="${esc(task.id)}">${esc(task.name)}</option>`).join('');
    $('#aiTool').innerHTML = installed.map((tool) => `<option value="${esc(tool.key)}">${esc(tool.label)}</option>`).join('');
    $('#aiNote').textContent = !data.tmux
      ? 'tmux belum terpasang — split tidak bisa jalan.'
      : installed.length ? data.hint : 'Belum ada AI CLI terdeteksi.';
    $('#aiLaunch').disabled = !data.tmux || !installed.length || !data.tasks.length;
    $('#aiTools').innerHTML = data.tools.map((tool) => `
      <span class="badge ${tool.installed ? 'green' : ''}" title="${esc(tool.installed ? tool.binPath : tool.install)}">
        ${tool.installed ? '●' : '○'} ${esc(tool.key)}
      </span>`).join('');
  } catch (error) {
    toast(error.message, true);
  }
}

$('#aiRefresh').addEventListener('click', loadAi);
$('#aiLaunch').addEventListener('click', async () => {
  const taskId = $('#aiProject').value;
  const ai = $('#aiTool').value;
  if (!taskId || !ai) return toast('Pilih project dan AI dulu', true);
  const button = $('#aiLaunch');
  button.disabled = true;
  button.textContent = 'Membuat sesi…';
  try {
    const result = await api('/api/ai/launch', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, ai, open: true }),
    });
    toast(`Sesi ${result.session} ${result.created ? 'dibuat' : 'sudah ada'}`);
    if (result.terminalError) toast(`Terminal gagal dibuka: ${result.terminalError}`, true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Launch split';
  }
});

// ------------------------------------------------------------ ports
async function loadPorts() {
  try {
    state.ports = await api('/api/ports');
    renderPorts();
    renderServices();
    $('#portCount').textContent = `${state.ports.length} port listen`;
  } catch (error) {
    toast(error.message, true);
  }
}

function renderPorts() {
  const filter = $('#portFilter').value.toLowerCase();
  const rows = state.ports.filter((p) => !filter || String(p.port).includes(filter) || p.command.toLowerCase().includes(filter));
  $('#portBody').innerHTML = rows.map((p) => `<tr>
    <td class="mono" style="color:var(--accent)">${p.port}</td>
    <td>${esc(p.command)}</td>
    <td class="mono">${p.pid ?? '—'}</td>
    <td class="mono" style="color:var(--dim)">${esc(p.address)}</td>
    <td style="text-align:right">${p.pid ? `<button class="btn small danger" data-kill="${p.pid}">Kill</button>` : '<span class="hint">system</span>'}</td>
  </tr>`).join('') || '<tr><td colspan="5" class="hint">Tidak ada port.</td></tr>';

  $$('[data-kill]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm(`Kill PID ${btn.dataset.kill}?`)) return;
    try {
      await api('/api/ports/kill', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pid: Number(btn.dataset.kill) }),
      });
      toast('Proses dimatikan');
      await loadPorts();
    } catch (error) { toast(error.message, true); }
  }));
}

$('#portFilter').addEventListener('input', renderPorts);

function renderServices() {
  const services = Array.isArray(state.status?.services) ? state.status.services : [];

  if (!services.length) {
    $('#serviceRow').innerHTML = '<span class="hint">Belum ada layanan. Tambahkan array <code>services</code> di config DevHub.</span>';
    return;
  }

  $('#serviceRow').innerHTML = services.map((svc) => {
    const note = svc.url
      ? svc.url.replace(/^https?:\/\//, '').replace(/\/$/, '')
      : (svc.port ? `:${svc.port}` : '');
    const showStart = !svc.running && svc.canStart;
    const showStop = svc.running && svc.canStop;
    const control = showStart || showStop
      ? `<button class="btn small" data-svc="${esc(svc.id)}" data-action="${showStop ? 'stop' : 'start'}">${showStop ? 'Stop' : 'Start'}</button>`
      : '';
    const link = svc.url
      ? `<a class="btn small" href="${esc(svc.url)}" target="_blank" rel="noreferrer">Buka</a>`
      : '';
    return `
      <span class="badge ${svc.running ? 'green' : ''}" style="padding:6px 11px">
        <span class="dot ${svc.running ? 'on' : 'off'}" style="margin:0 0 0 2px"></span>
        ${esc(svc.label)} ${esc(note)}
      </span>
      ${control}${link}`;
  }).join('');

  $$('[data-svc]').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const result = await api('/api/services', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: btn.dataset.svc, action: btn.dataset.action }),
      });
      toast(result.output || 'Selesai');
      await loadStatus();
      await loadPorts();
    } catch (error) { toast(error.message, true); }
    btn.disabled = false;
  }));
}

// ------------------------------------------------------------ API tester
$('#apiSend').addEventListener('click', async () => {
  const target = $('#apiUrl').value.trim();
  if (!target) return toast('Isi URL dulu', true);
  let headers = {};
  const headerText = $('#apiHeaders').value.trim();
  if (headerText) {
    try { headers = JSON.parse(headerText); } catch { return toast('Headers bukan JSON valid', true); }
  }
  const method = $('#apiMethod').value;
  const body = ['GET', 'HEAD'].includes(method) ? undefined : $('#apiBody').value;
  const button = $('#apiSend');
  button.disabled = true;
  button.textContent = 'Mengirim…';
  $('#apiResponse').textContent = 'Menunggu response…';
  try {
    const data = await api('/api/http', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, url: target, headers, body, timeout: 15000 }),
    });
    const color = data.status >= 200 && data.status < 300 ? 'green' : data.status >= 400 ? 'amber' : '';
    $('#apiMeta').innerHTML = `
      <span class="badge ${color}">${data.status} ${esc(data.statusText)}</span>
      <span class="badge">${data.duration} ms</span>
      <span class="badge">${bytes(data.size)}</span>
      ${data.truncated ? '<span class="badge amber">dipotong 1 MB</span>' : ''}`;
    let bodyText = data.body || '(body kosong)';
    try { bodyText = JSON.stringify(JSON.parse(bodyText), null, 2); } catch {}
    $('#apiResponse').textContent = bodyText;
  } catch (error) {
    $('#apiMeta').innerHTML = '<span class="badge amber">error</span>';
    $('#apiResponse').textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Kirim';
  }
});

$('#apiUrl').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('#apiSend').click();
});

// ------------------------------------------------------------ download
async function updateDownloadNote() {
  $('#dlNote').textContent = 'Output ke ~/Downloads. Untuk situs streaming butuh yt-dlp.';
}

$('#dlBtn').addEventListener('click', async () => {
  const url = $('#dlUrl').value.trim();
  if (!url) return toast('Isi URL dulu', true);
  const button = $('#dlBtn');
  button.disabled = true;
  try {
    const result = await api('/api/download', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, mode: $('#dlMode').value }),
    });
    state.downloadJobId = result.job.id;
    setProgress($('#dlProgress'), $('#dlProgressBar'), 0, 'Menunggu antrian…');
    toast(`Download jalan: ${result.job.label}`);
    pollDownloadLog();
  } catch (error) {
    toast(error.message, true);
  }
  button.disabled = false;
});

async function pollDownloadLog() {
  clearInterval(state.dlTimer);
  const tick = async () => {
    try {
      const data = await api('/api/download/log');
      const box = $('#dlLog');
      box.textContent = data.log || '(kosong)';
      box.scrollTop = box.scrollHeight;
    } catch {}
  };
  await tick();
  state.dlTimer = setInterval(tick, 2000);
}

// ------------------------------------------------------------ config
async function loadConfig() {
  try {
    const [cfg, lan] = await Promise.all([api('/api/config'), api('/api/lan').catch(() => null)]);
    state.config = cfg;
    $('#cfgPort').value = cfg.port || 7070;
    $('#cfgDepth').value = cfg.scanDepth || 2;
    $('#cfgQuality').value = cfg.image?.quality ?? 75;
    $('#cfgMaxDim').value = cfg.image?.maxDim ?? 1920;
    $('#cfgPreset').value = cfg.video?.preset || '1080p';
    $('#cfgHost').value = cfg.host || '127.0.0.1';
    $('#cfgToken').value = cfg.accessToken || '';
    $('#cfgScanRoots').value = (cfg.scanRoots || []).join('\n');
    $('#cfgServices').value = JSON.stringify(cfg.services || [], null, 2);
    $('#cfgBackupTargets').value = JSON.stringify(cfg.backup?.targets || [], null, 2);
    $('#configNote').textContent = '';

    if (lan) {
      $('#lanInfo').innerHTML = `
        <div class="lan-row"><span>Status</span><span class="${lan.enabled ? 'badge green' : 'badge'}">${lan.enabled ? 'ON' : 'OFF'}</span></div>
        <div class="lan-row"><span>Host</span><code>${esc(lan.host)}</code></div>
        <div class="lan-row"><span>Password</span><code>${esc(lan.token || '(belum ada)')}</code></div>
        <div class="lan-row"><span>Lokal</span><code>http://127.0.0.1:${lan.port}</code></div>
        ${lan.addresses.map((address) => `<div class="lan-row"><span>LAN</span><code>http://${esc(address)}:${lan.port}</code></div>`).join('')}
        <div class="hint">Aktifkan/matikan dari terminal: <code>devhub lan on</code> / <code>devhub lan off</code>. Akses dari Mac ini tetap tanpa password.</div>`;
    }
  } catch (error) {
    toast(error.message, true);
  }
}

async function saveConfig() {
  let services, targets;
  try { services = JSON.parse($('#cfgServices').value || '[]'); } catch { return toast('Services bukan JSON valid', true); }
  try { targets = JSON.parse($('#cfgBackupTargets').value || '[]'); } catch { return toast('Backup targets bukan JSON valid', true); }
  const scanRoots = $('#cfgScanRoots').value.split('\n').map((line) => line.trim()).filter(Boolean);
  const token = ($('#cfgToken')?.value || '').trim();
  const patch = {
    port: Number($('#cfgPort').value),
    scanDepth: Number($('#cfgDepth').value),
    image: { quality: Number($('#cfgQuality').value), maxDim: Number($('#cfgMaxDim').value) },
    video: { preset: $('#cfgPreset').value },
    scanRoots,
    services,
    backup: { targets },
  };
  if (token) patch.accessToken = token;
  try {
    await api('/api/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    toast('Config disimpan');
    await loadConfig();
    await loadStatus();
    await loadTasks();
    if (state.view === 'backup') await loadBackups();
  } catch (error) {
    toast(error.message, true);
  }
}

$('#configSave').addEventListener('click', saveConfig);
$('#configSave2').addEventListener('click', saveConfig);

// ------------------------------------------------------------ init
(async function init() {
  renderFileChips();
  await loadStatus();
  await loadTasks();
  startJobStream();
  setInterval(loadStatus, 6000);
  setInterval(() => { if (state.view === 'tasks') loadTasks(); }, 6000);
})();
