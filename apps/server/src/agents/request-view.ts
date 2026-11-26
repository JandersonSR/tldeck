// What the screen sees of an agent request: the request plus the state of its run (join with deck_runs).
import { OPEN_STATUSES, type AgentRequest, type RequestsRepo, type RequestStatus } from './requests-repo.js';
import type { RunsRepo, TaskPhase } from './runs-repo.js';

export interface RunBrief { id: string; phase: TaskPhase | null; status: string; prUrl?: string | undefined }
export type RequestView = Omit<AgentRequest, '_id'> & { _id: string; run: RunBrief | null };
export interface ActivityAgent { requestId: string; status: RequestStatus; error?: string | undefined; phase?: TaskPhase | undefined; runId?: string | undefined; prUrl?: string | undefined }

/** Task phases that still hold the item (the run is in progress or waiting for the human). */
export const ACTIVE_PHASES: TaskPhase[] = ['planning', 'awaiting_approval', 'implementing', 'verifying', 'ready'];

/** A request is "active" while it waits, is triaged/queued, or its run has not reached a terminal phase. */
export function isActiveRequest(status: RequestStatus, phase: TaskPhase | null | undefined): boolean {
  if ((OPEN_STATUSES as RequestStatus[]).includes(status)) return true;
  return status === 'dispatched' && !!phase && ACTIVE_PHASES.includes(phase);
}

export class RequestViews {
  constructor(private readonly requests: RequestsRepo, private readonly runs: RunsRepo) {}

  private async brief(runId: string | undefined): Promise<RunBrief | null> {
    if (!runId) return null;
    try {
      const r = await this.runs.get(runId);
      return r ? { id: runId, phase: r.task?.phase ?? null, status: r.status, ...(r.task?.prUrl ? { prUrl: r.task.prUrl } : {}) } : null;
    } catch { return null; }
  }

  private async view(r: AgentRequest & { _id: unknown }): Promise<RequestView> {
    return { ...r, _id: String(r._id), run: await this.brief(r.runId) };
  }

  /** active=true: only the ones still in play; otherwise the most recent. */
  async list(active: boolean): Promise<RequestView[]> {
    const rows = await this.requests.recent(active ? 300 : 100);
    const views = await Promise.all(rows.map(r => this.view(r)));
    return active ? views.filter(v => isActiveRequest(v.status, v.run?.phase)) : views;
  }

  /** Latest request of each activity, as the activities list shows it. */
  async forActivities(ids: string[]): Promise<Map<string, ActivityAgent>> {
    const out = new Map<string, ActivityAgent>();
    if (!ids.length) return out;
    const rows = await this.requests.latestFor(ids.map(id => `activity:${id}`));
    for (const r of rows) { // newest first: the first one seen per activity wins
      const id = r.sourceKey.slice('activity:'.length);
      if (out.has(id)) continue;
      const run = await this.brief(r.runId);
      out.set(id, {
        requestId: String(r._id), status: r.status, ...(r.error ? { error: r.error } : {}),
        ...(run?.phase ? { phase: run.phase } : {}), ...(run ? { runId: run.id } : {}), ...(run?.prUrl ? { prUrl: run.prUrl } : {}),
      });
    }
    return out;
  }
}
