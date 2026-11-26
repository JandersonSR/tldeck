// Week board of daily activities, like post-its: one column per day (Mon–Sun) and the open ones
// from earlier weeks on top. Priority items get 2 reminders the day before and one every hour on the
// date until done; a deadline in hours ("done within 4 h") alerts when it runs out.
import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock, BellOff, BellRing, Check, ChevronLeft, ChevronRight, Clock, Flame, Loader2, Play, Plus, StickyNote, Trash2, Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState, Pill } from '@/components/common';
import {
  ACTIVITY_COLORS, ACTIVITY_STATUSES, useActivities, useDeleteActivity, useSaveActivity,
  type Activity, type ActivityColor, type ActivityInput, type ActivityStatus,
} from '@/hooks/use-activities';
import { dur, fmtDay } from '@/lib/format';
import { k, locale, t } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const STATUS_LABEL: Record<ActivityStatus, string> = { todo: k('To do'), doing: k('Doing'), done: k('Done') };

const COLOR: Record<ActivityColor, string> = {
  yellow: 'bg-yellow-100 border-yellow-300 dark:bg-yellow-950/50 dark:border-yellow-800',
  pink: 'bg-pink-100 border-pink-300 dark:bg-pink-950/50 dark:border-pink-800',
  blue: 'bg-sky-100 border-sky-300 dark:bg-sky-950/50 dark:border-sky-800',
  green: 'bg-emerald-100 border-emerald-300 dark:bg-emerald-950/50 dark:border-emerald-800',
  purple: 'bg-violet-100 border-violet-300 dark:bg-violet-950/50 dark:border-violet-800',
  orange: 'bg-orange-100 border-orange-300 dark:bg-orange-950/50 dark:border-orange-800',
};
const SWATCH: Record<ActivityColor, string> = {
  yellow: 'bg-yellow-300', pink: 'bg-pink-300', blue: 'bg-sky-300', green: 'bg-emerald-300', purple: 'bg-violet-300', orange: 'bg-orange-300',
};

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString(locale(), { weekday: 'short', timeZone: 'UTC' });

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return <div className={cn('space-y-1', className)}><Label className="text-xs text-muted-foreground">{t(label)}</Label>{children}</div>;
}

/** "2 h 10 min left" / "deadline reached", recomputed every minute by the parent refetch. */
function DeadlineInfo({ a }: { a: Activity }) {
  if (!a.durationHours) return null;
  if (!a.deadline) {
    return <span className="flex items-center gap-1"><Clock className="size-3" /> {t('{h} h (starts when you begin)', { h: a.durationHours })}</span>;
  }
  const left = Date.parse(a.deadline) - Date.now();
  if (a.status === 'done') return <span className="flex items-center gap-1"><Clock className="size-3" /> {t('{h} h', { h: a.durationHours })}</span>;
  return left > 0
    ? <span className="flex items-center gap-1"><AlarmClock className="size-3" /> {t('{time} left', { time: dur(left) })}</span>
    : <span className="flex items-center gap-1 font-medium text-danger"><AlarmClock className="size-3" /> {t('Deadline reached')}</span>;
}

function PostIt({ a, onEdit }: { a: Activity; onEdit: () => void }) {
  const save = useSaveActivity();
  const set = (status: ActivityStatus) => save.mutate({ id: a._id, body: { status } });
  const done = a.status === 'done';
  return (
    <div className={cn('group relative rounded-md border p-2.5 text-xs shadow-sm transition-shadow hover:shadow-md', COLOR[a.color], done && 'opacity-60', a.overdue && !done && 'ring-2 ring-danger/60')}>
      <button type="button" onClick={onEdit} className="block w-full text-left outline-none focus-visible:underline" aria-label={t('Edit {title}', { title: a.title })}>
        <div className="flex items-start gap-1.5">
          {a.priority && <Flame className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label={t('Priority')} />}
          <span className={cn('font-medium leading-snug text-foreground', done && 'line-through')}>{a.title}</span>
        </div>
        {a.notes && <p className="mt-1 line-clamp-3 whitespace-pre-line text-muted-foreground">{a.notes}</p>}
      </button>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {a.startTime && <span className="tabular-nums">{a.startTime}</span>}
        <DeadlineInfo a={a} />
        {a.overdue && !done && !a.durationHours && <span className="font-medium text-danger">{t('Overdue|item')}</span>}
      </div>
      <div className="mt-2 flex items-center gap-1">
        {a.status === 'todo' && (
          <Button size="xs" variant="ghost" className="h-6 px-1.5" disabled={save.isPending} onClick={() => set('doing')}><Play /> {t('Start')}</Button>
        )}
        {a.status === 'doing' && <Pill tone="info">{t('Doing')}</Pill>}
        {!done
          ? <Button size="xs" variant="ghost" className="ml-auto h-6 px-1.5" disabled={save.isPending} onClick={() => set('done')}><Check /> {t('Done')}</Button>
          : <Button size="xs" variant="ghost" className="ml-auto h-6 px-1.5" disabled={save.isPending} onClick={() => set('todo')}><Undo2 /> {t('Reopen')}</Button>}
      </div>
    </div>
  );
}

