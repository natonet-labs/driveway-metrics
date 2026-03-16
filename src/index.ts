// Driveway Metrics Worker - Stores/Retrieves daily JSON from Pi counter
//
// POST /api/metrics {key: "driveway:2026-03-15", value: {entries: 5, exits: 3}}
//   Writes two KV keys per upload:
//     driveway:DATE        — running daily total (overwritten each upload)
//     hourly:DATE:HH       — snapshot at that hour (overwritten within same hour)
//
// GET /today              — Today's latest totals
// GET /hourly             — Today's intraday snapshots (one per hour received)
// GET /dashboard          — Last 30 days table-ready JSON

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
    // Writes daily key + hourly snapshot key
    if (request.method === 'POST' && url.pathname === '/api/metrics') {
      try {
        const { key, value }: { key: string; value: any } = await request.json();
        if (!key || !value) {
          return new Response('Missing key/value', { status: 400, headers: corsHeaders });
        }

        // Only overwrite the daily key if the new count is higher (guards against
        // a restarted service briefly reporting lower counts before catching up)
        const existing: any = await env.DRIVEWAY_METRICS.get(key, { type: 'json' });
        if (
          !existing ||
          value.entries >= (existing.entries || 0) ||
          value.exits >= (existing.exits || 0)
        ) {
          await env.DRIVEWAY_METRICS.put(key, JSON.stringify(value));
        }

        // Hourly snapshot keyed by Pi local hour
        const date: string = value.date || key.split(':')[1];
        const hour: number = value.hour ?? new Date().getUTCHours();
        const hourStr: string = String(hour).padStart(2, '0');
        await env.DRIVEWAY_METRICS.put(
          `hourly:${date}:${hourStr}`,
          JSON.stringify({ hour, entries: value.entries || 0, exits: value.exits || 0 }),
          { expirationTtl: 60 * 60 * 48 }
        );

        return new Response('Metrics stored OK', { status: 200, headers: corsHeaders });
      } catch (e) {
        return new Response('JSON parse error', { status: 400, headers: corsHeaders });
      }
    }

    // GET /today — latest daily totals
    if (url.pathname === '/today') {
      // Use date from query param (browser local date) or fall back to UTC
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const data: any = await env.DRIVEWAY_METRICS.get(`driveway:${date}`, { type: 'json' });
      return Response.json({
        date,
        entries: data?.entries || 0,
        exits: data?.exits || 0,
      }, { headers: corsHeaders });
    }

    // GET /hourly — today's intraday snapshots sorted by hour
    if (url.pathname === '/hourly') {
      const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
      const list = await env.DRIVEWAY_METRICS.list({ prefix: `hourly:${date}:` })

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

      // Sort ascending by hour so the chart reads left→right
      snapshots.sort((a, b) => a.hour - b.hour);

      return Response.json({ date, snapshots }, { headers: corsHeaders });
    }

    // GET /dashboard — last 30 days (daily totals only)
    if (url.pathname === '/dashboard') {
      const list = await env.DRIVEWAY_METRICS.list({ limit: 30, prefix: 'driveway:' });

      const metrics = await Promise.all(
        list.keys.map(async (k: KVNamespaceListKey) => {
          const date = k.name.split(':')[1];

          // Find the peak hourly snapshot for this date — that represents
          // the highest cumulative count reached during the day
          const hourlyList = await env.DRIVEWAY_METRICS.list({ prefix: `hourly:${date}:` });
          let maxEntries = 0;
          let maxExits = 0;

          if (hourlyList.keys.length > 0) {
            const snapshots = await Promise.all(
              hourlyList.keys.map(async (hk: KVNamespaceListKey) => {
                const v: any = await env.DRIVEWAY_METRICS.get(hk.name, { type: 'json' });
                return { entries: v?.entries || 0, exits: v?.exits || 0 };
              })
            );
            maxEntries = Math.max(...snapshots.map(s => s.entries));
            maxExits = Math.max(...snapshots.map(s => s.exits));
          } else {
            // Fall back to the daily key for older dates before hourly tracking existed
            const v: any = await env.DRIVEWAY_METRICS.get(k.name, { type: 'json' });
            maxEntries = v?.entries || 0;
            maxExits = v?.exits || 0;
          }

          return { date, entries: maxEntries, exits: maxExits };
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