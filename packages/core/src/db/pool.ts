import pg from "pg";
import dns from "node:dns/promises";

/**
 * Override pg's default DATE (OID 1082) parser. Default behaviour parses
 * 'YYYY-MM-DD' through `new Date(...)` which interprets it as midnight
 * LOCAL time, then `.toISOString().slice(0,10)` shifts it by one day on
 * any host whose timezone is east of UTC. We don't want that; we want the
 * raw string. This must run before any pool is constructed.
 */
pg.types.setTypeParser(1082, (val: string) => val);

/**
 * Build a Postgres pool that works reliably from networks where Node's
 * Happy-Eyeballs connector struggles with mixed IPv4/IPv6 results.
 *
 * Specifically, Neon publishes both A and AAAA records for its pooler
 * subdomains, but on many ISPs (and inside Railway's network in some
 * regions) IPv6 routes are broken. Node's `net.connect(host, port)` will
 * try IPv6 first, fail fast with ENETUNREACH, and AggregateError out
 * before IPv4 succeeds.
 *
 * Workaround: pre-resolve the hostname to an IPv4 ourselves and pass
 * { host: <ip>, ssl: { servername: <original-host> } } so SNI is preserved.
 */

const { Pool } = pg;
type PoolType = pg.Pool;

let cachedPool: PoolType | null = null;

interface ParsedConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslmode: string | null;
}

function parseConnString(conn: string): ParsedConn {
  const u = new URL(conn);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, "") || "postgres",
    sslmode: u.searchParams.get("sslmode"),
  };
}

function needsSsl(parsed: ParsedConn): boolean {
  if (parsed.sslmode && parsed.sslmode !== "disable") return true;
  if (parsed.host.endsWith(".neon.tech") || parsed.host.endsWith(".aws.neon.tech")) return true;
  return false;
}

async function resolveIpv4(hostname: string): Promise<string> {
  // Skip if it's already an IP literal.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return hostname;
  const records = await dns.resolve4(hostname).catch(async () => {
    // Fallback to dns.lookup with family:4 if A query is blocked.
    const r = await dns.lookup(hostname, { family: 4, all: true });
    return r.map((x) => x.address);
  });
  if (records.length === 0) {
    throw new Error(`No IPv4 records for ${hostname}`);
  }
  // Filter out 100.x CGNAT addresses since they sometimes black-hole on
  // user-side networks. Fall back to whatever's available if filtering
  // would leave us with nothing.
  const publicIps = records.filter((r) => !r.startsWith("100."));
  return (publicIps.length > 0 ? publicIps : records)[0]!;
}

/**
 * Return a singleton Postgres pool. Connection-string-based, IPv4-pinned,
 * SNI-preserving.
 */
export async function getPoolAsync(connectionString?: string): Promise<PoolType> {
  if (cachedPool) return cachedPool;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your .env or Railway service variables.",
    );
  }
  const parsed = parseConnString(url);
  const ipv4 = await resolveIpv4(parsed.host).catch(() => parsed.host);

  cachedPool = new Pool({
    host: ipv4,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl(parsed)
      ? { rejectUnauthorized: false, servername: parsed.host }
      : undefined,
  });
  cachedPool.on("error", (err) => {
    console.error("[pg-pool] unexpected error", err);
  });
  return cachedPool;
}

/**
 * Synchronous wrapper that lazily kicks off resolution. Most callers can
 * await getPoolAsync() instead — but we keep this for places that already
 * use the sync API.
 */
export function getPool(connectionString?: string): PoolType {
  if (cachedPool) return cachedPool;
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your .env or Railway service variables.",
    );
  }
  const parsed = parseConnString(url);
  // Synchronous fallback: use the hostname directly. Subsequent connection
  // attempts will resolve via Node's resolver. This still works on hosts
  // with healthy IPv4-or-IPv6 connectivity (Railway, most CI).
  cachedPool = new Pool({
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: needsSsl(parsed)
      ? { rejectUnauthorized: false, servername: parsed.host }
      : undefined,
  });
  cachedPool.on("error", (err) => {
    console.error("[pg-pool] unexpected error", err);
  });
  return cachedPool;
}

export async function closePool(): Promise<void> {
  if (cachedPool) {
    await cachedPool.end();
    cachedPool = null;
  }
}