function QuickAdd({ date }: { date: string }) {
  const save = useSaveActivity();
  const [title, setTitle] = useState('');
  return (
    <form onSubmit={e => {
      e.preventDefault();
      if (!title.trim()) return;
      save.mutate({ body: { title: title.trim(), date } }, { onSuccess: () => setTitle('') });
    }}>
      <Input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('+ Add (Enter)')} aria-label={t('New activity on {day}', { day: fmtDay(date) })}
        className="h-7 border-dashed bg-transparent text-xs shadow-none" disabled={save.isPending} />
    </form>
  );
}

const EMPTY: ActivityInput = { title: '', notes: '', date: '', startTime: null, durationHours: null, priority: false, status: 'todo', color: 'yellow' };

function ActivityDialog({ activity, date, open, onOpenChange }: { activity: Activity | null; date: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const save = useSaveActivity();
  const del = useDeleteActivity();
  const [d, setD] = useState<ActivityInput>(EMPTY);
  useEffect(() => {
    if (!open) return;
    setD(activity ? {
      title: activity.title, notes: activity.notes ?? '', date: activity.date, startTime: activity.startTime ?? null,
      durationHours: activity.durationHours ?? null, priority: activity.priority, status: activity.status, color: activity.color,
    } : { ...EMPTY, date });
  }, [open, activity, date]);
  const up = (p: ActivityInput) => setD(x => ({ ...x, ...p }));
  const valid = !!d.title?.trim() && !!d.date;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(activity ? 'Edit activity' : 'New activity')}</DialogTitle>
          <DialogDescription>{t('Priority: 2 reminders the day before and one every hour on the date until it is done.')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={k('Title')} className="sm:col-span-3">
            <Input value={d.title ?? ''} onChange={e => up({ title: e.target.value })} maxLength={200} autoFocus />
          </Field>
          <Field label={k('Date')}><Input type="date" value={d.date ?? ''} onChange={e => up({ date: e.target.value })} /></Field>
          <Field label={k('Start time (optional)')}>
            <Input type="time" value={d.startTime ?? ''} onChange={e => up({ startTime: e.target.value || null })} />
          </Field>
          <Field label={k('Deadline in hours (optional)')}>
            <Input type="number" min={0.5} max={240} step={0.5} value={d.durationHours ?? ''} placeholder="4"
              onChange={e => up({ durationHours: e.target.value ? Number(e.target.value) : null })} />
          </Field>
          <Field label={k('Status')}>
            <Select value={d.status} onValueChange={v => up({ status: v as ActivityStatus })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{ACTIVITY_STATUSES.map(s => <SelectItem key={s} value={s}>{t(STATUS_LABEL[s])}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label={k('Color')}>
            <div className="flex h-9 items-center gap-1.5">
              {ACTIVITY_COLORS.map(c => (
                <button key={c} type="button" onClick={() => up({ color: c })} aria-label={c} aria-pressed={d.color === c}
                  className={cn('size-6 rounded-full border-2 border-transparent', SWATCH[c], d.color === c && 'border-foreground')} />
              ))}
            </div>
          </Field>
          <Field label={k('Priority')}>
            <div className="flex h-9 items-center gap-2">
              <Switch checked={!!d.priority} onCheckedChange={v => up({ priority: v })} aria-label={t('Priority')} />
              <span className="text-xs text-muted-foreground">{t(d.priority ? 'with reminders' : 'no reminders')}</span>
            </div>
          </Field>
          <Field label={k('Notes')} className="sm:col-span-3">
            <Textarea value={d.notes ?? ''} onChange={e => up({ notes: e.target.value })} rows={3} maxLength={2000} />
          </Field>
          <p className="text-[11px] text-muted-foreground sm:col-span-3">
            {t('Deadline in hours: counted from the start time, or from when you click Start. It alerts when it runs out.')}
          </p>
        </div>
        <DialogFooter className="sm:justify-between">
          {activity ? <Button variant="ghost" className="text-danger" onClick={() => del.mutate(activity._id, { onSuccess: () => onOpenChange(false) })}><Trash2 /> {t('Delete')}</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('Cancel')}</Button>
            <Button disabled={!valid || save.isPending} onClick={() => save.mutate(
              { ...(activity ? { id: activity._id } : {}), body: { ...d, title: d.title?.trim(), notes: d.notes?.trim() ?? '' } },
              { onSuccess: () => onOpenChange(false) },
            )}>
              {save.isPending && <Loader2 className="animate-spin" />} {t('Save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ActivitiesView({ notify, setNotify }: { notify: boolean; setNotify: (on: boolean) => void }) {
  const [ref, setRef] = useState<string | undefined>(undefined);
  const q = useActivities(ref);
  const [editing, setEditing] = useState<Activity | null | undefined>(undefined);
  const [newDate, setNewDate] = useState('');
  const data = q.data;
  const days = useMemo(() => (data ? Array.from({ length: 7 }, (_, i) => addDays(data.from, i)) : []), [data]);
  const byDay = useMemo(() => {
    const m = new Map<string, Activity[]>();
    for (const a of data?.items ?? []) if (data && a.date >= data.from) m.set(a.date, [...(m.get(a.date) ?? []), a]);
    return m;
  }, [data]);
  const carried = useMemo(() => (data?.items ?? []).filter(a => data && a.date < data.from), [data]);
  const permission = 'Notification' in window ? Notification.permission : 'denied';
  const desktopOn = notify && permission === 'granted';

  const enableNotify = async () => {
    if ('Notification' in window && Notification.permission !== 'granted') {
      if ((await Notification.requestPermission()) !== 'granted') return;
    }
    setNotify(true);
  };
  const openNew = (date: string) => { setNewDate(date); setEditing(null); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon-sm" variant="outline" aria-label={t('Previous week')} onClick={() => data && setRef(addDays(data.from, -7))}><ChevronLeft /></Button>
        <Button size="sm" variant="outline" onClick={() => setRef(undefined)} disabled={!ref}>{t('This week')}</Button>
        <Button size="icon-sm" variant="outline" aria-label={t('Next week')} onClick={() => data && setRef(addDays(data.from, 7))}><ChevronRight /></Button>
        {data && <span className="text-sm font-medium tabular-nums">{fmtDay(data.from)} – {fmtDay(data.to, true)}</span>}
        <div className="ml-auto flex items-center gap-2">
          {desktopOn
            ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><BellRing className="size-3.5" /> {t('Desktop reminders on')}{data?.ntfy && ' · ntfy'}</span>
            : <Button size="sm" variant="outline" onClick={() => void enableNotify()}><BellOff /> {t('Turn on desktop reminders')}</Button>}
          <Button size="sm" onClick={() => openNew(data?.today ?? '')}><Plus /> {t('New activity')}</Button>
        </div>
      </div>

      {data && !data.configured && (
        <EmptyState icon={StickyNote} title={t('Storage not configured')} description={t('Activities need the deck storage (SQLite or MongoDB).')} />
      )}

      {carried.length > 0 && (
        <section className="rounded-xl border border-danger/30 bg-danger-soft/40 p-3">
          <h2 className="mb-2 text-xs font-semibold text-danger">{t('Still open from earlier weeks')} · {carried.length}</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
            {carried.map(a => <PostIt key={a._id} a={a} onEdit={() => setEditing(a)} />)}
          </div>
        </section>
      )}

      {q.isLoading ? (
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-48" />)}</div>
      ) : data?.configured && (
        <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-7">
          {days.map(day => {
            const list = byDay.get(day) ?? [];
            const open = list.filter(a => a.status !== 'done').length;
            const isToday = day === data.today;
            return (
              <section key={day} className={cn('flex min-h-48 flex-col gap-2 rounded-xl border bg-muted/20 p-2', isToday && 'border-primary/60 bg-primary/5 ring-1 ring-primary/30')}>
                <header className="flex items-center gap-1.5 px-0.5">
                  <span className={cn('text-xs font-semibold capitalize', isToday && 'text-primary')}>{weekday(day)}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{fmtDay(day)}</span>
                  {isToday && <Pill tone="info">{t('today')}</Pill>}
                  {open > 0 && <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{open}</span>}
                  <Button size="icon-xs" variant="ghost" className={cn(open === 0 && 'ml-auto')} aria-label={t('New activity on {day}', { day: fmtDay(day) })} onClick={() => openNew(day)}><Plus /></Button>
                </header>
                {list.map(a => <PostIt key={a._id} a={a} onEdit={() => setEditing(a)} />)}
                <QuickAdd date={day} />
              </section>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-muted-foreground">
        <Flame className="mr-1 inline size-3 text-danger" />
        {t('Priority reminders: the day before at {pre}, and every hour from {from}h to {to}h on the date until done.', {
          pre: (data?.rules.dayBefore ?? [9, 15]).map(h => `${h}h`).join(' / '), from: data?.rules.dueFrom ?? 8, to: data?.rules.dueTo ?? 20,
        })}
      </p>

      <ActivityDialog activity={editing ?? null} date={newDate} open={editing !== undefined} onOpenChange={o => { if (!o) setEditing(undefined); }} />
    </div>
  );
}
