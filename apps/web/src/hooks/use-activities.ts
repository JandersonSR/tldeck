// Daily activities (post-its) for the week, and the reminders the server sends for them.
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { k, t } from '@/lib/i18n';

export const ACTIVITY_STATUSES = ['todo', 'doing', 'done'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_COLORS = ['yellow', 'pink', 'blue', 'green', 'purple', 'orange'] as const;
export type ActivityColor = (typeof ACTIVITY_COLORS)[number];

export interface Activity {
  _id: string; title: string; notes?: string; date: string; startTime?: string | null; durationHours?: number | null;
  priority: boolean; status: ActivityStatus; color: ActivityColor;
  startedAt?: string | null; doneAt?: string | null; deadline: string | null; overdue: boolean;
  lastNotifiedAt?: string; createdAt: string; updatedAt: string;
}
export interface ActivityInput {
  title?: string; notes?: string; date?: string; startTime?: string | null; durationHours?: number | null;
  priority?: boolean; status?: ActivityStatus; color?: ActivityColor;
}
export interface ActivitiesResponse {
  configured: boolean; today: string; from: string; to: string; items: Activity[];
  rules: { dayBefore: number[]; dueFrom: number; dueTo: number }; ntfy: boolean;
}
export type AlertKind = 'day_before' | 'due' | 'overdue' | 'deadline';
export interface ActivityAlert { id: string; activityId: string; title: string; date: string; startTime?: string; kind: AlertKind; at: string }

export const useActivities = (ref: string | undefined) =>
  useQuery({
    queryKey: ['activities', ref ?? 'now'],
    queryFn: () => api.get<ActivitiesResponse>(`/api/activities${ref ? `?ref=${ref}` : ''}`),
    refetchInterval: 60_000,
  });

export function useSaveActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ActivityInput }): Promise<unknown> =>
      id ? api.patch<Activity>(`/api/activities/${id}`, body) : api.post<{ id: string }>('/api/activities', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['activities'] }),
    onError: (e: Error) => toast.error(t('Could not save'), { description: e.message }),
  });
}

export function useDeleteActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/api/activities/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['activities'] }); toast.success(t('Activity deleted')); },
    onError: (e: Error) => toast.error(t('Failed'), { description: e.message }),
  });
}

const ALERT_TITLE: Record<AlertKind, string> = {
  day_before: k('Tomorrow: {title}'), due: k('Today: {title}'), overdue: k('Overdue: {title}'), deadline: k('Deadline reached: {title}'),
};
export const alertTitle = (a: Pick<ActivityAlert, 'kind' | 'title'>) => t(ALERT_TITLE[a.kind], { title: a.title });

const SEEN_KEY = 'ab3.activityAlertsSeen';
const MAX_BACKLOG = 2 * 3_600_000;

/**
 * Polls the reminders the server sent and shows each one once: an in-app toast and,
 * with notifications on (Settings) and permission granted, a desktop notification.
 */
export function useActivityAlerts(notify: boolean): void {
  const qc = useQueryClient();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  useEffect(() => {
    let since = Date.now() - MAX_BACKLOG;
    try { since = Math.max(since, Number(localStorage.getItem(SEEN_KEY)) || 0); } catch { /* sem storage */ }
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.get<{ now: number; items: ActivityAlert[] }>(`/api/activities/alerts?since=${since}`);
        if (stop) return;
        for (const a of r.items) {
          const title = alertTitle(a);
          toast.warning(title, { description: t('Mark it as done to stop the reminders.'), duration: 15_000 });
          if (notifyRef.current && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body: t('Mark it as done to stop the reminders.'), tag: a.id });
          }
        }
        if (r.items.length) void qc.invalidateQueries({ queryKey: ['activities'] });
        since = r.items.reduce((m, a) => Math.max(m, Date.parse(a.at)), since);
        try { localStorage.setItem(SEEN_KEY, String(since)); } catch { /* sem storage */ }
      } catch { /* servidor fora: tenta de novo no próximo ciclo */ }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 30_000);
    return () => { stop = true; window.clearInterval(id); };
  }, [qc]);
}
