// Driveway Metrics Worker
// POST /api/metrics  — receive hourly snapshot from Pi
// GET  /today        — today's latest totals          (1 KV read, no cache needed)
// GET  /hourly       — today's intraday snapshots     (cached 5 min in KV)
// GET  /dashboard    — last 30 days                   (cached 10 min in KV)
//
// KV operation budget (free tier: 100k reads, 1k writes, 1k lists per day)
// -------------------------------------------------------------------------
// Before caching: every dashboard page load = 2 lists + up to 55 reads.
// With one browser tab refreshing every 5 min: ~1,400 ops/day per tab.
//
// After caching: every load = 1 read (cache hit) for /hourly and /dashboard.
// Cache misses happen at most once per TTL window across ALL tabs because
// the cache lives in KV (shared), not in per-request Worker memory.
//
// Worst-case daily ops (one tab, 5-min refresh, Pi uploading hourly):
//   /today:          288 reads
//   /hourly hits:    276 reads  |  misses: 12 × (1 list + 24 reads + 1 write) = 312 ops
//   /dashboard hits: 282 reads  |  misses:  6 × (1 list + 30 reads + 1 write) = 192 ops
//   Pi uploads:      24 writes + 24 hourly keys + 24×2 cache deletes = 96 writes
//   Total:           ~1,350 ops/day  (vs. ~55,000/day before caching)

export interface Env {
  DRIVEWAY_METRICS: KVNamespace;
  CLOUDFLARE_TOKEN: string; // Worker secret shared with the Pi (wrangler secret put)
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// How long to cache each expensive endpoint's response in KV.
// These are upper bounds — caches are also invalidated immediately on
// every Pi upload so the dashboard never shows stale data after a sync.
const HOURLY_CACHE_TTL_SEC = 5 * 60;    // 5 minutes
const DASHBOARD_CACHE_TTL_SEC = 10 * 60; // 10 minutes

const cacheKeyHourly = (date: string) => `cache:hourly:${date}`;
const cacheKeyDashboard = () => `cache:dashboard`;

// ---------------------------------------------------------------------------
// cachedResponse — serve from KV cache or recompute and store
// 1 read on hit; 1 list + N reads + 1 write on miss
// ---------------------------------------------------------------------------
async function cachedResponse(
  cacheKey: string,
  ttlSec: number,
  compute: () => Promise<unknown>,
  env: Env,
): Promise<Response> {
  const cached = await env.DRIVEWAY_METRICS.get(cacheKey, { type: 'json' });
  if (cached !== null) {
    return Response.json(cached, {
      headers: { ...corsHeaders, 'X-Cache': 'HIT' },
    });
  }

  const data = await compute();
  await env.DRIVEWAY_METRICS.put(cacheKey, JSON.stringify(data), {
    expirationTtl: ttlSec,
  });
  return Response.json(data, {
    headers: { ...corsHeaders, 'X-Cache': 'MISS' },
  });
}

// ---------------------------------------------------------------------------
// isAuthorized — constant-time compare of the Bearer token against the secret
// Fails closed if the CLOUDFLARE_TOKEN secret is not configured.
// ---------------------------------------------------------------------------
function isAuthorized(request: Request, env: Env): boolean {
  const header = request.headers.get('Authorization') ?? '';
  if (!env.CLOUDFLARE_TOKEN || !header.startsWith('Bearer ')) return false;
  const encoder = new TextEncoder();
  const given = encoder.encode(header.slice('Bearer '.length));
  const expected = encoder.encode(env.CLOUDFLARE_TOKEN);
  if (given.byteLength !== expected.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, expected);
}

// ---------------------------------------------------------------------------
// invalidateCaches — called after every Pi write so next load is fresh
// Costs 2 deletes (free tier: deletes count as writes, but 24/day is trivial)
// ---------------------------------------------------------------------------
async function invalidateCaches(date: string, env: Env): Promise<void> {
  await Promise.all([
    env.DRIVEWAY_METRICS.delete(cacheKeyHourly(date)),
    env.DRIVEWAY_METRICS.delete(cacheKeyDashboard()),
  ]);
}

// ---------------------------------------------------------------------------
// computeHourly — called only on cache miss
// Cost: 1 list + N reads (N = hours uploaded today, max 24)
// ---------------------------------------------------------------------------
async function computeHourly(
  date: string,
  env: Env,
): Promise<{ date: string; snapshots: { hour: number; entries: number; exits: number }[] }> {
  const list = await env.DRIVEWAY_METRICS.list({ prefix: `hourly:${date}:` });
  const snapshots = await Promise.all(
    list.keys.map(async (k: KVNamespaceListKey<unknown>) => {
      const v: any = await env.DRIVEWAY_METRICS.get(k.name, { type: 'json' });
      return {
        hour: v?.hour ?? parseInt(k.name.split(':')[3], 10),
        entries: v?.entries || 0,
        exits: v?.exits || 0,
      };
    }),
  );
  snapshots.sort((a, b) => a.hour - b.hour);
  return { date, snapshots };
}

// ---------------------------------------------------------------------------
// computeDashboard — called only on cache miss
// Cost: 1 list + N reads (N = days with data, max 30)
// ---------------------------------------------------------------------------
async function computeDashboard(
  env: Env,
): Promise<{ date: string; entries: number; exits: number }[]> {
  // KV list returns keys in ascending lexicographic order (= chronological for
  // date keys). We must NOT use limit:30 here — that would return the 30 OLDEST
  // days. Instead list all and slice the last 30 to get the most recent 30.
  const list = await env.DRIVEWAY_METRICS.list({ prefix: 'driveway:' });
  const keys = list.keys.slice(-30);
  const metrics = await Promise.all(
    keys.map(async (k: KVNamespaceListKey<unknown>) => {
      const v: any = await env.DRIVEWAY_METRICS.get(k.name, { type: 'json' });
      return {
        date: k.name.split(':')[1],
        entries: v?.entries || 0,
        exits: v?.exits || 0,
      };
    }),
  );
  // Already ascending from KV; reverse for newest-first ordering expected by
  // the dashboard JS (which reverses again to render oldest→newest on the chart).
  return metrics.reverse();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ------------------------------------------------------------------
    // POST /api/metrics — Pi hourly upload
    // Writes: 1 conditional daily key + 1 hourly key + 2 cache deletes
    // ------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/api/metrics') {
      if (!isAuthorized(request, env)) {
        return new Response('Unauthorized', { status: 401, headers: corsHeaders });
      }

      try {
        const { key, value }: { key: string; value: any } = await request.json();
        if (!key || !value) {
          return new Response('Missing key/value', { status: 400, headers: corsHeaders });
        }

        const date: string = value.date || key.split(':')[1];
        const entries: number = value.entries || 0;
        const exits: number = value.exits || 0;

        // 1. Daily key — only overwrite if this snapshot has equal-or-higher
        //    counts, so a post-restart zero upload can't clobber real data.
        const existing: any = await env.DRIVEWAY_METRICS.get(
          `driveway:${date}`, { type: 'json' },
        );
        if (!existing || entries >= (existing.entries || 0)) {
          await env.DRIVEWAY_METRICS.put(
            `driveway:${date}`,
            JSON.stringify({ date, entries, exits }),
          );
        }

        // 2. Hourly snapshot (expires after 48 h, keeps KV tidy automatically)
        const hour: number = value.hour ?? new Date().getUTCHours();
        const hourStr: string = String(hour).padStart(2, '0');
        await env.DRIVEWAY_METRICS.put(
          `hourly:${date}:${hourStr}`,
          JSON.stringify({ hour, entries, exits }),
          { expirationTtl: 60 * 60 * 48 },
        );

        // 3. Bust caches so next browser load sees fresh data immediately
        await invalidateCaches(date, env);

        return new Response('Metrics stored OK', { status: 200, headers: corsHeaders });
      } catch (_e) {
        return new Response('JSON parse error', { status: 400, headers: corsHeaders });
      }
    }

