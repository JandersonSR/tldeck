// Activities API + reminders over the SQLite collection layer (with an in-memory driver, so it runs on any Node).
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseConfig } from '../config.js';
import { localInstant } from '../domain/activities.js';
import { activitiesRoutes } from '../routes/activities.js';
import { SqliteCollection } from '../store/sqlite-store.js';
import type { DeckStore } from '../store/store.js';
import { AlertHub } from '../notify/alert-hub.js';
import { ActivityNotifier } from './notifier.js';

function memoryDb() {
  const rows = new Map<string, string>();
  const stmt = (sql: string) => ({
    run: (id: string, doc?: string) => { if (sql.startsWith('INSERT')) rows.set(id, doc!); else if (sql.startsWith('DELETE')) rows.delete(id); },
    all: () => [...rows].map(([id, doc]) => ({ id, doc })),
  });
  return { exec() {}, close() {}, prepare: stmt };
}
const cols = new Map<string, SqliteCollection>();
const db = memoryDb();
const store = {
  configured: true,
  connect: async () => undefined,
  close: async () => undefined,
  collection: (name: string) => { if (!cols.has(name)) cols.set(name, new SqliteCollection(db, name)); return cols.get(name)!; },
} as unknown as DeckStore;
const config = parseConfig({ STORAGE: 'none', TEAM_TZ_OFFSET_MIN: '-180' });
let app: FastifyInstance;
let notifier: ActivityNotifier;
const J = { 'content-type': 'application/json' };

beforeAll(async () => {
  await store.connect();
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => reply.code(err instanceof ZodError ? 400 : 500).send({ error: (err as Error).message }));
  notifier = new ActivityNotifier(config, store, app.log, new AlertHub({ rules: config.activities.rules, tzOffsetMin: -180 }));
  await app.register(activitiesRoutes, { config, store, mask: s => ({ text: s, total: 0 }), notifier });
});
afterAll(async () => { await app.close(); await store.close(); });

describe('activities', () => {
  it('create, list in the week, move to doing/done', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/activities', headers: J, payload: { title: 'Deploy da API', date: '2026-11-27', priority: true, durationHours: 4 } });
    expect(c.statusCode).toBe(200);
    const id = c.json().id as string;

    const week = (await app.inject({ url: '/api/activities?ref=2026-11-26' })).json();
    expect(week.from).toBe('2026-11-23');
    expect(week.items.map((i: { title: string }) => i.title)).toContain('Deploy da API');

    const doing = (await app.inject({ method: 'PATCH', url: `/api/activities/${id}`, headers: J, payload: { status: 'doing' } })).json();
    expect(doing.startedAt).toBeTruthy();
    expect(doing.deadline).toBeTruthy(); // 4 h from when it started

    const bad = await app.inject({ method: 'PATCH', url: `/api/activities/${id}`, headers: J, payload: { status: 'lost' } });
    expect(bad.statusCode).toBe(400);

    await app.inject({ method: 'DELETE', url: `/api/activities/${id}` });
  });

  it('reminders: day before, hourly on the date, never twice, stop when done', async () => {
    const c = await app.inject({ method: 'POST', url: '/api/activities', headers: J, payload: { title: 'Reunião com o PO', date: '2026-11-27', priority: true } });
    const id = c.json().id as string;
    const at = (day: string, time: string) => localInstant(day, time, -180);

    expect((await notifier.tick(at('2026-11-26', '09:01'))).map(s => s.kind)).toEqual(['day_before']);
    expect(await notifier.tick(at('2026-11-26', '09:02'))).toEqual([]);
    expect((await notifier.tick(at('2026-11-26', '15:00'))).map(s => s.kind)).toEqual(['day_before']);
    expect((await notifier.tick(at('2026-11-27', '10:00'))).map(s => s.kind)).toEqual(['due']);
    expect((await notifier.tick(at('2026-11-27', '11:00'))).map(s => s.kind)).toEqual(['due']);

    const alerts = (await app.inject({ url: '/api/activities/alerts?since=0' })).json();
    expect(alerts.items).toHaveLength(4);

    await app.inject({ method: 'PATCH', url: `/api/activities/${id}`, headers: J, payload: { status: 'done' } });
    expect(await notifier.tick(at('2026-11-27', '12:00'))).toEqual([]);
  });
});
