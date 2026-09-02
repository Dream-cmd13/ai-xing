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
  #onSessionDestroyed;
  #destroyedSessions = new Set();
  #refreshInFlight = new Map();

  constructor({ ttlMs, refreshWindowMs, authProvider, now = Date.now, onSessionDestroyed = null }) {
    this.#ttlMs = ttlMs;
    this.#refreshWindowMs = refreshWindowMs;
    this.#authProvider = authProvider;
    this.#now = now;
    this.#onSessionDestroyed = typeof onSessionDestroyed === 'function' ? onSessionDestroyed : null;
  }

  #notifyDestroyed(sessionId) {
    if (this.#destroyedSessions.has(sessionId)) return;
    this.#destroyedSessions.add(sessionId);
    try {
      const result = this.#onSessionDestroyed?.(sessionId);
      result?.catch?.(() => {});
    } catch {
      // Session cleanup must not expose callback failures to MCP callers.
    }
  }

  register(sessionId, record) {
    if (!sessionId || this.#sessions.has(sessionId)) throw new Error('MCP session id 已存在或无效');
    this.#destroyedSessions.delete(sessionId);
    this.#sessions.set(sessionId, {
      transport: record.transport,
      server: record.server,
      context: { ...record.context },
      expiresAt: this.#now() + this.#ttlMs,
    });
  }

  setOnSessionDestroyed(callback) {
    this.#onSessionDestroyed = typeof callback === 'function' ? callback : null;
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
      await this.#refreshSession(sessionId, record);
    }

    return record;
  }

  // 并发请求共享同一次刷新：旋转式 refresh token 被并发消费会导致刷新互相失效，
  // 进而误删仍有效的会话。这里用单飞（single-flight）保证同一会话同一时刻只刷新一次。
  async #refreshSession(sessionId, record) {
    if (!this.#authProvider?.refresh) {
      await this.remove(sessionId);
      throw sessionExpired();
    }
    if (!this.#refreshInFlight.has(sessionId)) {
      const pending = this.#authProvider.refresh(record.context)
        .then((context) => {
          record.context = context;
        })
        .finally(() => {
          this.#refreshInFlight.delete(sessionId);
        });
      this.#refreshInFlight.set(sessionId, pending);
    }
    try {
      await this.#refreshInFlight.get(sessionId);
    } catch {
      await this.remove(sessionId);
      throw sessionExpired();
    }
  }

  async remove(sessionId) {
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    this.#sessions.delete(sessionId);
    await closeQuietly(record.transport);
    await closeQuietly(record.server);
    this.#notifyDestroyed(sessionId);
    return true;
  }

  handleTransportClosed(sessionId) {
    const removed = this.#sessions.delete(sessionId);
    if (removed) this.#notifyDestroyed(sessionId);
    return removed;
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
