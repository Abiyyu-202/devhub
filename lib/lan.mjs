// LAN mode helpers: address detection, token auth, loopback checks.
import os from 'node:os';
import crypto from 'node:crypto';

export function isLoopback(address) {
  const value = String(address || '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').toLowerCase());
}

export function makeToken(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function lanAddresses() {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      addresses.push(info.address);
    }
  }
  return [...new Set(addresses)];
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function parseBasicAuth(header) {
  const raw = String(header || '');
  if (!/^basic\s+/i.test(raw)) return null;
  try {
    const decoded = Buffer.from(raw.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    if (index === -1) return null;
    return { user: decoded.slice(0, index), password: decoded.slice(index + 1) };
  } catch {
    return null;
  }
}

// Accepts Basic Auth (any username) or X-DevHub-Token.
export function authorized(req, token) {
  if (!token) return false;
  const headerToken = req.headers['x-devhub-token'];
  if (headerToken && safeEqual(headerToken, token)) return true;
  const basic = parseBasicAuth(req.headers.authorization);
  return Boolean(basic && safeEqual(basic.password, token));
}

export function basicAuthHeader(token, user = 'devhub') {
  return `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
}

export function maskToken(token) {
  const value = String(token || '');
  if (!value) return '(belum ada)';
  if (value.length <= 8) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
