// Dispatcher: moves what the human SENT to the agents (deck_agent_requests) through triage and into the task flow.
// It reads ONLY that collection: never the Queue, the board or GitHub issues. Nothing runs without a request.
// Merge / push / production are never automatic; the draft PR still needs a click (openTaskPr).
import type { Config } from '../config.js';
import type { Activity } from '../domain/activities.js';
import { pick, type ContentLang } from '../domain/lang.js';
import { deckRoute, makeAlert, type AlertHub, type AlertKind } from '../notify/alert-hub.js';
import { DocRepo } from '../store/doc-repo.js';
import type { AgentContext, PhaseEvent } from './context.js';
import { compareRequests, type AgentRequest, type RequestsRepo } from './requests-repo.js';
import type { TaskService } from './task-service.js';
import { parseIssueUrl } from './task.js';
import { decideTriage, runTriage } from './triage.js';

type Req = AgentRequest & { _id: unknown };
const NOTES_MAX = 2000;

/** True when the PR base is a production branch: "production*" or one of DEPLOY_PROD_BRANCHES (trailing * = wildcard). */
export function isProductionBase(base: string, patterns: string[] = []): boolean {
  const name = base.replace(/^origin\//, '').toLowerCase();
  if (name.startsWith('production')) return true;
  return patterns.some((p) => {
    const q = p.toLowerCase();
    return q.endsWith('*') ? name.startsWith(q.slice(0, -1)) : name === q;
  });
}

/** Rule 4: auto-approval only with the human's opt-in, low risk and a non-production base. */
export function canAutoApprove(req: Pick<AgentRequest, 'autoApprovePlan' | 'triage'>, base: string, prodPatterns: string[] = []): boolean {
  return req.autoApprovePlan === true && req.triage?.risk === 'low' && !isProductionBase(base, prodPatterns);
}

/** "\nPR: <url>" appended to the activity notes, keeping the notes within the limit (the oldest text gives way). */
export function appendPrNote(notes: string | undefined, url: string, max = NOTES_MAX): string {
  const add = `\nPR: ${url}`;
  const base = (notes ?? '').trimEnd();
  if (base.includes(`PR: ${url}`)) return base;
  return `${base.slice(0, Math.max(0, max - add.length))}${add}`.slice(0, max);
}

/** Alert text for an agent event, in the content language. */
export function agentAlertText(kind: AlertKind, title: string, lang: ContentLang, detail?: string): { title: string; body: string } {
  const L = (en: string, pt: string) => pick(lang, en, pt);
  const t = title.length > 120 ? `${title.slice(0, 119)}…` : title;
  switch (kind) {
    case 'agent_needs_input': return { title: L('Agent needs you', 'O agente precisa de você'), body: detail ? `${t}: ${detail}` : t };
    case 'agent_plan_ready': return { title: L('Plan ready for approval', 'Plano pronto para aprovar'), body: t };
    case 'agent_failed': return { title: L('Agent run failed', 'Execução do agente falhou'), body: detail ? `${t}: ${detail}` : t };
    case 'agent_ready': return { title: L('Changes ready to review', 'Mudanças prontas para revisar'), body: t };
    case 'agent_pr_opened': return { title: L('Draft PR opened', 'Draft PR aberto'), body: detail ? `${t}: ${detail}` : t };
    default: return { title: t, body: '' };
  }
}

export class Dispatcher {
  private timer: NodeJS.Timeout | undefined;
  private off: (() => void) | undefined;
  private ticking = false;
  private again = false;
  private triaging: string | undefined;
  private readonly activities: DocRepo<Activity>;

  constructor(
    private readonly ctx: AgentContext,
    private readonly tasks: TaskService,
    private readonly requests: RequestsRepo,
    private readonly hub: AlertHub,
    private readonly cfg: Config,
  ) {
    this.activities = new DocRepo<Activity>(ctx.store, 'deck_activities');
  }

  /** Only with a configured store and outside the demo. */
  start(): void {
    if (!this.ctx.store.configured || this.cfg.demo.on || this.timer) return;
    this.off = this.ctx.onPhase(e => this.onPhase(e));
    this.timer = setInterval(() => this.kick(), this.cfg.dispatchIntervalSec * 1000);
    this.kick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.off?.();
    this.off = undefined;
  }

  /** Asks for a pass now (a new request, an answer, a run that ended). */
  kick(): void {
    void this.tick().catch(e => this.ctx.log.warn({ err: (e as Error).message }, 'dispatcher pass failed'));
  }

  async tick(): Promise<void> {
    if (this.ticking) { this.again = true; return; }
    this.ticking = true;
    try {
      await this.ctx.store.connect();
      await this.startTriage();
      await this.dispatchQueued();
    } finally {
      this.ticking = false;
      if (this.again) { this.again = false; this.kick(); }
    }
  }

  // ---------- triage (one at a time; it does not count as a task run) ----------

  private async startTriage(): Promise<void> {
    if (this.triaging) return;
    const next = (await this.requests.byStatus(['triaging'], 1))[0];
    if (!next) return;
    const id = String(next._id);
    this.triaging = id;
    // On an error it waits for the next interval instead of spinning.
    void this.triage(next).then(
      () => { this.triaging = undefined; this.kick(); },
      (e: Error) => { this.triaging = undefined; this.ctx.log.warn({ err: e.message }, 'triage failed'); },
    );
  }

  private repoNameOf(req: AgentRequest): string | undefined {
    const issue = req.source.kind === 'issue' ? parseIssueUrl(req.source.url) : undefined;
    return req.triage?.repo ?? req.repoHint ?? issue?.repo;
  }

  private async triage(req: Req): Promise<void> {
    const id = String(req._id);
    const result = await runTriage(this.ctx, req);
    const cur = await this.requests.get(id);
    if (!cur || cur.status !== 'triaging') return; // cancelled meanwhile
    const triage = result.ok ? result.triage : undefined;
    const probe = { ...cur, ...(triage ? { triage } : {}) };
    const name = triage ? (triage.repo ?? this.repoNameOf(probe)) : undefined;
    const decision = decideTriage(triage, !!name && !!this.ctx.resolveRepoPath(name));
    if (decision.status === 'queued') {
      await this.requests.update(id, { status: 'queued', triage, question: '' });
      return;
    }
    await this.requests.update(id, {
      status: 'needs_input', question: decision.question, ...(triage ? { triage } : {}),
      ...(result.ok ? {} : { error: result.error }),
    });
    this.alert('agent_needs_input', `${id}:agent_needs_input:${cur.answers.length}`, cur.title, deckRoute('runs'), decision.question);
  }

  // ---------- dispatch (respects maxConcurrent and the daily limit) ----------

  private async dispatchQueued(): Promise<void> {
    while (this.ctx.active.size < this.cfg.limits.maxConcurrent) {
      try { await this.ctx.checkLimits(); } catch { return; }
      const next = (await this.requests.byStatus(['queued'])).sort(compareRequests)[0];
      if (!next) return;
      const id = String(next._id);
      const model = next.triage?.risk === 'high' ? this.cfg.agentModels.taskHigh : this.cfg.agentModels.task;
      try {
        const { id: runId } = await this.tasks.startFromRequest(next, { model });
        await this.requests.update(id, { status: 'dispatched', runId });
      } catch (e) {
        const err = e as Error & { statusCode?: number };
        if (err.statusCode === 429) return; // limit reached: stays queued
        const error = this.ctx.mask(err.message || 'failed to start').text;
        await this.requests.update(id, { status: 'failed', error });
        this.alert('agent_failed', `${id}:agent_failed`, next.title, deckRoute('runs'), error);
      }
    }
  }

  // ---------- task phases ----------

  private async onPhase(e: PhaseEvent): Promise<void> {
    const t = e.task;
    if (!t.requestId) return; // a task started by hand from the screen: no dispatcher involvement
    const title = t.issueTitle;
    const url = deckRoute(`runs?run=${e.runId}`);
    switch (e.phase) {
      case 'planning':
        await this.syncActivity(t.source, a => (a.status === 'todo' ? { status: 'doing', startedAt: a.startedAt ?? new Date(), doneAt: null } : undefined));
        return;
      case 'awaiting_approval': {
        const req = await this.requests.get(t.requestId);
        if (req && canAutoApprove(req, t.base, this.cfg.deploy.prodBranches)) {
          try {
            await this.tasks.approveTask(e.runId, 'auto-approved: low risk');
            await this.ctx.runs.addAction(e.runId, { type: 'auto_approve', at: new Date(), ok: true, detail: 'low risk' });
            return;
          } catch (err) {
            this.ctx.log.warn({ err: (err as Error).message }, 'auto-approve failed; waiting for the human');
          }
        }
        this.alert('agent_plan_ready', `${e.runId}:agent_plan_ready`, title, url);
        break;
      }
      case 'failed': this.alert('agent_failed', `${e.runId}:agent_failed`, title, url, t.error); break;
      case 'ready': this.alert('agent_ready', `${e.runId}:agent_ready`, title, url); break;
      case 'pr_opened':
        this.alert('agent_pr_opened', `${e.runId}:agent_pr_opened`, title, url, t.prUrl);
        if (t.prUrl) {
          const prUrl = this.ctx.mask(t.prUrl).text;
          await this.syncActivity(t.source, a => ({ notes: appendPrNote(a.notes, prUrl) }));
        }
        break;
      default: break;
    }
    if (e.phase !== 'implementing' && e.phase !== 'verifying') this.kick();
  }

  /** Updates the activity behind a request. Never moves it to "done". */
  private async syncActivity(source: PhaseEvent['task']['source'], change: (a: Activity) => Partial<Activity> | undefined): Promise<void> {
    if (source?.kind !== 'activity') return;
    try {
      const a = await this.activities.get(source.id);
      if (!a) return;
      const set = change(a);
      if (set && set.status !== 'done') await this.activities.update(source.id, { ...set, updatedAt: new Date() });
    } catch (e) {
      this.ctx.log.warn({ err: (e as Error).message }, 'activity sync failed');
    }
  }

  private alert(kind: AlertKind, tag: string, title: string, url: string, detail?: string): void {
    const text = agentAlertText(kind, title, this.cfg.contentLang, detail ? this.ctx.mask(detail).text.slice(0, 200) : undefined);
    void this.hub.send(makeAlert({ kind, ...text, tag, url })).catch(() => this.ctx.log.warn('agent alert delivery failed'));
  }
}
