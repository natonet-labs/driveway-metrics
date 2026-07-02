[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)

# Driveway Metrics

Cloudflare Worker backend for [driveway-counter](https://github.com/natonet-labs/driveway-counter). Receives hourly entry/exit snapshots from a Raspberry Pi, stores them in KV, and serves a live dashboard — accessible from anywhere without exposing the Pi to the internet.

---

## Dashboard

Three views, all served from the Worker URL:

| View | Description |
|---|---|
| Today's totals | Entry/exit count cards for the current day |
| Hourly activity | Intraday bar chart updated each hour |
| 30-day history | Daily entry/exit line chart |

The dashboard auto-refreshes every 15 minutes. Because caches are invalidated on every Pi upload, the dashboard reflects new data within seconds of each hourly sync.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/metrics` | Receive hourly snapshot from Pi (requires Bearer token) |
| `GET` | `/today` | Today's live entry/exit totals (1 KV read) |
| `GET` | `/hourly` | Today's intraday snapshots, cached 5 min |
| `GET` | `/dashboard` | Last 30 days of daily totals, cached 10 min |

---

## KV Data Model

| Key pattern | TTL | Description |
|---|---|---|
| `driveway:YYYY-MM-DD` | none | Daily running total (overwritten each upload) |
| `hourly:YYYY-MM-DD:HH` | 48 h | Per-hour snapshot (auto-expires) |
| `cache:hourly:YYYY-MM-DD` | 5 min | Cached `/hourly` response |
| `cache:dashboard` | 10 min | Cached `/dashboard` response |

Caches are invalidated immediately on every Pi upload so the dashboard never shows stale data after a sync.

### KV free-tier budget

| Scenario | Ops/day |
|---|---|
| Before caching | ~55,000 |
| After caching (one tab, 5-min refresh) | ~1,350 |
| Free tier limit | 100,000 reads · 1,000 writes |

---

## Setup

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- [Node.js](https://nodejs.org) 18+
- Wrangler CLI: `npm install -g wrangler`

### 1 — Clone and install

```bash
git clone https://github.com/natonet-labs/driveway-metrics.git
cd driveway-metrics
npm install
```

### 2 — Create a KV namespace

```bash
wrangler kv namespace create DRIVEWAY_METRICS
```

Copy the `id` from the output and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "DRIVEWAY_METRICS",
    "id": "YOUR_KV_NAMESPACE_ID"
  }
]
```

### 3 — Create an API token

The Pi authenticates uploads with a Bearer token. Generate a secret and store it as a Worker secret:

```bash
wrangler secret put CLOUDFLARE_TOKEN
# Paste your token when prompted
```

Set the same value in `driveway-counter`'s `.env`:

```bash
WORKER_URL=https://driveway-metrics.YOUR_SUBDOMAIN.workers.dev/api/metrics
CLOUDFLARE_TOKEN=your_token_here
```

### 4 — Deploy

```bash
npm run deploy
```

### Local development

```bash
npm run dev
# Worker available at http://localhost:8787
```

---

## Project Structure

```
driveway-metrics/
├── src/
│   ├── index.ts        # Worker — API routes, KV reads/writes, caching
│   └── index.html      # Dashboard UI (Chart.js, served as static asset)
├── public/
│   └── index.html      # Wrangler static asset root
├── test/
│   └── index.spec.ts   # Vitest integration tests
├── wrangler.jsonc       # Worker config — name, KV binding, compat date
└── package.json
```

---

## Companion

**[driveway-counter](https://github.com/natonet-labs/driveway-counter)** — the Pi-side application that performs YOLOv8m inference on a Hailo-8 NPU, counts driveway entries/exits, and POSTs hourly snapshots to this Worker.
