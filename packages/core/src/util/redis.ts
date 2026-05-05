import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

/**
 * Return a singleton Upstash Redis REST client, or null if credentials are
 * not configured (in which case callers should treat the cache as a no-op).
 */
export function getRedis(): Redis | null {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

/**
 * Tiny "cache-aside" wrapper. If Redis isn't configured we just call the
 * factory (cache becomes a no-op). On any Redis error we log and fall
 * through to a fresh compute — the cache must never be a hard dependency.
 */
export async function cacheJson<T>(
  key: string,
  ttlSeconds: number,
  factory: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  if (!redis) return factory();
  try {
    const cached = await redis.get<T>(key);
    if (cached) return cached;
  } catch (err) {
    console.warn("[redis] get error, falling through", { key, err: String(err) });
  }
  const fresh = await factory();
  try {
    await redis.set(key, fresh, { ex: ttlSeconds });
  } catch (err) {
    console.warn("[redis] set error, ignoring", { key, err: String(err) });
  }
  return fresh;
}

/** Useful for tests and local dev — clears whatever ContextSignal keys exist. */
export async function flushNamespace(prefix: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length === 0) return;
  await redis.del(...keys);
}
