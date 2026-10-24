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
};

const VIEW_META = {
  compress: ['Kompres Media', 'Foto & video — pakai sips/avconvert di macOS, ffmpeg di Linux/Windows.'],
  tasks: ['Tugas & Project', 'Project terdeteksi otomatis, plus tugas manual. Run/stop tanpa pindah terminal.'],
  ports: ['Server & Port', 'Lihat yang sedang listen, matikan proses nyangkut, kontrol layanan lokal.'],
  git: ['Git Helper', 'Status, commit, pull, push untuk project lokal.'],
  download: ['Downloader', 'Download video/audio/file langsung ke folder Downloads.'],
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
  const units = ['B', 'KB', 'MB', 'GB'];
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function switchView(view) {
  state.view = view;
  $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  const [title, sub] = VIEW_META[view];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  if (view === 'ports') loadPorts();
  if (view === 'git') loadGitProjects();
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
  $('#results').innerHTML = results.map((result) => {
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
    const data = await api('/api/compress/path', {
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
    renderResults(data.results);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

// ------------------------------------------------------------ tasks
async function loadTasks() {
  try {
    state.tasks = await api('/api/tasks');
    renderTasks();
    fillGitProjects();
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

// ------------------------------------------------------------ git
function fillGitProjects() {
  const select = $('#gitProject');
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
    $('#gitBody').innerHTML = `
      <div class="git-status">
        <div class="stat"><div class="k">Branch</div><div class="v" style="color:var(--accent)">${esc(info.branch)}</div></div>
        <div class="stat"><div class="k">Ahead / Behind</div><div class="v">${info.ahead} / ${info.behind}</div></div>
        <div class="stat"><div class="k">Perubahan</div><div class="v">${info.files.length} file</div></div>
      </div>
      <div class="stat" style="margin-bottom:14px">
        <div class="k">Commit terakhir</div>
        <div class="v" style="font-size:12.5px">${esc(info.last.hash)} · ${esc(info.last.subject)}</div>
        <div class="hint">${esc(info.last.author)} · ${esc(info.last.when)}</div>
      </div>
      ${info.files.length ? `<div class="file-list">${info.files.map((f) => `<div><span class="st">${esc(f.status.trim() || '·')}</span><span>${esc(f.file)}</span></div>`).join('')}</div>` : '<div class="hint">Working tree bersih.</div>'}
      <div class="row" style="margin-top:16px">
        <input class="input" id="gitMessage" style="flex:1;min-width:220px" placeholder="Pesan commit…" />
        <button class="btn primary" data-git="commit">Commit all</button>
        <button class="btn" data-git="pull">Pull</button>
        <button class="btn" data-git="push">Push</button>
      </div>
      <pre class="log-box" id="gitOutput" style="margin-top:14px;display:none"></pre>
    `;
    $$('[data-git]').forEach((btn) => btn.addEventListener('click', async () => {
      btn.disabled = true;
      const action = btn.dataset.git;
      try {
        const result = await api('/api/git', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: dir, action, message: $('#gitMessage')?.value }),
        });
        const output = $('#gitOutput');
        output.style.display = 'block';
        output.textContent = `$ git ${action}\n${result.output || '(ok)'}`;
        toast('Git: ' + action);
        await loadGit();
      } catch (error) {
        const output = $('#gitOutput');
        output.style.display = 'block';
        output.textContent = error.message;
        toast(error.message, true);
      }
      btn.disabled = false;
    }));
  } catch (error) {
    $('#gitBody').innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
  }
}

$('#gitProject').addEventListener('change', loadGit);
$('#gitRefresh').addEventListener('click', loadGit);

// ------------------------------------------------------------ download
async function updateDownloadNote() {
  try {
    const info = await api('/api/status');
    $('#dlNote').textContent = 'Output ke ~/Downloads. Untuk situs streaming butuh yt-dlp.';
    void info;
  } catch {}
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
    toast(`Download jalan (PID ${result.pid})`);
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

// ------------------------------------------------------------ init
(async function init() {
  renderFileChips();
  await loadStatus();
  await loadTasks();
  setInterval(loadStatus, 6000);
  setInterval(() => { if (state.view === 'tasks') loadTasks(); }, 6000);
})();
