// Daily activities (post-its) for the week, with reminders (see activities/notifier.ts).
// Free text is masked before it is written, like the other deck collections.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ActivityNotifier } from '../activities/notifier.js';
import type { Config } from '../config.js';
import {
  ACTIVITY_COLORS, ACTIVITY_STATUSES, deadlineOf, isOverdue, localParts, weekRange, type Activity,
} from '../domain/activities.js';
import { isId, maskFields } from '../store/doc-repo.js';
import type { DeckStore } from '../store/store.js';

type Mask = (s: string) => { text: string; total: number };

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const IdParams = z.object({ id: z.string().refine(isId, 'invalid id') });

const Fields = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(2000),
  date: Day,
  startTime: Time.nullable(),
  durationHours: z.number().positive().max(240).nullable(),
  priority: z.boolean(),
  status: z.enum(ACTIVITY_STATUSES),
  color: z.enum(ACTIVITY_COLORS),
}).strict();
const Create = Fields.partial().required({ title: true, date: true });
const Patch = Fields.partial();

export async function activitiesRoutes(app: FastifyInstance, opts: { config: Config; store: DeckStore; mask: Mask; notifier: ActivityNotifier }): Promise<void> {
  const { config, store, notifier } = opts;
  const repo = notifier.repo;
  const tz = config.team.tzOffsetMin;
  const m = (s: string) => opts.mask(s).text;
  const ready = async () => { if (!store.configured) return false; await store.connect(); return true; };
  const view = (a: Activity & { _id: unknown }, today: string) => {
    const deadline = deadlineOf(a, tz);
    return {
      ...a, _id: String(a._id), notified: undefined,
      deadline: deadline === null ? null : new Date(deadline).toISOString(),
      overdue: isOverdue(a, today) || (deadline !== null && a.status !== 'done' && Date.now() >= deadline),
    };
  };

  // Week (Mon–Sun) of `ref`, plus the open activities from before it (they carry over as overdue).
  app.get('/api/activities', async (req) => {
    const today = localParts(Date.now(), tz).day;
    const { ref } = z.object({ ref: Day.optional() }).parse(req.query);
    const [from, to] = weekRange(ref ?? today);
    if (!(await ready())) return { configured: false, today, from, to, items: [], rules: config.activities.rules, ntfy: !!config.activities.ntfy };
    const items = await repo.list(
      { $or: [{ date: { $gte: from, $lte: to } }, { date: { $lt: from }, status: { $ne: 'done' } }] } as never,
      { date: 1, startTime: 1, createdAt: 1 }, 1000,
    );
    return { configured: true, today, from, to, items: items.map(a => view(a, today)), rules: config.activities.rules, ntfy: !!config.activities.ntfy };
  });

  app.post('/api/activities', async (req, reply) => {
    const body = Create.parse(req.body);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    const now = new Date();
    const status = body.status ?? 'todo';
    const doc: Activity = {
      priority: false, color: 'yellow', notified: [],
      ...clean(maskFields(body, ['title', 'notes'], m)),
      status, startedAt: status === 'doing' ? now : null, doneAt: status === 'done' ? now : null,
      createdAt: now, updatedAt: now,
    } as unknown as Activity;
    return { id: await repo.create(doc) };
  });

  app.patch('/api/activities/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    const body = Patch.parse(req.body);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    const prev = await repo.get(id);
    if (!prev) return reply.code(404).send({ error: 'not found' });
    const now = new Date();
    const set: Record<string, unknown> = { ...clean(maskFields(body, ['title', 'notes'], m)), updatedAt: now };
    // The hour clock starts when it moves to "doing"; "done" stops the reminders.
    if (body.status === 'doing' && !prev.startedAt) set.startedAt = now;
    if (body.status === 'done' && prev.status !== 'done') set.doneAt = now;
    if (body.status && body.status !== 'done') set.doneAt = null;
    if (body.status === 'todo') set.startedAt = null;
    const doc = await repo.update(id, set as Partial<Activity>);
    return view(doc!, localParts(Date.now(), tz).day);
  });

  app.delete('/api/activities/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    return (await repo.remove(id)) ? { ok: true } : reply.code(404).send({ error: 'not found' });
  });

  // Reminders sent after `since` (ms): the screen turns them into desktop notifications.
  app.get('/api/activities/alerts', async (req) => {
    const { since } = z.object({ since: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    return { now: Date.now(), items: notifier.since(since) };
  });
}

/** Drops undefined keys; null is kept (it clears startTime / durationHours). */
function clean<T extends Record<string, unknown>>(x: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) if (v !== undefined) out[k] = v;
  return out;
}
