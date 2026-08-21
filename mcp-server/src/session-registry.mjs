import { randomUUID } from 'node:crypto';

import { sessionExpired } from './errors.mjs';

export function createSessionId() {
  return randomUUID();
}

async function closeQuietly(resource) {
  if (typeof resource?.close !== 'function') return;
  try {
    await resource.close();
  } catch {
    // Cleanup must not expose SDK, token or transport errors to callers.
  }
}

export class SessionRegistry {
  #sessions = new Map();
  #ttlMs;
  #refreshWindowMs;
  #authProvider;
  #now;

  constructor({ ttlMs, refreshWindowMs, authProvider, now = Date.now }) {
    this.#ttlMs = ttlMs;
    this.#refreshWindowMs = refreshWindowMs;
    this.#authProvider = authProvider;
    this.#now = now;
  }

  register(sessionId, record) {
    if (!sessionId || this.#sessions.has(sessionId)) throw new Error('MCP session id 已存在或无效');
    this.#sessions.set(sessionId, {
      transport: record.transport,
      server: record.server,
      context: { ...record.context },
      expiresAt: this.#now() + this.#ttlMs,
    });
  }

  get(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  async ensureReady(sessionId) {
    const record = this.#sessions.get(sessionId);
    if (!record || record.expiresAt <= this.#now()) {
      if (record) await this.remove(sessionId);
      throw sessionExpired();
    }

    if (record.context.tokenExpiresAt <= this.#now() + this.#refreshWindowMs) {
      if (!this.#authProvider?.refresh) {
        await this.remove(sessionId);
        throw sessionExpired();
      }
      try {
        record.context = await this.#authProvider.refresh(record.context);
      } catch {
        await this.remove(sessionId);
        throw sessionExpired();
      }
    }

    return record;
  }

  async remove(sessionId) {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#sessions.delete(sessionId);
    await closeQuietly(record.transport);
    await closeQuietly(record.server);
    return true;
  }

  handleTransportClosed(sessionId) {
    return this.#sessions.delete(sessionId);
  }

  async cleanupExpired() {
    const now = this.#now();
    const expiredIds = [];
    for (const [sessionId, record] of this.#sessions) {
      if (record.expiresAt <= now) expiredIds.push(sessionId);
    }
    await Promise.all(expiredIds.map((sessionId) => this.remove(sessionId)));
  }

  async closeAll() {
    const ids = [...this.#sessions.keys()];
    await Promise.all(ids.map((sessionId) => this.remove(sessionId)));
  }

  get size() {
    return this.#sessions.size;
  }
}
