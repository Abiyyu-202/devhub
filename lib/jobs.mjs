// In-memory background job queue with progress + SSE events.
import crypto from 'node:crypto';

const jobs = new Map();
const queue = [];
const listeners = new Set();
const MAX_ACTIVE = 2;
let active = 0;

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    progress: Math.round(job.progress || 0),
    message: job.message || '',
    result: job.result ?? null,
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
  };
}

function emit() {
  const snapshot = listJobs();
  for (const listener of listeners) {
    try { listener(snapshot); } catch {}
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicJob);
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

export function createJob({ type, label, run }) {
  const job = {
    id: crypto.randomUUID(),
    type: type || 'task',
    label: label || 'Job',
    status: 'queued',
    progress: 0,
    message: 'Menunggu antrian…',
    result: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    _run: run,
    _controller: null,
  };
  jobs.set(job.id, job);
  queue.push(job);
  prune();
  emit();
  pump();
  return publicJob(job);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === 'queued') {
    const index = queue.indexOf(job);
    if (index !== -1) queue.splice(index, 1);
    job.status = 'canceled';
    job.message = 'Dibatalkan sebelum jalan';
    job.finishedAt = Date.now();
    emit();
    return true;
  }
  if (job.status === 'running' && job._controller) {
    job._controller.abort();
    return true;
  }
  return false;
}

function prune() {
  const finished = [...jobs.values()]
    .filter((job) => ['done', 'error', 'canceled'].includes(job.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const job of finished.slice(40)) jobs.delete(job.id);
}

async function runJob(job) {
  job.status = 'running';
  job.startedAt = Date.now();
  job.message = 'Mulai…';
  job._controller = new AbortController();
  emit();

  const progress = (value, message) => {
    if (job.status !== 'running') return;
    const next = Number(value);
    if (Number.isFinite(next)) job.progress = Math.max(job.progress, Math.min(100, next));
    if (message) job.message = message;
    emit();
  };

  try {
    const result = await job._run({ progress, signal: job._controller.signal, job });
    if (job._controller.signal.aborted) {
      job.status = 'canceled';
      job.message = 'Dibatalkan';
    } else {
      job.status = 'done';
      job.progress = 100;
      job.message = 'Selesai';
      job.result = result ?? null;
    }
  } catch (error) {
    if (job._controller.signal.aborted) {
      job.status = 'canceled';
      job.message = 'Dibatalkan';
    } else {
      job.status = 'error';
      job.error = error.message;
      job.message = error.message;
    }
  } finally {
    job.finishedAt = Date.now();
    job._controller = null;
    job._run = null;
    active -= 1;
    emit();
    pump();
  }
}

function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active += 1;
    runJob(job);
  }
}
