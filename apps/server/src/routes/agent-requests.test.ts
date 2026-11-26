// Agent requests API + alerts routes + the "agent" field of the activities list, over an in-memory collection layer.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { RequestViews } from '../agents/request-view.js';
import { RequestsRepo } from '../agents/requests-repo.js';
import { RunsRepo } from '../agents/runs-repo.js';
import { ActivityNotifier } from '../activities/notifier.js';
import { parseConfig } from '../config.js';
import { AlertHub } from '../notify/alert-hub.js';
import { SqliteCollection } from '../store/sqlite-store.js';
import type { DeckStore } from '../store/store.js';
import { activitiesRoutes } from './activities.js';
import { agentRequestsRoutes } from './agent-requests.js';
import { alertsRoutes } from './alerts.js';

function memoryDb() {
  const tables = new Map<string, Map<string, string>>();
  const stmt = (sql: string) => {
    const t = /"([^"]+)"/.exec(sql)?.[1] ?? '';
    if (!tables.has(t)) tables.set(t, new Map());
    const rows = tables.get(t)!;
    return {
    run: (id: string, doc?: string) => { if (sql.startsWith('INSERT')) rows.set(id, doc!); else if (sql.startsWith('DELETE')) rows.delete(id); },
    all: () => [...rows].map(([id, doc]) => ({ id, doc })),
    };
  };
  return { exec() {}, close() {}, prepare: stmt };
}
const cols = new Map<string, SqliteCollection>();
const db = memoryDb();
const store = {
  configured: true, connect: async () => undefined, close: async () => undefined,
  collection: (name: string) => { if (!cols.has(name)) cols.set(name, new SqliteCollection(db, name)); return cols.get(name)!; },
} as unknown as DeckStore;
const config = parseConfig({ STORAGE: 'none', TEAM_TZ_OFFSET_MIN: '-180' });
const J = { 'content-type': 'application/json' };
const kick = vi.fn();
let app: FastifyInstance;
let hub: AlertHub;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number };
    reply.code(err instanceof ZodError ? 400 : e.statusCode ?? 500).send({ error: e.message });
  });
  const mask = (s: string) => ({ text: s.replace(/secret/g, '***'), total: 0 });
  hub = new AlertHub({ rules: config.activities.rules, tzOffsetMin: -180, channels: { os: { available: true, show: async () => true } } });
  const requests = new RequestsRepo(store);
  const runs = new RunsRepo(store);
  const views = new RequestViews(requests, runs);
  const notifier = new ActivityNotifier(config, store, app.log, hub);
  await app.register(activitiesRoutes, { config, store, mask, notifier, views });
  await app.register(alertsRoutes, { config, hub });
  await app.register(agentRequestsRoutes, { store, mask, requests, runs, views, tasks: {} as never, dispatcher: { kick } as never });
});
afterAll(async () => { await app.close(); });

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: J, payload: payload as never });

describe('agent requests', () => {
  it('creates a request for an activity, masks the prompt, refuses a second one and kicks the dispatcher', async () => {
    const act = (await post('/api/activities', { title: 'Atualizar docs', date: '2026-11-27', priority: true })).json().id as string;
    const c = await post('/api/agent-requests', { source: { kind: 'activity', id: act }, prompt: 'use o secret do ambiente', autoApprovePlan: true });
    expect(c.statusCode).toBe(200);
    expect(kick).toHaveBeenCalled();

    const list = (await app.inject({ url: '/api/agent-requests?active=1' })).json();
    expect(list.items).toHaveLength(1);
    const item = list.items[0];
    expect(typeof item._id).toBe('string');
    expect(item).toMatchObject({ status: 'triaging', userPrompt: 'use o *** do ambiente', userPriority: true, dueDate: '2026-11-27', autoApprovePlan: true, sourceKey: `activity:${act}`, run: null });

    const dup = await post('/api/agent-requests', { source: { kind: 'activity', id: act }, prompt: 'de novo' });
    expect(dup.statusCode).toBe(409);

    // the activities list shows what the agents are doing with it
    const week = (await app.inject({ url: '/api/activities?ref=2026-11-26' })).json();
    expect(week.items.find((i: { _id: string }) => i._id === act).agent).toMatchObject({ requestId: c.json().id, status: 'triaging' });

    const cancel = await post(`/api/agent-requests/${c.json().id}/cancel`, {});
    expect(cancel.statusCode).toBe(200);
    expect((await post(`/api/agent-requests/${c.json().id}/cancel`, {})).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/agent-requests?active=1' })).json().items).toHaveLength(0);
    expect((await app.inject({ url: '/api/agent-requests' })).json().items).toHaveLength(1);
  });

  it('validates input and the PATCH only works in needs_input', async () => {
    expect((await post('/api/agent-requests', { source: { kind: 'issue', url: 'https://example.com/x' }, prompt: 'x' })).statusCode).toBe(400);
    expect((await post('/api/agent-requests', { source: { kind: 'activity', id: 'abc' }, prompt: 'x' })).statusCode).toBe(400);
    expect((await post('/api/agent-requests', { source: { kind: 'activity', id: 'a'.repeat(24) }, prompt: '' })).statusCode).toBe(400);
    expect((await post('/api/agent-requests', { source: { kind: 'activity', id: 'a'.repeat(24) }, prompt: 'x' })).statusCode).toBe(404);

    const act = (await post('/api/activities', { title: 'Outra', date: '2026-11-28' })).json().id as string;
    const id = (await post('/api/agent-requests', { source: { kind: 'activity', id: act }, prompt: 'faça' })).json().id as string;
    const patch = (body: unknown) => app.inject({ method: 'PATCH', url: `/api/agent-requests/${id}`, headers: J, payload: body as never });
    expect((await patch({ answer: 'no repo api' })).statusCode).toBe(409); // still triaging

    await new RequestsRepo(store).update(id, { status: 'needs_input', question: 'Qual repo?' });
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ answer: 'repo api, secret', repo: 'acme/api' })).statusCode).toBe(200);
    const after = (await app.inject({ url: '/api/agent-requests?active=1' })).json().items.find((i: { _id: string }) => i._id === id);
    expect(after).toMatchObject({ status: 'triaging', answers: ['repo api, ***'], repoHint: 'acme/api' });
  });
});

describe('alerts routes', () => {
  it('the test alert reaches the buffer and the poll returns the channel state', async () => {
    const t = await post('/api/alerts/test', {});
    expect(t.json()).toMatchObject({ ok: true, osToast: true });
    const r = (await app.inject({ url: '/api/alerts?since=0' })).json();
    expect(r.osToast).toBe(true);
    expect(r.items.map((i: { kind: string }) => i.kind)).toContain('test');
    expect(r.items.at(-1).url).toBe('/#/settings');
    expect((await app.inject({ url: `/api/alerts?since=${r.now + 1000}` })).json().items).toEqual([]);
  });
});
