// Daily activities (post-its) planned for the week, with reminders:
// - priority items: 2 reminders the day before the date, then one every hour on the date
//   (and after it, while overdue) until the activity is done;
// - any item with a deadline in hours: one reminder when the deadline runs out.
// All "local" times use the team time zone (TEAM_TZ_OFFSET_MIN).

export const ACTIVITY_STATUSES = ['todo', 'doing', 'done'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ACTIVITY_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'] as const;
export type ActivityColor = (typeof ACTIVITY_COLORS)[number];

export interface Activity {
  title: string;
  notes?: string;
  /** Planned date, YYYY-MM-DD (local). */
  date: string;
  /** Optional start time, HH:MM (local). With durationHours it fixes the deadline. */
  startTime?: string;
  /** Must be done within N hours (counted from startTime, or from when it moved to "doing"). */
  durationHours?: number;
  priority: boolean;
  status: ActivityStatus;
  color: ActivityColor;
  startedAt?: Date | null;
  doneAt?: Date | null;
  /** Reminder slots already sent (never sent twice). */
  notified: string[];
  lastNotifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotifyRules {
  /** Local hours of the 2 reminders on the day before the date. */
  dayBefore: number[];
  /** Local hour window [from, to] of the hourly reminders on (and after) the date. */
  dueFrom: number;
  dueTo: number;
}

export const DEFAULT_NOTIFY_RULES: NotifyRules = { dayBefore: [9, 15], dueFrom: 8, dueTo: 20 };

export type AlertKind = 'day_before' | 'due' | 'overdue' | 'deadline';
export interface DueAlert { slot: string; kind: AlertKind }

const pad = (n: number) => String(n).padStart(2, '0');

/** Local day (YYYY-MM-DD), hour and minute of an instant in the team time zone. */
export function localParts(ms: number, tzOffsetMin: number): { day: string; hour: number; minute: number } {
  const d = new Date(ms + tzOffsetMin * 60_000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Instant (ms) of a local day + HH:MM in the team time zone. */
export function localInstant(day: string, time: string, tzOffsetMin: number): number {
  return Date.parse(`${day}T${time}:00Z`) - tzOffsetMin * 60_000;
}

/** Monday..Sunday (YYYY-MM-DD) of the week that holds `day`. */
export function weekRange(day: string): [string, string] {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const start = addDays(day, -((dow + 6) % 7));
  return [start, addDays(start, 6)];
}

/** When the hour deadline runs out (ms), or null when there is none (or it has not started yet). */
export function deadlineOf(a: Pick<Activity, 'date' | 'startTime' | 'durationHours' | 'startedAt'>, tzOffsetMin: number): number | null {
  if (!a.durationHours) return null;
  const start = a.startTime ? localInstant(a.date, a.startTime, tzOffsetMin) : a.startedAt ? new Date(a.startedAt).getTime() : null;
  return start === null ? null : start + a.durationHours * 3_600_000;
}

/** Done activities never alert; an open one whose date already passed is overdue. */
export const isOverdue = (a: Pick<Activity, 'status' | 'date'>, today: string) => a.status !== 'done' && a.date < today;

/**
 * The reminder due now for this activity, or null. Only the latest missed slot is returned
 * (a server that was off at 9h and comes back at 16h sends one reminder, not two).
 */
export function dueAlert(a: Activity, nowMs: number, tzOffsetMin: number, rules: NotifyRules = DEFAULT_NOTIFY_RULES): DueAlert | null {
  if (a.status === 'done') return null;
  const sent = new Set(a.notified ?? []);
  const { day, hour } = localParts(nowMs, tzOffsetMin);

  const deadline = deadlineOf(a, tzOffsetMin);
  if (deadline !== null && nowMs >= deadline) {
    const slot = `deadline:${deadline}`;
    if (!sent.has(slot)) return { slot, kind: 'deadline' };
  }

  if (!a.priority) return null;

  if (day === addDays(a.date, -1)) {
    const reached = rules.dayBefore.filter(h => h <= hour).sort((x, y) => x - y);
    const last = reached[reached.length - 1];
    if (last === undefined) return null;
    const slot = `pre:${a.date}:${last}`;
    return sent.has(slot) ? null : { slot, kind: 'day_before' };
  }

  if (day >= a.date && hour >= rules.dueFrom && hour <= rules.dueTo) {
    const slot = `due:${day}T${pad(hour)}`;
    return sent.has(slot) ? null : { slot, kind: day === a.date ? 'due' : 'overdue' };
  }
  return null;
}

/** Reminder text (ntfy / server side). The screen builds its own text in the interface language. */
export function alertText(a: Pick<Activity, 'title' | 'date' | 'startTime'>, kind: AlertKind, lang: 'en' | 'pt-BR'): { title: string; body: string } {
  const [, m, d] = a.date.split('-');
  const when = `${d}/${m}${a.startTime ? ` ${a.startTime}` : ''}`;
  const pt = lang === 'pt-BR';
  const titles: Record<AlertKind, string> = pt
    ? { day_before: 'Amanhã', due: 'Hoje', overdue: 'Atrasada', deadline: 'Prazo esgotado' }
    : { day_before: 'Tomorrow', due: 'Today', overdue: 'Overdue', deadline: 'Deadline reached' };
  return { title: `${titles[kind]}: ${a.title}`, body: pt ? `Atividade de ${when} ainda não concluída.` : `Activity for ${when} is not done yet.` };
}

/** "9,15;8-20" -> rules (day-before hours ; due window). Invalid parts fall back to the default. */
export function parseNotifyRules(raw: string | undefined): NotifyRules {
  if (!raw) return DEFAULT_NOTIFY_RULES;
  const [pre, win] = raw.split(';').map(s => s.trim());
  const hours = (pre ?? '').split(',').map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23);
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(win ?? '');
  const from = m ? Number(m[1]) : NaN;
  const to = m ? Number(m[2]) : NaN;
  const okWin = Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to <= 23 && from <= to;
  return {
    dayBefore: hours.length ? hours : DEFAULT_NOTIFY_RULES.dayBefore,
    dueFrom: okWin ? from : DEFAULT_NOTIFY_RULES.dueFrom,
    dueTo: okWin ? to : DEFAULT_NOTIFY_RULES.dueTo,
  };
}