    // ------------------------------------------------------------------
    // GET /today — always live (1 read); no caching needed, it's already cheap
    // ------------------------------------------------------------------
    if (url.pathname === '/today') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const data: any = await env.DRIVEWAY_METRICS.get(
        `driveway:${date}`, { type: 'json' },
      );
      return Response.json(
        { date, entries: data?.entries || 0, exits: data?.exits || 0 },
        { headers: corsHeaders },
      );
    }

    // ------------------------------------------------------------------
    // GET /hourly — cached 5 min; miss costs 1 list + ≤24 reads + 1 write
    // ------------------------------------------------------------------
    if (url.pathname === '/hourly') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      return cachedResponse(
        cacheKeyHourly(date),
        HOURLY_CACHE_TTL_SEC,
        () => computeHourly(date, env),
        env,
      );
    }

    // ------------------------------------------------------------------
    // GET /dashboard — cached 10 min; miss costs 1 list + ≤30 reads + 1 write
    // ------------------------------------------------------------------
    if (url.pathname === '/dashboard') {
      return cachedResponse(
        cacheKeyDashboard(),
        DASHBOARD_CACHE_TTL_SEC,
        () => computeDashboard(env),
        env,
      );
    }

    return new Response(
      'Endpoints: /today, /hourly, /dashboard, POST /api/metrics',
      { status: 404, headers: corsHeaders },
    );
  },
};