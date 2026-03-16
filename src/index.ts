// Driveway Metrics Worker
// POST /api/metrics  — receive hourly snapshot from Pi
// GET  /today        — today's latest totals
// GET  /hourly       — today's intraday snapshots
// GET  /dashboard    — last 30 days (one read per day)

export interface Env {
  DRIVEWAY_METRICS: KVNamespace;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /api/metrics
    // Writes three keys per upload — all aggregation happens here on write,
    // so read-path endpoints stay cheap (1 read each).
    if (request.method === 'POST' && url.pathname === '/api/metrics') {
      try {
        const { key, value }: { key: string; value: any } = await request.json();
        if (!key || !value) {
          return new Response('Missing key/value', { status: 400, headers: corsHeaders });
        }

        const date: string = value.date || key.split(':')[1];
        const entries: number = value.entries || 0;
        const exits: number = value.exits || 0;

        // 1. Daily peak key — only update if this snapshot has higher counts.
        //    This means the daily key always reflects the highest seen value,
        //    surviving service restarts that temporarily report lower counts.
        const existing: any = await env.DRIVEWAY_METRICS.get(
          `driveway:${date}`, { type: 'json' }
        );
        if (!existing || entries >= (existing.entries || 0)) {
          await env.DRIVEWAY_METRICS.put(
            `driveway:${date}`,
            JSON.stringify({ date, entries, exits })
          );
        }

        // 2. Hourly snapshot for intraday chart (expires after 48h)
        const hour: number = value.hour ?? new Date().getUTCHours();
        const hourStr: string = String(hour).padStart(2, '0');
        await env.DRIVEWAY_METRICS.put(
          `hourly:${date}:${hourStr}`,
          JSON.stringify({ hour, entries, exits }),
          { expirationTtl: 60 * 60 * 48 }
        );

        return new Response('Metrics stored OK', { status: 200, headers: corsHeaders });
      } catch (e) {
        return new Response('JSON parse error', { status: 400, headers: corsHeaders });
      }
    }

    // GET /today — 1 read
    if (url.pathname === '/today') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const data: any = await env.DRIVEWAY_METRICS.get(
        `driveway:${date}`, { type: 'json' }
      );
      return Response.json({
        date,
        entries: data?.entries || 0,
        exits: data?.exits || 0,
      }, { headers: corsHeaders });
    }

    // GET /hourly — 1 list + N reads (N = hours elapsed today, max 24)
    if (url.pathname === '/hourly') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const list = await env.DRIVEWAY_METRICS.list({ prefix: `hourly:${date}:` });
      const snapshots = await Promise.all(
        list.keys.map(async (k: KVNamespaceListKey) => {
          const v: any = await env.DRIVEWAY_METRICS.get(k.name, { type: 'json' });
          return {
            hour: v?.hour ?? parseInt(k.name.split(':')[3], 10),
            entries: v?.entries || 0,
            exits: v?.exits || 0,
          };
        })
      );
      snapshots.sort((a, b) => a.hour - b.hour);
      return Response.json({ date, snapshots }, { headers: corsHeaders });
    }

    // GET /dashboard — 1 list + 1 read per day (max 30 reads total)
    // Aggregation already done at write time; no nested loops here.
    if (url.pathname === '/dashboard') {
      const list = await env.DRIVEWAY_METRICS.list({ limit: 30, prefix: 'driveway:' });
      const metrics = await Promise.all(
        list.keys.map(async (k: KVNamespaceListKey) => {
          const v: any = await env.DRIVEWAY_METRICS.get(k.name, { type: 'json' });
          return {
            date: k.name.split(':')[1],
            entries: v?.entries || 0,
            exits: v?.exits || 0,
          };
        })
      );
      return Response.json(metrics.reverse(), { headers: corsHeaders });
    }

    return new Response(
      'Endpoints: /today, /hourly, /dashboard, POST /api/metrics',
      { status: 404, headers: corsHeaders }
    );
  },
};