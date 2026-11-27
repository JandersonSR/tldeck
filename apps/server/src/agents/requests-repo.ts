// deck_agent_requests: what the human sent to the agents ("Send to agents"). The dispatcher reads ONLY this
// collection: nothing runs unless a request exists. Every text stored here is already masked.
import { ObjectId } from 'mongodb';
import { DocRepo } from '../store/doc-repo.js';
import type { DeckStore } from '../store/store.js';

export type RequestSource = { kind: 'issue'; url: string } | { kind: 'activity'; id: string };
export type RequestStatus = 'triaging' | 'needs_input' | 'queued' | 'dispatched' | 'cancelled' | 'failed';

/** Requests that still hold the item (a new one for the same sourceKey is refused). */
export const OPEN_STATUSES: RequestStatus[] = ['triaging', 'needs_input', 'queued'];

export interface Triage {
  executable: boolean;
  repo: string | null;            // slug or owner/name
  flow: 'review' | 'bug' | 'feature' | 'docs' | 'investigation' | 'cherry-pick' | 'other';
  risk: 'low' | 'medium' | 'high';
  priority: 1 | 2 | 3 | 4;        // 1 = most urgent
  acceptance: string[];
  question: string | null;
}

export interface AgentRequest {
  _id?: ObjectId;
  source: RequestSource;
  sourceKey: string;              // 'gh:owner/repo#n' | 'activity:<id>'
  title: string;                  // masked
  body: string;                   // masked
  userPrompt: string;             // masked
  answers: string[];              // the human's answers to triage questions (masked)
  repoHint?: string | undefined;
  userPriority: boolean;
  dueDate?: string | undefined;   // YYYY-MM-DD (the activity's date)
  autoApprovePlan: boolean;
  status: RequestStatus;
  triage?: Triage | undefined;
  question?: string | undefined;
  error?: string | undefined;
  runId?: string | undefined;
  createdAt: Date;
  updatedAt: Date;
}

/** Queue order: userPriority desc, dueDate asc (missing = last), triage.priority asc, createdAt asc. */
export function compareRequests(
  a: Pick<AgentRequest, 'userPriority' | 'dueDate' | 'triage' | 'createdAt'>,
  b: Pick<AgentRequest, 'userPriority' | 'dueDate' | 'triage' | 'createdAt'>,
): number {
  if (a.userPriority !== b.userPriority) return a.userPriority ? -1 : 1;
  if (a.dueDate !== b.dueDate) {
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  const pa = a.triage?.priority ?? 4;
  const pb = b.triage?.priority ?? 4;
  if (pa !== pb) return pa - pb;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/** sourceKey of a GitHub issue URL ('gh:owner/repo#n'), or of an activity. */
export function sourceKeyOf(source: RequestSource): string {
  if (source.kind === 'activity') return `activity:${source.id}`;
  const m = source.url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/?$/);
  return m ? `gh:${m[1]}/${m[2]}#${m[3]}` : `gh:${source.url}`;
}

export class RequestsRepo {
  readonly docs: DocRepo<AgentRequest>;
  constructor(store: DeckStore) { this.docs = new DocRepo<AgentRequest>(store, 'deck_agent_requests'); }

  create(doc: AgentRequest): Promise<string> { return this.docs.create(doc); }
  get(id: string) { return this.docs.get(id); }
  update(id: string, set: Partial<AgentRequest>) { return this.docs.update(id, { ...set, updatedAt: new Date() }); }

  /** Atomic status change: true only for the one process (or pass) that moved it from `from`. */
  async claim(id: string, from: RequestStatus, set: Partial<AgentRequest>): Promise<boolean> {
    const r = await this.docs.col.findOneAndUpdate({ _id: new ObjectId(id), status: from }, { $set: { ...set, updatedAt: new Date() } }, { returnDocument: 'after' });
    return r !== null;
  }

  byStatus(statuses: RequestStatus[], limit = 500) {
    return this.docs.list({ status: { $in: statuses } } as never, { createdAt: 1 }, limit);
  }

  /** Open request (triaging / needs_input / queued) for the same item. */
  async openFor(sourceKey: string) {
    return (await this.docs.list({ sourceKey, status: { $in: OPEN_STATUSES } } as never, { createdAt: -1 }, 1))[0] ?? null;
  }

  /** Latest request of each item (for the activities list). */
  latestFor(sourceKeys: string[]) {
    return this.docs.list({ sourceKey: { $in: sourceKeys } } as never, { createdAt: -1 }, 2000);
  }

  /** Most recent requests (active + recently ended), newest first. */
  recent(limit = 100) { return this.docs.list({}, { createdAt: -1 }, limit); }
}
