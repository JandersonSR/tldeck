// "Send to agents": the human sends an issue or an activity with a prompt; the dispatcher (agents/dispatcher.ts)
// triages it and runs it. Nothing else creates agent runs. Writes are covered by the global guard
// (X-Agent-Board header + local Origin), see http/security.ts. Free text is masked before it is stored.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Dispatcher } from '../agents/dispatcher.js';
import type { RequestViews } from '../agents/request-view.js';
import { OPEN_STATUSES, sourceKeyOf, type AgentRequest, type RequestsRepo } from '../agents/requests-repo.js';
import type { RunsRepo } from '../agents/runs-repo.js';
import type { TaskService } from '../agents/task-service.js';
import type { Activity } from '../domain/activities.js';
import { DocRepo, isId } from '../store/doc-repo.js';
import type { DeckStore } from '../store/store.js';

type Mask = (s: string) => { text: string; total: number };

const IssueUrl = z.string().url().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+\/?$/, 'GitHub issue URL');
const Repo = z.string().trim().max(200).regex(/^[\w.-]+(\/[\w.-]+)?$/, 'repo slug or owner/name');
const Id = z.object({ id: z.string().refine(isId, 'invalid id') });

const Create = z.object({
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('issue'), url: IssueUrl }),
    z.object({ kind: z.literal('activity'), id: z.string().refine(isId, 'invalid id') }),
  ]),
  prompt: z.string().trim().min(1).max(4000),
  repo: Repo.optional(),
  autoApprovePlan: z.boolean().optional(),
  priority: z.boolean().optional(),
}).strict();

const Patch = z.object({
  answer: z.string().trim().min(1).max(4000).optional(),
  repo: Repo.optional(),
}).strict().refine(b => b.answer !== undefined || b.repo !== undefined, 'give an answer or a repo');

export async function agentRequestsRoutes(app: FastifyInstance, opts: {
  store: DeckStore; mask: Mask; requests: RequestsRepo; runs: RunsRepo; views: RequestViews; tasks: TaskService; dispatcher: Dispatcher;
}): Promise<void> {
  const { store, requests, runs, views, tasks, dispatcher } = opts;
  const activities = new DocRepo<Activity>(store, 'deck_activities');
  const m = (s: string) => opts.mask(s).text;
  const ready = async () => { if (!store.configured) return false; await store.connect(); return true; };
  const conflict = (msg: string) => Object.assign(new Error(msg), { statusCode: 409 });

  app.post('/api/agent-requests', async (req, reply) => {
    const body = Create.parse(req.body);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    const sourceKey = sourceKeyOf(body.source);
    if (await requests.openFor(sourceKey) || await runs.activeTaskFor(sourceKey)) throw conflict('already with the agents');

    let title: string; let text: string; let userPriority = body.priority ?? false; let dueDate: string | undefined;
    if (body.source.kind === 'issue') {
      const issue = await tasks.fetchIssue(body.source.url); // title/body already masked
      title = issue.title; text = issue.body;
    } else {
      const a = await activities.get(body.source.id);
      if (!a) return reply.code(404).send({ error: 'activity not found' });
      if (a.status === 'done') throw conflict('the activity is already done');
      title = m(a.title); text = m(a.notes ?? '');
      userPriority = body.priority ?? a.priority;
      dueDate = a.date;
    }
    const now = new Date();
    const doc: AgentRequest = {
      source: body.source, sourceKey, title, body: text, userPrompt: m(body.prompt), answers: [],
      ...(body.repo ? { repoHint: body.repo } : {}), userPriority, ...(dueDate ? { dueDate } : {}),
      autoApprovePlan: body.autoApprovePlan === true, status: 'triaging', createdAt: now, updatedAt: now,
    };
    const id = await requests.create(doc);
    dispatcher.kick();
    return { id };
  });

  app.get('/api/agent-requests', async (req) => {
    const { active } = z.object({ active: z.coerce.number().optional() }).parse(req.query);
    if (!(await ready())) return { configured: false, items: [] };
    return { configured: true, items: await views.list(!!active) };
  });

  // The human answers a triage question (and/or fixes the repo): back to triage.
  app.patch('/api/agent-requests/:id', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = Patch.parse(req.body);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    const cur = await requests.get(id);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    if (cur.status !== 'needs_input') throw conflict(`the request is "${cur.status}"`);
    await requests.update(id, {
      status: 'triaging', question: '',
      ...(body.answer ? { answers: [...cur.answers, m(body.answer)] } : {}),
      ...(body.repo ? { repoHint: body.repo } : {}),
    });
    dispatcher.kick();
    return { ok: true };
  });

  app.post('/api/agent-requests/:id/cancel', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!(await ready())) return reply.code(503).send({ error: 'storage not configured' });
    const cur = await requests.get(id);
    if (!cur) return reply.code(404).send({ error: 'not found' });
    if (!(OPEN_STATUSES as string[]).includes(cur.status)) throw conflict(`the request is "${cur.status}"`);
    await requests.update(id, { status: 'cancelled' });
    return { ok: true };
  });
}
