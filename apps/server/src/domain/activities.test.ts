import { describe, expect, it } from 'vitest';
import { addDays, deadlineOf, dueAlert, isOverdue, localInstant, parseNotifyRules, weekRange, type Activity } from './activities.js';

const TZ = -180; // BRT
const at = (day: string, time: string) => localInstant(day, time, TZ);
const act = (over: Partial<Activity> = {}): Activity => ({
  title: 'Revisar PR', date: '2026-11-27', priority: true, status: 'todo', color: 'yellow', notified: [],
  createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

describe('dates', () => {
  it('week from Monday to Sunday', () => {
    expect(weekRange('2026-11-26')).toEqual(['2026-11-23', '2026-11-29']); // Thursday
    expect(weekRange('2026-11-29')).toEqual(['2026-11-23', '2026-11-29']); // Sunday
    expect(weekRange('2026-11-23')).toEqual(['2026-11-23', '2026-11-29']); // Monday
  });
  it('adds days across months', () => expect(addDays('2026-11-30', 1)).toBe('2026-12-01'));
  it('local instant uses the team time zone', () => expect(new Date(at('2026-11-27', '10:00')).toISOString()).toBe('2026-11-27T13:00:00.000Z'));
});

describe('deadline in hours', () => {
  it('counts from the start time', () => {
    expect(deadlineOf(act({ startTime: '09:00', durationHours: 4 }), TZ)).toBe(at('2026-11-27', '13:00'));
  });
  it('without a start time, counts from when it moved to doing', () => {
    const startedAt = new Date(at('2026-11-27', '14:30'));
    expect(deadlineOf(act({ durationHours: 2, startedAt }), TZ)).toBe(at('2026-11-27', '16:30'));
    expect(deadlineOf(act({ durationHours: 2 }), TZ)).toBeNull();
  });
});

describe('dueAlert', () => {
  it('two reminders the day before (9h and 15h)', () => {
    expect(dueAlert(act(), at('2026-11-26', '08:59'), TZ)).toBeNull();
    const first = dueAlert(act(), at('2026-11-26', '09:05'), TZ);
    expect(first).toEqual({ slot: 'pre:2026-11-27:9', kind: 'day_before' });
    expect(dueAlert(act({ notified: [first!.slot] }), at('2026-11-26', '12:00'), TZ)).toBeNull();
    expect(dueAlert(act({ notified: [first!.slot] }), at('2026-11-26', '15:00'), TZ)).toEqual({ slot: 'pre:2026-11-27:15', kind: 'day_before' });
  });

  it('server off in the morning: only the latest missed reminder', () => {
    expect(dueAlert(act(), at('2026-11-26', '16:00'), TZ)).toEqual({ slot: 'pre:2026-11-27:15', kind: 'day_before' });
  });

  it('every hour on the date, inside the window, until done', () => {
    expect(dueAlert(act(), at('2026-11-27', '07:30'), TZ)).toBeNull();
    expect(dueAlert(act(), at('2026-11-27', '08:00'), TZ)).toEqual({ slot: 'due:2026-11-27T08', kind: 'due' });
    expect(dueAlert(act({ notified: ['due:2026-11-27T08'] }), at('2026-11-27', '08:59'), TZ)).toBeNull();
    expect(dueAlert(act({ notified: ['due:2026-11-27T08'] }), at('2026-11-27', '09:00'), TZ)).toEqual({ slot: 'due:2026-11-27T09', kind: 'due' });
    expect(dueAlert(act(), at('2026-11-27', '21:00'), TZ)).toBeNull();
    expect(dueAlert(act({ status: 'done' }), at('2026-11-27', '10:00'), TZ)).toBeNull();
  });

  it('keeps reminding after the date while not done', () => {
    expect(dueAlert(act(), at('2026-11-28', '10:10'), TZ)).toEqual({ slot: 'due:2026-11-28T10', kind: 'overdue' });
  });

  it('non-priority items only alert on the hour deadline', () => {
    const a = act({ priority: false, startTime: '09:00', durationHours: 4 });
    expect(dueAlert(a, at('2026-11-27', '10:00'), TZ)).toBeNull();
    const d = dueAlert(a, at('2026-11-27', '13:01'), TZ);
    expect(d?.kind).toBe('deadline');
    expect(dueAlert({ ...a, notified: [d!.slot] }, at('2026-11-27', '14:00'), TZ)).toBeNull();
  });

  it('overdue flag', () => {
    expect(isOverdue(act(), '2026-11-28')).toBe(true);
    expect(isOverdue(act({ status: 'done' }), '2026-11-28')).toBe(false);
    expect(isOverdue(act(), '2026-11-27')).toBe(false);
  });
});

describe('parseNotifyRules', () => {
  it('reads hours and window, falls back on bad input', () => {
    expect(parseNotifyRules('10,16;9-18')).toEqual({ dayBefore: [10, 16], dueFrom: 9, dueTo: 18 });
    expect(parseNotifyRules('x;99-1')).toEqual({ dayBefore: [9, 15], dueFrom: 8, dueTo: 20 });
    expect(parseNotifyRules(undefined)).toEqual({ dayBefore: [9, 15], dueFrom: 8, dueTo: 20 });
  });
});
