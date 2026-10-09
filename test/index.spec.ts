import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

const TOKEN = 'test-token';
const DASHBOARD_TOKEN = 'dashboard-token';
const testEnv: Env = { ...(env as unknown as Env), CLOUDFLARE_TOKEN: TOKEN, DASHBOARD_TOKEN };

function upload(value: object, token: string | null = TOKEN): Promise<Response> {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	const request = new Request('https://metrics.test/api/metrics', {
		method: 'POST',
		headers,
		body: JSON.stringify({ key: `driveway:${(value as { date: string }).date}`, value }),
	});
	return worker.fetch(request, testEnv);
}

const get = (path: string, token: string | null = DASHBOARD_TOKEN, e: Env = testEnv) =>
	worker.fetch(
		new Request(`https://metrics.test${path}`, token === null ? {} : { headers: { Authorization: `Bearer ${token}` } }),
		e,
	);

describe('POST /api/metrics', () => {
	beforeEach(async () => {
		const { keys } = await testEnv.DRIVEWAY_METRICS.list();
		await Promise.all(keys.map((k) => testEnv.DRIVEWAY_METRICS.delete(k.name)));
	});

	it('rejects uploads with no token', async () => {
		expect((await upload({ date: '2026-10-01', entries: 1, exits: 0 }, null)).status).toBe(401);
	});

	it('rejects uploads with the wrong token', async () => {
		expect((await upload({ date: '2026-10-01', entries: 1, exits: 0 }, 'wrong')).status).toBe(401);
		expect(await testEnv.DRIVEWAY_METRICS.get('driveway:2026-10-01')).toBeNull();
	});

	it('rejects uploads when the secret is not configured', async () => {
		const request = new Request('https://metrics.test/api/metrics', {
			method: 'POST',
			headers: { Authorization: 'Bearer ' },
			body: JSON.stringify({ key: 'driveway:2026-10-01', value: { date: '2026-10-01' } }),
		});
		const response = await worker.fetch(request, { ...testEnv, CLOUDFLARE_TOKEN: '' });
		expect(response.status).toBe(401);
	});

	it('stores an authorized upload and serves it from /today', async () => {
		expect((await upload({ date: '2026-10-01', hour: 9, entries: 4, exits: 3 })).status).toBe(200);
		expect(await (await get('/today?date=2026-10-01')).json()).toEqual({ date: '2026-10-01', entries: 4, exits: 3 });
	});

	it('does not let a lower post-restart count clobber the daily total', async () => {
		await upload({ date: '2026-10-01', hour: 9, entries: 4, exits: 3 });
		await upload({ date: '2026-10-01', hour: 10, entries: 0, exits: 0 });
		expect(await (await get('/today?date=2026-10-01')).json()).toMatchObject({ entries: 4, exits: 3 });
	});
});

describe('read endpoints', () => {
	beforeEach(async () => {
		const { keys } = await testEnv.DRIVEWAY_METRICS.list();
		await Promise.all(keys.map((k) => testEnv.DRIVEWAY_METRICS.delete(k.name)));
	});

	it('returns /hourly snapshots in hour order', async () => {
		await upload({ date: '2026-10-01', hour: 14, entries: 6, exits: 5 });
		await upload({ date: '2026-10-01', hour: 9, entries: 2, exits: 1 });
		const body = (await (await get('/hourly?date=2026-10-01')).json()) as { snapshots: { hour: number }[] };
		expect(body.snapshots.map((s) => s.hour)).toEqual([9, 14]);
	});

	it('returns /dashboard newest-first and caches until the next upload', async () => {
		await upload({ date: '2026-10-01', entries: 1, exits: 1 });
		await upload({ date: '2026-10-02', entries: 2, exits: 2 });

		const first = await get('/dashboard');
		expect(first.headers.get('X-Cache')).toBe('MISS');
		expect(((await first.json()) as { date: string }[]).map((d) => d.date)).toEqual(['2026-10-02', '2026-10-01']);
		expect((await get('/dashboard')).headers.get('X-Cache')).toBe('HIT');

		await upload({ date: '2026-10-03', entries: 3, exits: 3 });
		const afterUpload = await get('/dashboard');
		expect(afterUpload.headers.get('X-Cache')).toBe('MISS');
		expect(((await afterUpload.json()) as unknown[]).length).toBe(3);
	});

	it('returns the newest 30 days from /dashboard past KV list()\'s 1,000-key page', async () => {
		// 1,050 consecutive days: list() pages at 1,000, so without following
		// the cursor the "last 30" would be days 971–1,000 instead of the newest.
		const start = Date.UTC(2023, 0, 1);
		const dates = Array.from({ length: 1050 }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
		await Promise.all(
			dates.map((date, i) =>
				testEnv.DRIVEWAY_METRICS.put(`driveway:${date}`, JSON.stringify({ date, entries: i, exits: i })),
			),
		);

		const body = (await (await get('/dashboard')).json()) as { date: string }[];
		expect(body).toHaveLength(30);
		expect(body[0].date).toBe(dates[dates.length - 1]); // newest first
		expect(body[29].date).toBe(dates[dates.length - 30]);
	});

	it.each(['/today', '/hourly', '/dashboard'])('rejects %s without the dashboard token', async (path) => {
		expect((await get(path, null)).status).toBe(401);
		expect((await get(path, 'wrong')).status).toBe(401);
	});

	it('does not accept the ingest token for reads', async () => {
		expect((await get('/today', TOKEN)).status).toBe(401);
	});

	it('rejects reads when DASHBOARD_TOKEN is not configured', async () => {
		expect((await get('/today', '', { ...testEnv, DASHBOARD_TOKEN: '' })).status).toBe(401);
	});

	it('returns 404 for unknown paths', async () => {
		expect((await get('/nope')).status).toBe(404);
	});
});
