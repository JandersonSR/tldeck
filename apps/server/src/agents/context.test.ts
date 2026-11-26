import { describe, expect, it, vi } from 'vitest';
import { AgentContext } from './context.js';

const make = () => {
  const log = { warn: vi.fn() };
  const ctx = new AgentContext({} as never, { collection: () => ({}) } as never, undefined, {} as never, s => ({ text: s, total: 0 }) as never, log as never);
  return { ctx, log };
};
const task = { phase: 'awaiting_approval', issueTitle: 't', repo: 'a/b', repoPath: '/r', worktree: '/w', branch: 'agent/1', base: 'origin/main' } as never;

describe('phase events', () => {
  it('notifies listeners, supports unsubscribe, and a failing listener does not break the others', async () => {
    const { ctx, log } = make();
    const seen: string[] = [];
    ctx.onPhase(() => { throw new Error('sync boom'); });
    ctx.onPhase(async () => { throw new Error('async boom'); });
    const off = ctx.onPhase(e => { seen.push(`${e.runId}:${e.phase}`); });
    ctx.phaseChanged('r1', 'awaiting_approval', task);
    off();
    ctx.phaseChanged('r2', 'ready', task);
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual(['r1:awaiting_approval']);
    expect(log.warn).toHaveBeenCalledTimes(4);
  });
});
