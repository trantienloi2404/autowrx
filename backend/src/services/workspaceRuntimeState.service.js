// Copyright (c) 2025 Eclipse Foundation.
//
// This program and the accompanying materials are made available under the
// terms of the MIT License which is available at
// https://opensource.org/licenses/MIT.
//
// SPDX-License-Identifier: MIT

/**
 * Runtime state for workspace runs (stdout-derived APIs, status, log tail).
 * Held in process memory only — cleared on backend restart and expired entries by TTL.
 */

const KEY_TTL_SECONDS = Number(process.env.RUNTIME_STATE_TTL_SECONDS || 24 * 60 * 60);
const MAX_APP_LOG_BYTES = Number(process.env.RUNTIME_APP_LOG_MAX_BYTES || 256 * 1024);

const memoryState = new Map();

const nowIso = () => new Date().toISOString();

const ensureAppLogSize = (text) => {
  const value = String(text || '');
  if (Buffer.byteLength(value, 'utf8') <= MAX_APP_LOG_BYTES) return value;
  const buf = Buffer.from(value, 'utf8');
  return buf.subarray(buf.length - MAX_APP_LOG_BYTES).toString('utf8');
};

const ensureMemoryEntry = (workspaceId) => {
  const key = String(workspaceId);
  let entry = memoryState.get(key);
  if (!entry) {
    entry = {
      signals: {},
      traceVars: {},
      appLog: '',
      status: 'connecting',
      updatedAt: nowIso(),
      expireAtMs: Date.now() + KEY_TTL_SECONDS * 1000,
    };
    memoryState.set(key, entry);
  }
  entry.expireAtMs = Date.now() + KEY_TTL_SECONDS * 1000;
  return entry;
};

const cleanupExpiredMemory = () => {
  const now = Date.now();
  memoryState.forEach((entry, key) => {
    if ((entry?.expireAtMs || 0) < now) memoryState.delete(key);
  });
};

const appendToAppLog = (workspaceId, text) => {
  if (!text) return;
  const entry = ensureMemoryEntry(workspaceId);
  entry.appLog = ensureAppLogSize(`${entry.appLog || ''}${text}`);
};

const setStatus = (workspaceId, status) => {
  const entry = ensureMemoryEntry(workspaceId);
  entry.status = String(status || '');
  entry.updatedAt = nowIso();
};

const ingestRunnerPayload = async (workspaceId, payload) => {
  if (!workspaceId || !payload || typeof payload !== 'object') return;
  cleanupExpiredMemory();
  const type = String(payload.type || '');
  if (!type) return;

  if (type === 'run.output') {
    const text = String(payload.data || '');
    if (text) {
      appendToAppLog(workspaceId, text);
    }
    setStatus(workspaceId, 'running');
    return;
  }
  if (type === 'run.waiting_input') {
    setStatus(workspaceId, 'waiting_input');
    return;
  }
  if (type === 'run.started') {
    setStatus(workspaceId, 'running');
    return;
  }
  if (type === 'run.error') {
    const message = String(payload.message || payload.error || payload.data || 'Runner error');
    appendToAppLog(workspaceId, `\n[run.error] ${message}\n`);
    setStatus(workspaceId, 'error');
    return;
  }
  if (type === 'run.exit') {
    const summary = `\n[run.exit] code=${payload.code} signal=${payload.signal || 'none'}\n`;
    appendToAppLog(workspaceId, summary);
    setStatus(workspaceId, 'exited');
  }
};

const getRuntimeStateSnapshot = async (workspaceId) => {
  if (!workspaceId) {
    return {
      apisValue: {},
      traceVars: {},
      appLog: '',
      status: 'connecting',
      updatedAt: nowIso(),
    };
  }

  cleanupExpiredMemory();
  const entry = ensureMemoryEntry(workspaceId);
  return {
    apisValue: entry.signals || {},
    traceVars: entry.traceVars || {},
    appLog: String(entry.appLog || ''),
    status: String(entry.status || 'connecting'),
    updatedAt: String(entry.updatedAt || nowIso()),
  };
};

module.exports = {
  ingestRunnerPayload,
  getRuntimeStateSnapshot,
};
