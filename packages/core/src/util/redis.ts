import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

/**
 * Return a singleton Upstash Redis REST client, or null if credentials are
 * not configured (in which case callers should treat the cache as a no-op).
 */
export function getRedis(): Redis | null {
  if (cached) return cached;
  const rawUrl = process.env.UPSTASH_REDIS_REST_URL;
  const rawToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!rawUrl || !rawToken) return null;
  // Defensive: copying secrets from dashboards (Upstash, Railway) very
  // commonly leaves a trailing newline or surrounding quotes. Upstash's
  // own client warns about it but still happily attempts auth, which then
  // fails opaquely. Trim outer whitespace + matching quotes here so a
  // pasted-with-newline token still works.
  const url = stripQuotes(rawUrl.trim());
  const token = stripQuotes(rawToken.trim());
  if (/\s/.test(token)) {
    console.warn(
      "[redis] UPSTASH_REDIS_REST_TOKEN contains internal whitespace after trim; cache will likely fail to authenticate. Re-paste the token without line breaks.",
    );
  }
  if (/\s/.test(url)) {
    console.warn(
      "[redis] UPSTASH_REDIS_REST_URL contains internal whitespace after trim; cache will likely fail to authenticate.",
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
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
