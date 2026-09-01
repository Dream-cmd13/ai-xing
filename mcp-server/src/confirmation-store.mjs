import { createHash, randomBytes } from 'node:crypto';

function canonicalJson(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('不能摘要非有限数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('不能摘要该参数类型');
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function computeArgsDigest(toolName, args) {
  if (typeof toolName !== 'string' || !toolName.trim()) throw new TypeError('toolName 必须是非空字符串');
  return createHash('sha256')
    .update(toolName, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(args), 'utf8')
    .digest('hex');
}

function cloneMetadata(metadata) {
  if (metadata === undefined) return undefined;
  return structuredClone(metadata);
}

export class ConfirmationStore {
  #tokens = new Map();
  #consumed = new Map();
  #ttlMs;
  #now;

  constructor({ ttlMs, now = Date.now }) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs 必须是正整数');
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  issue({ userId, sessionId, toolName, argsDigest, metadata }) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tokens.set(hashToken(token), {
      userId,
      sessionId,
      toolName,
      argsDigest,
      requestId: null,
      metadata: cloneMetadata(metadata),
      expiresAt,
      state: 'issued',
    });
    return { token, expiresAt };
  }

  begin({ userId, sessionId, toolName, argsDigest, token, requestId }) {
    if (typeof token !== 'string' || !token) return { valid: false, reason: 'UNKNOWN' };
    const tokenHash = hashToken(token);
    const consumedUntil = this.#consumed.get(tokenHash);
    if (consumedUntil !== undefined) {
      if (consumedUntil > this.#now()) return { valid: false, reason: 'CONSUMED' };
      this.#consumed.delete(tokenHash);
    }

    const record = this.#tokens.get(tokenHash);
    if (!record) return { valid: false, reason: 'UNKNOWN' };
    if (record.expiresAt <= this.#now()) {
      this.#tokens.delete(tokenHash);
      return { valid: false, reason: 'EXPIRED' };
    }
    if (record.userId !== userId) return { valid: false, reason: 'USER_MISMATCH' };
    if (record.sessionId !== sessionId) return { valid: false, reason: 'SESSION_MISMATCH' };
    if (record.toolName !== toolName) return { valid: false, reason: 'TOOL_MISMATCH' };
    if (record.argsDigest !== argsDigest) return { valid: false, reason: 'ARGS_MISMATCH' };
    if (record.requestId !== null && record.requestId !== requestId) {
      return { valid: false, reason: 'REQUEST_ID_MISMATCH' };
    }
    if (record.requestId === null && requestId !== undefined) record.requestId = requestId;
    if (record.state === 'in_flight') return { valid: false, reason: 'IN_FLIGHT' };

    record.state = 'in_flight';
    return { valid: true, metadata: cloneMetadata(record.metadata) };
  }

  peek({ userId, sessionId, toolName, token }) {
    if (typeof token !== 'string' || !token) return null;
    const record = this.#tokens.get(hashToken(token));
    if (!record || record.expiresAt <= this.#now()) return null;
    if (record.userId !== userId || record.sessionId !== sessionId || record.toolName !== toolName) return null;
    return cloneMetadata(record.metadata) ?? {};
  }

  rollback({ token }) {
    if (typeof token !== 'string' || !token) return false;
    const record = this.#tokens.get(hashToken(token));
    if (!record || record.state !== 'in_flight' || record.expiresAt <= this.#now()) return false;
    record.state = 'issued';
    return true;
  }

  finalize({ token }) {
    if (typeof token !== 'string' || !token) return false;
    const tokenHash = hashToken(token);
    const record = this.#tokens.get(tokenHash);
    if (!record || record.state !== 'in_flight') return false;
    this.#tokens.delete(tokenHash);
    this.#consumed.set(tokenHash, record.expiresAt);
    return true;
  }

  revokeSession(sessionId) {
    let removed = 0;
    for (const [tokenHash, record] of this.#tokens) {
      if (record.sessionId === sessionId) {
        this.#tokens.delete(tokenHash);
        removed += 1;
      }
    }
    return removed;
  }

  cleanupExpired() {
    const now = this.#now();
    let removed = 0;
    for (const [tokenHash, record] of this.#tokens) {
      if (record.expiresAt <= now) {
        this.#tokens.delete(tokenHash);
        removed += 1;
      }
    }
    for (const [tokenHash, expiresAt] of this.#consumed) {
      if (expiresAt <= now) {
        this.#consumed.delete(tokenHash);
        removed += 1;
      }
    }
    return removed;
  }

  get size() {
    return this.#tokens.size;
  }
}
