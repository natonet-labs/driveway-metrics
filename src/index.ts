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

        // Write daily total
        await env.DRIVEWAY_METRICS.put(key, JSON.stringify(value));

        // Write hourly snapshot using the Pi's local hour from the payload
        const date: string = value.date || key.split(':')[1];
        const hour: number = value.hour ?? new Date().getUTCHours(); // fallback to UTC if missing
        const hourStr: string = String(hour).padStart(2, '0');
        const hourlyKey = `hourly:${date}:${hourStr}`;
        await env.DRIVEWAY_METRICS.put(hourlyKey, JSON.stringify({
          hour: hour,
          entries: value.entries || 0,
          exits: value.exits || 0,
        }), { expirationTtl: 60 * 60 * 48 }); // Auto-expire hourly keys after 48h

        return new Response('Metrics stored OK', { status: 200, headers: corsHeaders });
      } catch (e) {
        return new Response('JSON parse error', { status: 400, headers: corsHeaders });
      }
    }

    // GET /today — latest daily totals
    if (url.pathname === '/today') {
      const today = new Date().toISOString().split('T')[0];
      const data: any = await env.DRIVEWAY_METRICS.get(`driveway:${today}`, { type: 'json' });
      return Response.json({
        date: today,
        entries: data?.entries || 0,
        exits: data?.exits || 0,
      }, { headers: corsHeaders });
    }

    // GET /hourly — today's intraday snapshots sorted by hour
    if (url.pathname === '/hourly') {
      const today = new Date().toISOString().split('T')[0];
      const list = await env.DRIVEWAY_METRICS.list({ prefix: `hourly:${today}:` });

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

      return Response.json({ date: today, snapshots }, { headers: corsHeaders });
    }

    // GET /dashboard — last 30 days (daily totals only)
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
      // KV list returns oldest first — reverse for newest-first display
      return Response.json(metrics.reverse(), { headers: corsHeaders });
    }

    return new Response(
      'Endpoints: /today, /hourly, /dashboard, POST /api/metrics',
      { status: 404, headers: corsHeaders }
    );
  },
};