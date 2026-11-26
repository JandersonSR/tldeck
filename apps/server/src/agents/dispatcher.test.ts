import { describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import { AlertHub } from '../notify/alert-hub.js';
import { SqliteCollection } from '../store/sqlite-store.js';
import type { DeckStore } from '../store/store.js';
import { agentAlertText, appendNote, appendPrNote, canAutoApprove, Dispatcher, isProductionBase } from './dispatcher.js';
import { RequestsRepo, type AgentRequest } from './requests-repo.js';

function memoryStore() {
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
  const db = { exec() {}, close() {}, prepare: stmt };
  const cols = new Map<string, SqliteCollection>();
  return {
    configured: true, connect: async () => undefined, close: async () => undefined,
    collection: (n: string) => { if (!cols.has(n)) cols.set(n, new SqliteCollection(db, n)); return cols.get(n)!; },
  } as unknown as DeckStore;
}

describe('auto-approval rule', () => {
  const triage = (risk: 'low' | 'medium' | 'high') => ({ executable: true, repo: 'api', flow: 'bug' as const, risk, priority: 2 as const, acceptance: [], question: null });
  it('only with opt-in, low risk and a non-production base', () => {
    expect(canAutoApprove({ autoApprovePlan: true, triage: triage('low') }, 'origin/main')).toBe(true);
    expect(canAutoApprove({ autoApprovePlan: false, triage: triage('low') }, 'origin/main')).toBe(false);
    expect(canAutoApprove({ autoApprovePlan: true, triage: triage('medium') }, 'origin/main')).toBe(false);
    expect(canAutoApprove({ autoApprovePlan: true, triage: triage('high') }, 'origin/main')).toBe(false);
    expect(canAutoApprove({ autoApprovePlan: true, triage: undefined }, 'origin/main')).toBe(false);
    expect(canAutoApprove({ autoApprovePlan: true, triage: triage('low') }, 'origin/production-api')).toBe(false);
    expect(canAutoApprove({ autoApprovePlan: true, triage: triage('low') }, 'origin/release-x', ['release-*'])).toBe(false);
  });

  it('recognises production bases', () => {
    expect(isProductionBase('origin/production')).toBe(true);
    expect(isProductionBase('production-server')).toBe(true);
    expect(isProductionBase('origin/main')).toBe(false);
    expect(isProductionBase('origin/jobs', ['jobs'])).toBe(true);
  });
});

describe('activity notes', () => {
  it('appends the PR link once and respects the limit', () => {
    expect(appendPrNote('feito', 'https://github.com/a/b/pull/1')).toBe('feito\nPR: https://github.com/a/b/pull/1');
    expect(appendPrNote(undefined, 'u')).toBe('\nPR: u');
    const once = appendPrNote('x', 'https://github.com/a/b/pull/1');
    expect(appendPrNote(once, 'https://github.com/a/b/pull/1')).toBe(once);
    const long = appendPrNote('a'.repeat(1990), 'https://github.com/a/b/pull/1');
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.endsWith('PR: https://github.com/a/b/pull/1')).toBe(true);
  });
});

describe('agentAlertText', () => {
  it('writes in the content language and keeps titles short', () => {
    expect(agentAlertText('agent_plan_ready', 'Parcela', 'pt-BR').title).toBe('Plano pronto para aprovar');
    expect(agentAlertText('agent_plan_ready', 'Parcela', 'en').title).toBe('Plan ready for approval');
    expect(agentAlertText('agent_failed', 'x'.repeat(300), 'en', 'boom').body.length).toBeLessThan(140);
  });
});

describe('Dispatcher.tick', () => {
  function setup(max: number) {
    const store = memoryStore();
    const requests = new RequestsRepo(store);
    const active = new Map<string, unknown>();
    const cfg = parseConfig({ STORAGE: 'none', MAX_CONCURRENT_SESSIONS: String(max) });
    const ctx = {
      store, cfg, active, log: { warn: vi.fn() }, mask: (s: string) => ({ text: s, total: 0 }),
      onPhase: () => () => undefined, resolveRepoPath: () => '/repo',
      checkLimits: async () => { if (active.size >= max) throw Object.assign(new Error('limit'), { statusCode: 429 }); },
    };
    const started: Array<{ title: string; model: string }> = [];
    const tasks = {
      startFromRequest: async (r: AgentRequest, o: { model: string }) => {
        started.push({ title: r.title, model: o.model });
        const id = `run${started.length}`;
        active.set(id, {});
        return { id };
      },
    };
    const hub = new AlertHub({ rules: cfg.activities.rules, tzOffsetMin: 0 });
    const d = new Dispatcher(ctx as never, tasks as never, requests, hub, cfg);
    return { d, requests, active, started };
  }
  const queued = (title: string, o: Partial<AgentRequest> = {}): AgentRequest => ({
    source: { kind: 'activity', id: title }, sourceKey: `activity:${title}`, title, body: '', userPrompt: 'faça', answers: [],
    userPriority: false, autoApprovePlan: false, status: 'queued', createdAt: new Date(1000), updatedAt: new Date(1000),
    triage: { executable: true, repo: 'api', flow: 'bug', risk: 'low', priority: 3, acceptance: [], question: null }, ...o,
  });

  it('starts only up to maxConcurrent, in queue order, and the third waits for a free slot', async () => {
    const { d, requests, active, started } = setup(2);
    await requests.create(queued('late', { createdAt: new Date(3000) }));
    await requests.create(queued('star', { userPriority: true, createdAt: new Date(4000) }));
    await requests.create(queued('first', { createdAt: new Date(1000) }));
    await d.tick();
    expect(started.map(s => s.title)).toEqual(['star', 'first']);
    expect((await requests.byStatus(['queued'])).map(r => r.title)).toEqual(['late']);
    expect((await requests.byStatus(['dispatched'])).every(r => !!r.runId)).toBe(true);

    await d.tick(); // still full
    expect(started).toHaveLength(2);
    active.delete('run1'); // a slot frees up
    await d.tick();
    expect(started.map(s => s.title)).toEqual(['star', 'first', 'late']);
  });

  it('uses the high-risk model only for high risk', async () => {
    const { d, requests, started } = setup(3);
    const high = { executable: true, repo: 'api', flow: 'feature' as const, risk: 'high' as const, priority: 1 as const, acceptance: [], question: null };
    await requests.create(queued('big', { triage: high }));
    await requests.create(queued('small', { createdAt: new Date(2000) }));
    await d.tick();
    expect(started).toEqual([{ title: 'big', model: 'opus' }, { title: 'small', model: 'sonnet' }]);
  });

  it('never touches requests that are not queued', async () => {
    const { d, requests, started } = setup(2);
    await requests.create(queued('waiting', { status: 'needs_input' }));
    await requests.create(queued('gone', { status: 'cancelled' }));
    await d.tick();
    expect(started).toEqual([]);
  });
});

describe('appendNote', () => {
  it('appends a line once and respects the limit', () => {
    expect(appendNote('feito', '\nAplicado em /x: 2 arquivo(s)')).toBe('feito\nAplicado em /x: 2 arquivo(s)');
    const once = appendNote('x', '\nAplicado em /x: 2 arquivo(s)');
    expect(appendNote(once, '\nAplicado em /x: 2 arquivo(s)')).toBe(once);
    expect(appendNote('a'.repeat(1999), '\nAplicado em /x: 2 arquivo(s)').length).toBeLessThanOrEqual(2000);
  });
});
