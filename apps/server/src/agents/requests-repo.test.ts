import { describe, expect, it } from 'vitest';
import { compareRequests, sourceKeyOf, type AgentRequest } from './requests-repo.js';

type Q = Pick<AgentRequest, 'userPriority' | 'dueDate' | 'triage' | 'createdAt'>;
const q = (o: Partial<Q> & { p?: 1 | 2 | 3 | 4; at?: number }): Q => ({
  userPriority: o.userPriority ?? false, dueDate: o.dueDate, createdAt: new Date(o.at ?? 1000),
  triage: o.p ? { executable: true, repo: 'x', flow: 'bug', risk: 'low', priority: o.p, acceptance: [], question: null } : undefined,
});
const order = (items: Array<[string, Q]>) => [...items].sort((a, b) => compareRequests(a[1], b[1])).map(i => i[0]);

describe('compareRequests', () => {
  it('user priority first, then earliest due date (none = last), then triage priority, then age', () => {
    expect(order([
      ['old', q({ at: 1 })],
      ['p1', q({ p: 1, at: 5 })],
      ['due-late', q({ dueDate: '2026-12-02', at: 6 })],
      ['due-soon', q({ dueDate: '2026-11-27', at: 7 })],
      ['star', q({ userPriority: true, at: 9 })],
      ['p3', q({ p: 3, at: 2 })],
    ])).toEqual(['star', 'due-soon', 'due-late', 'p1', 'p3', 'old']);
  });

  it('priority star beats an earlier due date; ties fall back to creation time', () => {
    expect(order([['due', q({ dueDate: '2026-11-01', at: 1 })], ['star', q({ userPriority: true, dueDate: '2026-12-31', at: 9 })]])).toEqual(['star', 'due']);
    expect(order([['b', q({ p: 2, at: 20 })], ['a', q({ p: 2, at: 10 })]])).toEqual(['a', 'b']);
  });
});

describe('sourceKeyOf', () => {
  it('builds the key of an issue and of an activity', () => {
    expect(sourceKeyOf({ kind: 'issue', url: 'https://github.com/acme/board/issues/42' })).toBe('gh:acme/board#42');
    expect(sourceKeyOf({ kind: 'activity', id: 'abc' })).toBe('activity:abc');
  });
});
