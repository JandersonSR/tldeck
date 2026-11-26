import { describe, expect, it, vi } from 'vitest';
import { localInstant } from '../domain/activities.js';
import { AlertHub, absoluteUrl, deckRoute, goesToPhone, inActiveHours, makeAlert, urgencyOf, type AlertKind } from './alert-hub.js';

const rules = { dueFrom: 8, dueTo: 20 };
const at = (time: string) => localInstant('2026-11-26', time, -180);

function setup(now: { v: number }, extra: { keep?: number } = {}) {
  const os = { available: true, show: vi.fn(async () => true) };
  const ntfy = { configured: true, send: vi.fn(async () => true) };
  const hub = new AlertHub({ rules, tzOffsetMin: -180, channels: { os, ntfy }, now: () => now.v, ...extra });
  return { hub, os, ntfy };
}
const alert = (kind: AlertKind, tag = `x:${kind}`) => makeAlert({ kind, title: 't', body: 'b', tag });

describe('alert urgency and routing', () => {
  it('maps urgency by kind', () => {
    for (const k of ['agent_needs_input', 'agent_plan_ready', 'agent_failed', 'activity_due', 'activity_overdue', 'activity_deadline'] as const) expect(urgencyOf(k)).toBe('high');
    for (const k of ['agent_ready', 'agent_pr_opened', 'activity_day_before'] as const) expect(urgencyOf(k)).toBe('normal');
  });

  it('agent_ready and agent_pr_opened never go to the phone', () => {
    expect(goesToPhone('agent_ready')).toBe(false);
    expect(goesToPhone('agent_pr_opened')).toBe(false);
    expect(goesToPhone('agent_plan_ready')).toBe(true);
  });

  it('builds deck links', () => {
    expect(deckRoute('runs?run=ab')).toBe('/#/runs?run=ab');
    expect(absoluteUrl(9999, '/#/runs')).toBe('http://127.0.0.1:9999/#/runs');
    expect(absoluteUrl(9999, undefined)).toBeUndefined();
  });

  it('tells the active window apart (inclusive, team time zone)', () => {
    expect(inActiveHours(at('08:00'), -180, rules)).toBe(true);
    expect(inActiveHours(at('20:59'), -180, rules)).toBe(true);
    expect(inActiveHours(at('21:00'), -180, rules)).toBe(false);
    expect(inActiveHours(at('07:59'), -180, rules)).toBe(false);
  });
});

describe('AlertHub', () => {
  it('sends to the desktop and to the phone during the day', async () => {
    const { hub, os, ntfy } = setup({ v: at('10:00') });
    await hub.send(alert('agent_plan_ready'));
    expect(os.show).toHaveBeenCalledTimes(1);
    expect(ntfy.send).toHaveBeenCalledTimes(1);
  });

  it('keeps agent_ready and agent_pr_opened off the phone but on the desktop', async () => {
    const { hub, os, ntfy } = setup({ v: at('10:00') });
    await hub.send(alert('agent_ready'));
    await hub.send(alert('agent_pr_opened'));
    expect(os.show).toHaveBeenCalledTimes(2);
    expect(ntfy.send).not.toHaveBeenCalled();
  });

  it('quiet hours: only high urgency reaches os/ntfy; the screen always gets it', async () => {
    const { hub, os, ntfy } = setup({ v: at('23:00') });
    await hub.send(alert('agent_ready'));
    expect(os.show).not.toHaveBeenCalled();
    expect(ntfy.send).not.toHaveBeenCalled();
    await hub.send(alert('agent_failed'));
    expect(os.show).toHaveBeenCalledTimes(1);
    expect(ntfy.send).toHaveBeenCalledTimes(1);
    expect(hub.since(0).map(a => a.kind)).toEqual(['agent_ready', 'agent_failed']);
  });

  it('does not resend the same tag within 10 minutes, then does', async () => {
    const now = { v: at('10:00') };
    const { hub, os } = setup(now);
    expect(await hub.send(alert('agent_failed', 'run1:agent_failed'))).toBe(true);
    now.v += 5 * 60_000;
    expect(await hub.send(alert('agent_failed', 'run1:agent_failed'))).toBe(false);
    expect(await hub.send(alert('agent_failed', 'run2:agent_failed'))).toBe(true);
    now.v += 6 * 60_000;
    expect(await hub.send(alert('agent_failed', 'run1:agent_failed'))).toBe(true);
    expect(os.show).toHaveBeenCalledTimes(3);
    expect(hub.since(0)).toHaveLength(3);
  });

  it('buffer keeps the last N and since() filters by time', async () => {
    const now = { v: at('10:00') };
    const { hub } = setup(now, { keep: 3 });
    for (let i = 0; i < 5; i++) await hub.send(makeAlert({ kind: 'agent_ready', title: String(i), body: '', tag: `t${i}`, at: new Date(now.v + i * 1000).toISOString() }));
    expect(hub.since(0).map(a => a.title)).toEqual(['2', '3', '4']);
    expect(hub.since(now.v + 2500).map(a => a.title)).toEqual(['3', '4']);
  });

  it('a failing channel does not break the others', async () => {
    const now = { v: at('10:00') };
    const os = { available: true, show: vi.fn(async () => { throw new Error('boom'); }) };
    const ntfy = { configured: true, send: vi.fn(async () => true) };
    const hub = new AlertHub({ rules, tzOffsetMin: -180, channels: { os, ntfy }, now: () => now.v });
    await expect(hub.send(alert('agent_failed'))).resolves.toBe(true);
    expect(ntfy.send).toHaveBeenCalled();
  });
});
