import { AppError } from './errors.mjs';

function degraded(reason) {
  return { status: 'degraded', reason };
}

export function createReadinessGate({
  check,
  ttlMs = 5_000,
  timeoutMs = 15_000,
  now = Date.now,
} = {}) {
  let cached = null;
  let inFlight = null;

  async function performCheck() {
    if (typeof check !== 'function') return degraded('READINESS_CHECK_NOT_CONFIGURED');
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => check()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('READINESS_TIMEOUT')), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (!result || typeof result !== 'object') return degraded('READINESS_RESPONSE_INVALID');
      return result.status === 'ready' ? { ...result, status: 'ready' } : { ...result, status: 'degraded' };
    } catch {
      return degraded('READINESS_CHECK_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  async function status({ force = false } = {}) {
    const currentTime = now();
    if (!force && cached && cached.expiresAt > currentTime) return cached.value;
    if (inFlight) return inFlight;
    inFlight = performCheck()
      .then((value) => {
        cached = { value, expiresAt: now() + ttlMs };
        return value;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  async function requireReady() {
    const value = await status();
    if (value.status !== 'ready') {
      throw new AppError('SERVICE_NOT_READY', undefined, 503, { reason: value.reason || 'DEPENDENCY_DEGRADED' });
    }
    return value;
  }

  return Object.freeze({
    status,
    requireReady,
    invalidate() { cached = null; },
  });
}
