export class FixedWindowRateLimiter {
  #buckets = new Map();
  #windowMs;
  #max;
  #now;

  constructor({ windowMs, max, now = Date.now }) {
    this.#windowMs = windowMs;
    this.#max = max;
    this.#now = now;
  }

  consume(key) {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + this.#windowMs };
      this.#buckets.set(key, bucket);
    }

    if (bucket.count >= this.#max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(bucket.expiresAt - now, 1),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.#max - bucket.count,
      retryAfterMs: 0,
    };
  }

  cleanup() {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (bucket.expiresAt <= now) this.#buckets.delete(key);
    }
  }

  get size() {
    return this.#buckets.size;
  }
}
